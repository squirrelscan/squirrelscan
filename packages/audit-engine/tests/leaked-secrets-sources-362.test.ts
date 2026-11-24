// #362: security/leaked-secrets reads the same-origin source maps and config
// endpoints the fetched scripts reference. The fetch is bounded: at most 10
// requests per audit, one per URL (a redirect is not followed), on the asset
// phase's budget, and a cross-origin URL is never requested.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createFetchBudget } from "../src/fetch-budget";
import { fetchSecretSources } from "../src/secret-sources";

let own: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let ownBase: string;
let otherBase: string;
const ownHits: string[] = [];
const otherHits: string[] = [];

beforeAll(() => {
  other = Bun.serve({
    port: 0,
    fetch(request) {
      otherHits.push(new URL(request.url).pathname);
      return new Response('{"version":3,"sources":[],"sourcesContent":[]}', {
        headers: { "content-type": "application/json" },
      });
    },
  });
  otherBase = `http://127.0.0.1:${other.port}`;
  own = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      ownHits.push(pathname);
      if (pathname === "/redirect.js.map")
        return new Response(null, {
          status: 302,
          headers: { location: `${otherBase}/stolen.js.map` },
        });
      if (pathname.endsWith(".map"))
        return new Response(
          JSON.stringify({
            version: 3,
            sources: ["src/config.ts"],
            sourcesContent: [`export const key = "${pathname}";`],
            mappings: "AAAA",
          }),
          { headers: { "content-type": "application/json" } }
        );
      return new Response(`{"path":"${pathname}"}`, {
        headers: { "content-type": "application/json" },
      });
    },
  });
  ownBase = `http://127.0.0.1:${own.port}`;
});
afterAll(() => {
  own?.stop(true);
  other?.stop(true);
});

const reset = () => {
  ownHits.length = 0;
  otherHits.length = 0;
};

const script = (
  name: string,
  content: string,
  sourceMapHeader?: string
): {
  url: string;
  content: string;
  sourcePages: string[];
  sourceMapHeader?: string;
} => ({
  url: `${ownBase}/static/${name}`,
  content,
  sourcePages: [`${ownBase}/`],
  ...(sourceMapHeader !== undefined ? { sourceMapHeader } : {}),
});

const run = (
  scripts: Parameters<typeof fetchSecretSources>[0],
  options: Parameters<typeof fetchSecretSources>[1] = {}
) =>
  Effect.runPromise(
    fetchSecretSources(scripts, { concurrency: 2, timeoutMs: 5000, ...options })
  );

describe("leaked-secrets source fetch (#362)", () => {
  test("same-origin maps and configs are fetched; cross-origin ones are never requested", async () => {
    reset();
    const { sources } = await run([
      script("a.js", "var a=1;\n//# sourceMappingURL=a.js.map\n"),
      script("b.js", "var b=1;", `${otherBase}/b.js.map`),
      script("c.js", `fetch("/config.json");fetch("${otherBase}/api/config");`),
    ]);
    expect(sources.map((s) => [s.kind, s.url]).sort()).toEqual(
      [
        ["config-endpoint", `${ownBase}/config.json`],
        ["source-map", `${ownBase}/static/a.js.map`],
      ].sort()
    );
    expect(sources.every((s) => s.status === 200 && s.content)).toBe(true);
    expect(sources.find((s) => s.kind === "source-map")?.referencedBy).toBe(
      `${ownBase}/static/a.js`
    );
    expect(otherHits).toEqual([]);
    expect(ownHits.sort()).toEqual(["/config.json", "/static/a.js.map"]);
  });

  test("never more than 10 requests per audit, however many are referenced", async () => {
    reset();
    const scripts = Array.from({ length: 20 }, (_, i) =>
      script(
        `s${i}.js`,
        `fetch("/cfg${i}/config.json");\n//# sourceMappingURL=s${i}.js.map\n`
      )
    );
    const { sources, dropped } = await run(scripts);
    expect(ownHits).toHaveLength(10);
    expect(sources).toHaveLength(10);
    expect(dropped).toBe(30);
    // Both kinds get a share: neither crowds the other out.
    expect(sources.filter((s) => s.kind === "source-map")).toHaveLength(5);
    expect(sources.filter((s) => s.kind === "config-endpoint")).toHaveLength(5);
  });

  test("a redirect is the answer: its target is never requested", async () => {
    reset();
    const { sources } = await run([
      script("r.js", "var r=1;\n//# sourceMappingURL=/redirect.js.map\n"),
    ]);
    expect(ownHits).toEqual(["/redirect.js.map"]);
    expect(otherHits).toEqual([]);
    expect(sources[0]?.status).toBe(302);
    expect(sources[0]?.content).toBeNull();
  });

  test("a spent fetch budget sends nothing", async () => {
    reset();
    let now = 0;
    const budget = createFetchBudget({ totalBudgetMs: 1000, now: () => now });
    now = 5000;
    const { sources } = await run(
      [script("a.js", "var a=1;\n//# sourceMappingURL=a.js.map\n")],
      { budget }
    );
    expect(ownHits).toEqual([]);
    expect(sources[0]?.content).toBeNull();
  });
});
