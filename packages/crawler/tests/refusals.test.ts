// A fetch the site REFUSED is not a fetch it answered. A bot wall that returns
// 403 for /robots.txt, a sitemap, /llms.txt or the Markdown probe has not said
// the file is missing, so each probe notes the refusal and treats the request as
// unanswered. Every assertion here is on what the probes stored or
// recorded, driven against a real origin.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { MAX_REFUSED_FETCHES } from "@squirrelscan/core-contracts";

import { createPhaseBudget } from "../src/deadline";
import { fetchLlmsTxt } from "../src/llms";
import { probeMarkdownResponse } from "../src/markdown";
import { RefusalLog, isRefusal } from "../src/refusals";
import { fetchRobotsEvaluator } from "../src/robots";
import { discoverSitemaps } from "../src/sitemaps";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** An origin that answers every path with `status`, as a bot wall does. */
function serveAll(status: number, headers: Record<string, string> = {}): string {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("blocked", { status, headers }),
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

const WALL_HEADERS = { server: "cloudflare", "cf-mitigated": "challenge" };

function headersOf(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("isRefusal", () => {
  test("401, 403 and the throttling statuses are refusals", () => {
    for (const status of [401, 403, 429, 430]) {
      expect(isRefusal({ status, headers: headersOf({}) })).toBe(true);
    }
  });

  test("a 404 or a bare 5xx is an answer, not a refusal", () => {
    for (const status of [200, 404, 410, 500, 502, 503]) {
      expect(isRefusal({ status, headers: headersOf({}) })).toBe(false);
    }
  });

  test("a 503 is a refusal only when Cloudflare stamps it as a challenge", () => {
    expect(isRefusal({ status: 503, headers: headersOf({ "cf-mitigated": "challenge" }) })).toBe(
      true,
    );
  });
});

describe("RefusalLog", () => {
  test("records the status and names the bot-protection vendor from the headers", () => {
    const log = new RefusalLog();
    const noted = log.note("https://x.test/robots.txt", "robots.txt", {
      status: 403,
      headers: headersOf({ server: "cloudflare" }),
    });

    expect(noted).toBe(true);
    expect(log.list()).toEqual([
      { url: "https://x.test/robots.txt", resource: "robots.txt", status: 403, provider: "Cloudflare" },
    ]);
  });

  test("a refusal from an unrecognised wall carries no vendor", () => {
    const log = new RefusalLog();
    log.note("https://x.test/llms.txt", "llms.txt", { status: 403, headers: headersOf({}) });

    expect(log.list()).toEqual([
      { url: "https://x.test/llms.txt", resource: "llms.txt", status: 403 },
    ]);
  });

  test("an answer is not recorded", () => {
    const log = new RefusalLog();
    expect(log.note("https://x.test/robots.txt", "robots.txt", { status: 404, headers: headersOf({}) })).toBe(
      false,
    );
    expect(log.list()).toEqual([]);
  });

  test("deduplicates by URL and stays bounded", () => {
    const log = new RefusalLog();
    const refused = { status: 403, headers: headersOf({}) };
    log.note("https://x.test/sitemap.xml", "sitemap", refused);
    log.note("https://x.test/sitemap.xml", "sitemap", refused);
    for (let i = 0; i < MAX_REFUSED_FETCHES * 2; i++) {
      log.note(`https://x.test/child-${i}.xml`, "sitemap", refused);
    }

    expect(log.list().filter((r) => r.url.endsWith("/sitemap.xml"))).toHaveLength(1);
    expect(log.list()).toHaveLength(MAX_REFUSED_FETCHES);
  });
});

describe("root probes against a site that refuses every request", () => {
  test("llms.txt: a 403 is no answer, not a missing file", async () => {
    const origin = serveAll(403, WALL_HEADERS);
    const refusals = new RefusalLog();
    const llms = await Effect.runPromise(
      fetchLlmsTxt(origin, "squirrel-test", undefined, createPhaseBudget(10_000, Date.now(), refusals)),
    );

    // null is "nothing learned": no row is stored, so the rule says not checked.
    expect(llms).toBeNull();
    expect(refusals.list().map((r) => [r.resource, r.status, r.provider])).toEqual([
      ["llms.txt", 403, "Cloudflare"],
      ["llms.txt", 403, "Cloudflare"],
    ]);
  });

  test("llms.txt: a 404 is still a missing file (the control)", async () => {
    const origin = serveAll(404);
    const refusals = new RefusalLog();
    const llms = await Effect.runPromise(
      fetchLlmsTxt(origin, "squirrel-test", undefined, createPhaseBudget(10_000, Date.now(), refusals)),
    );

    expect(llms?.llmsTxt.exists).toBe(false);
    expect(refusals.list()).toEqual([]);
  });

  test("markdown: a refused homepage and .md variant are no answer, not 'no Markdown'", async () => {
    const origin = serveAll(403, WALL_HEADERS);
    const refusals = new RefusalLog();
    const markdown = await Effect.runPromise(
      probeMarkdownResponse(origin, "squirrel-test", undefined, createPhaseBudget(10_000, Date.now(), refusals)),
    );

    expect(markdown).toBeNull();
    expect(refusals.list().map((r) => r.resource)).toEqual(["markdown", "markdown"]);
  });

  test("robots.txt: the refusal is recorded and the stored error keeps the status", async () => {
    const origin = serveAll(403, WALL_HEADERS);
    const refusals = new RefusalLog();
    const robots = await Effect.runPromise(
      fetchRobotsEvaluator(origin, "squirrel-test", true, undefined, createPhaseBudget(10_000, Date.now(), refusals)),
    );

    expect(robots.data.exists).toBe(false);
    expect(robots.data.errors).toEqual(["HTTP 403"]);
    expect(refusals.list()).toMatchObject([{ resource: "robots.txt", status: 403, provider: "Cloudflare" }]);
  });

  test("sitemaps: every refused candidate location is recorded", async () => {
    const origin = serveAll(403, WALL_HEADERS);
    const refusals = new RefusalLog();
    const result = await Effect.runPromise(
      discoverSitemaps(origin, null, "squirrel-test", { refusals }),
    );

    expect(result.discovered).toEqual([]);
    const refused = refusals.list();
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((r) => r.resource === "sitemap" && r.status === 403)).toBe(true);
  });

  test("a probe run without a log still treats a refusal as no answer", async () => {
    const origin = serveAll(403);
    const llms = await Effect.runPromise(fetchLlmsTxt(origin, "squirrel-test"));
    expect(llms).toBeNull();
  });
});
