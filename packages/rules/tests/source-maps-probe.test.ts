// perf/source-maps confirms a referenced same-origin map with one bounded
// request when the probe budget allows it (#2333), and reports as before
// when it does not.

import { parsePage } from "@squirrelscan/parser";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import { sourceMapsRule } from "../src/performance/source-maps";
import {
  createProbeBudget,
  type ProbeBudget,
  type ProbeLevel,
} from "../src/probe-budget";

const MAP_BODY = '{"version":3,"sources":["a.ts"],"mappings":""}';
const hits: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let origin: string;
// A second, live origin: an off-origin map pointed here must never be fetched.
const otherHits: string[] = [];
let otherServer: ReturnType<typeof Bun.serve>;
let otherOrigin: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path === "/live.js.map") return new Response(MAP_BODY);
      if (path === "/guarded.js.map") return new Response(`)]}'\n${MAP_BODY}`);
      if (path === "/spa.js.map")
        return new Response("<!doctype html><html></html>", {
          headers: { "content-type": "text/html" },
        });
      if (path === "/denied.js.map") return new Response("no", { status: 403 });
      return new Response("nope", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  otherServer = Bun.serve({
    port: 0,
    fetch(req) {
      otherHits.push(new URL(req.url).pathname);
      return new Response("nope", { status: 404 });
    },
  });
  otherOrigin = `http://127.0.0.1:${otherServer.port}`;
});
afterAll(() => {
  server.stop(true);
  otherServer.stop(true);
});

async function run(
  maps: string[],
  level: ProbeLevel | null,
  pageUrl = `${origin}/`,
  // Pass one budget to several calls to model pages of the same audit.
  budget?: ProbeBudget
): Promise<CheckResult[]> {
  const scripts = maps
    .map((m) => `<script>//# sourceMappingURL=${m}</script>`)
    .join("");
  const html = `<!DOCTYPE html><html><head><title>t</title>${scripts}</head><body>x</body></html>`;
  const ctx = {
    page: { url: pageUrl, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, pageUrl),
    site: { baseUrl: origin, pages: [], robotsTxt: null, sitemaps: null },
    probe:
      budget ??
      (level ? createProbeBudget({ level, budgetMs: 10_000 }) : undefined),
    options: {},
  } as unknown as RuleContext;
  return (await sourceMapsRule.run(ctx)).checks;
}

const ids = (checks: CheckResult[]) =>
  checks
    .filter((c) => c.name === "source-maps-exposed")
    .flatMap((c) => (c.items ?? []).map((i) => i.id));

describe("perf/source-maps: reachability probe (#2333)", () => {
  test("a map that answers 200 is reported, after one request", async () => {
    hits.length = 0;
    const checks = await run(["/live.js.map"], "active");
    expect(ids(checks)).toEqual([`${origin}/live.js.map`]);
    expect(checks[0]?.details?.confirmed).toBe(1);
    expect(hits).toEqual(["/live.js.map"]);
  });

  test("a 404 map is not flagged", async () => {
    const checks = await run(["/gone.js.map"], "active");
    expect(ids(checks)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual(["source-maps"]);
    expect(checks[0]?.status).toBe("pass");
    // The engine reads this to keep a probed pass out of cache replay.
    expect(checks[0]?.details?.unreachable).toBe(1);
  });

  test("a map behind the spec's )]}' guard line is still a map", async () => {
    const checks = await run(["/guarded.js.map"], "active");
    expect(ids(checks)).toEqual([`${origin}/guarded.js.map`]);
    expect(checks[0]?.details?.confirmed).toBe(1);
  });

  test("a 200 that is not a map (single-page app fallback) is not flagged", async () => {
    expect(ids(await run(["/spa.js.map"], "active"))).toEqual([]);
  });

  test("an answer that proves nothing keeps the warning", async () => {
    expect(ids(await run(["/denied.js.map"], "active"))).toEqual([
      `${origin}/denied.js.map`,
    ]);
  });

  test("with no probe budget, or a passive one, nothing is requested and 404 maps are still reported", async () => {
    hits.length = 0;
    for (const level of [null, "passive"] as const) {
      const checks = await run(["/gone.js.map"], level);
      expect(ids(checks)).toEqual([`${origin}/gone.js.map`]);
      expect(checks[0]?.details?.confirmed).toBeUndefined();
    }
    expect(hits).toEqual([]);
  });

  test("data: maps and off-origin maps are never requested", async () => {
    hits.length = 0;
    otherHits.length = 0;
    // The off-origin map lives on a reachable server that answers 404, so a
    // missing origin check would both record a hit and drop the warning.
    const offOrigin = `${otherOrigin}/x.js.map`;
    const checks = await run(
      ["data:application/json;base64,e30=", offOrigin],
      "aggressive"
    );
    expect(ids(checks)).toEqual([offOrigin]);
    expect(otherHits).toEqual([]);
    expect(hits).toEqual([]);
  });

  test("one request per distinct map across the pages of a run", async () => {
    hits.length = 0;
    const budget = createProbeBudget({ level: "active", budgetMs: 10_000 });
    const first = await run(["/live.js.map"], null, `${origin}/a`, budget);
    const second = await run(["/live.js.map"], null, `${origin}/b`, budget);
    // The second page reads the first page's answer instead of asking again.
    expect(hits).toEqual(["/live.js.map"]);
    expect(ids(first)).toEqual([`${origin}/live.js.map`]);
    expect(ids(second)).toEqual([`${origin}/live.js.map`]);
    expect(second[0]?.details?.confirmed).toBe(1);
  });

  test("the per-run cap bounds the requests at 50", async () => {
    hits.length = 0;
    // A literal, not the exported constant, so loosening the cap fails here.
    const many = Array.from({ length: 55 }, (_, i) => `/m${i}.js.map`);
    await run(many, "active");
    expect(hits.length).toBe(50);
  });
});
