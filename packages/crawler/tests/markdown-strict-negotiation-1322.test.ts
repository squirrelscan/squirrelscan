// The Markdown probe also sends a strict `Accept: text/markdown`, the header a
// Markdown-only agent sends. A site can answer the lenient probe (which ends in
// `*/*`) with 200 HTML while it returns 5xx to the strict one; the probe records
// that status so ax/markdown-response can flag it (repo#1322).

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createPhaseBudget } from "../src/deadline";
import { probeMarkdownResponse } from "../src/markdown";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

type Handler = (req: Request) => Response | Promise<Response>;

function serve(handler: Handler): { origin: string; accepts: string[] } {
  const accepts: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (new URL(req.url).pathname === "/") accepts.push(req.headers.get("accept") ?? "");
      return handler(req);
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, accepts };
}

const isStrict = (req: Request): boolean => req.headers.get("accept") === "text/markdown";
const notFound = (): Response => new Response("nope", { status: 404 });
const html = (): Response => new Response("<html></html>", { headers: { "content-type": "text/html" } });

function home(onHome: Handler): Handler {
  return (req) => (new URL(req.url).pathname === "/" ? onHome(req) : notFound());
}

describe("strict Markdown negotiation probe (repo#1322)", () => {
  test("sends the strict Accept: text/markdown alongside the lenient probe", async () => {
    const { origin, accepts } = serve(home(html));
    await Effect.runPromise(probeMarkdownResponse(origin, "squirrel-test"));
    expect(accepts).toContain("text/markdown");
    expect(accepts).toContain("text/markdown, text/x-markdown, */*");
  });

  test("500 on strict, 200 HTML on lenient → strict status recorded", async () => {
    const { origin } = serve(
      home((req) =>
        isStrict(req)
          ? Response.json({ error: "boom" }, { status: 500 })
          : html(),
      ),
    );
    const r = await Effect.runPromise(probeMarkdownResponse(origin, "squirrel-test"));
    expect(r).not.toBeNull();
    expect(r?.negotiatedStatus).toBe(200);
    expect(r?.negotiatedContentType).toBe("text/html");
    expect(r?.strictNegotiatedStatus).toBe(500);
    expect(r?.strictNegotiatedContentType).toContain("application/json");
    expect(r?.servesMarkdown).toBe(false);
  });

  test("strict 5xx is still a finding when the .md probe got no answer", async () => {
    const { origin } = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/") return isStrict(req) ? new Response("x", { status: 502 }) : html();
      return new Response("x", { status: 503 }); // /index.md: no answer
    });
    const r = await Effect.runPromise(probeMarkdownResponse(origin, "squirrel-test"));
    expect(r?.strictNegotiatedStatus).toBe(502);
  });

  test("absent markdown: strict answered with HTML → no error status, not served", async () => {
    const { origin } = serve(home(html));
    const r = await Effect.runPromise(probeMarkdownResponse(origin, "squirrel-test"));
    expect(r?.servesMarkdown).toBe(false);
    expect(r?.strictNegotiatedStatus).toBe(200);
    expect(r?.negotiatedStatus).toBe(200);
  });

  test("Markdown served only on strict negotiation still counts as served", async () => {
    const { origin } = serve(
      home((req) =>
        isStrict(req) ? new Response("# hi", { headers: { "content-type": "text/markdown" } }) : html(),
      ),
    );
    const r = await Effect.runPromise(probeMarkdownResponse(origin, "squirrel-test"));
    expect(r?.servesMarkdown).toBe(true);
    expect(r?.strictNegotiatedContentType).toBe("text/markdown");
  });

  test("homepage 5xx on every Accept stays unknown, not a negotiation defect (#1760)", async () => {
    const { origin } = serve(() => new Response("x", { status: 500 }));
    expect(await Effect.runPromise(probeMarkdownResponse(origin, "squirrel-test"))).toBeNull();
  });

  // planning's finding on pub#1932: a strict probe with no answer must not read
  // as a clean one. Each of these records "strict unanswered" as its own state.
  for (const [label, status] of [
    ["429 (throttled)", 429],
    ["403 (refused)", 403],
  ] as const) {
    test(`strict ${label} while the lenient probe answered → strict unanswered, not clean`, async () => {
      const { origin } = serve(home((req) => (isStrict(req) ? new Response("no", { status }) : html())));
      const r = await Effect.runPromise(probeMarkdownResponse(origin, "squirrel-test"));
      expect(r).not.toBeNull();
      expect(r?.negotiatedStatus).toBe(200);
      expect(r?.strictNegotiatedStatus).toBeNull();
      expect(r?.strictNegotiationAnswered).toBe(false);
      expect(r?.mdVariantAnswered).toBe(true);
    });
  }

  test("strict timeout (the probe budget's deadline) → strict unanswered, not clean", async () => {
    const { origin } = serve(
      home((req) => {
        if (!isStrict(req)) return html();
        // Never answers inside the budget below.
        return new Promise<Response>((resolve) => setTimeout(() => resolve(html()), 3_000));
      }),
    );
    const r = await Effect.runPromise(
      probeMarkdownResponse(origin, "squirrel-test", undefined, createPhaseBudget(500, Date.now())),
    );
    expect(r?.negotiatedStatus).toBe(200);
    expect(r?.strictNegotiatedStatus).toBeNull();
    expect(r?.strictNegotiationAnswered).toBe(false);
  }, 30_000);

  test("strict 406 Not Acceptable is a healthy answer, not an unanswered probe", async () => {
    const { origin } = serve(home((req) => (isStrict(req) ? new Response("no", { status: 406 }) : html())));
    const r = await Effect.runPromise(probeMarkdownResponse(origin, "squirrel-test"));
    expect(r?.strictNegotiatedStatus).toBe(406);
    expect(r?.strictNegotiationAnswered).toBe(true);
  });

  test("strict 5xx with /index.md unanswered → the .md probe is recorded as unanswered", async () => {
    const { origin } = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/") return isStrict(req) ? new Response("x", { status: 502 }) : html();
      return new Response("x", { status: 503 });
    });
    const r = await Effect.runPromise(probeMarkdownResponse(origin, "squirrel-test"));
    expect(r?.strictNegotiatedStatus).toBe(502);
    expect(r?.strictNegotiationAnswered).toBe(true);
    expect(r?.mdVariantAnswered).toBe(false);
    expect(r?.mdVariantExists).toBe(false);
  });
});
