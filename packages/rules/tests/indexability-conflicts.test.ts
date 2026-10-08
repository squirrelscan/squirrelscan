// crawl/indexability-conflicts: robots.txt Allow plus noindex is the supported way
// to deindex a page and must not be reported (pub#487). Only a page blocked by
// robots.txt without noindex is reported, at info, with its URL in `pages`.

import { describe, expect, test } from "bun:test";

import type { RobotsTxtData } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { indexabilityConflicts } from "../src/crawl/indexability-conflicts";
import type { ParsedPage, RuleContext } from "../src/types";

const BASE = "http://127.0.0.1:8771";

// The reporter's repro files.
const HOME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title></head><body><h1>Home</h1><a href="/noindex.html">private</a></body></html>`;
const NOINDEX = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Private page</title><meta name="robots" content="noindex"></head><body><h1>Private</h1></body></html>`;

const ALLOW_ALL = {
  exists: true,
  rules: [{ userAgent: "*", rules: [{ type: "allow", path: "/" }] }],
} as unknown as RobotsTxtData;

const DISALLOW_PRIVATE = {
  exists: true,
  rules: [{ userAgent: "*", rules: [{ type: "disallow", path: "/private" }] }],
} as unknown as RobotsTxtData;

function page(path: string, body: string, headers: Record<string, string> = {}) {
  const url = `${BASE}${path}`;
  return { url, statusCode: 200, headers, parsed: parsePage(body, url) as ParsedPage };
}

function ctx(pages: ReturnType<typeof page>[], robotsTxt: RobotsTxtData): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, pages, robotsTxt, sitemaps: null },
    options: {},
  } as unknown as RuleContext;
}

const run = (c: RuleContext) => Promise.resolve(indexabilityConflicts.run(c)).then((r) => r.checks);

describe("crawl/indexability-conflicts", () => {
  test("reporter's repro: Allow plus meta noindex passes", async () => {
    const checks = await run(
      ctx([page("/", HOME), page("/noindex.html", NOINDEX)], ALLOW_ALL),
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([["conflicts", "pass"]]);
  });

  test("X-Robots-Tag noindex on an allowed page passes", async () => {
    const checks = await run(
      ctx([page("/", HOME), page("/hdr.html", HOME, { "x-robots-tag": "noindex" })], ALLOW_ALL),
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([["conflicts", "pass"]]);
  });

  test("Disallow plus noindex is left to robots-meta-conflict (no finding here)", async () => {
    const checks = await run(ctx([page("/private/x", NOINDEX)], DISALLOW_PRIVATE));
    expect(checks.map((c) => [c.name, c.status])).toEqual([["conflicts", "pass"]]);
  });

  test("robots-disallowed indexable page: info finding with pages populated", async () => {
    const checks = await run(
      ctx([page("/", HOME), page("/private/a", HOME), page("/private/b", HOME)], DISALLOW_PRIVATE),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("robots-block-without-noindex");
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.pages).toEqual([`${BASE}/private/a`, `${BASE}/private/b`]);
  });

  test("no warn or fail status is ever produced", async () => {
    const checks = await run(
      ctx([page("/noindex.html", NOINDEX), page("/private/a", HOME)], DISALLOW_PRIVATE),
    );
    expect(checks.every((c) => c.status === "info" || c.status === "pass")).toBe(true);
  });
});
