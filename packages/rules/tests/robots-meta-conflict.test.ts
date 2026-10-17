// pub#556: crawl/robots-meta-conflict reports a page blocked by robots.txt
// that also carries noindex, from the meta tag or the X-Robots-Tag header,
// with its URL listed. It and crawl/indexability-conflicts decide "blocked by
// robots.txt" the same way: the shared isRobotsTxtDisallowed, with Allow,
// Disallow, longest-match and wildcards.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";
import { parseRobotsTxt } from "@squirrelscan/utils/robots-txt";

import { indexabilityConflicts } from "../src/crawl/indexability-conflicts";
import { robotsMetaConflictRule } from "../src/crawl/robots-meta-conflict";
import type { ParsedPage, RuleContext } from "../src/types";

const BASE = "https://example.com";
const ROBOTS = parseRobotsTxt(
  "User-agent: *\nDisallow: /blocked-\nDisallow: /dir/\nAllow: /dir/ok\nDisallow: /*.php\n",
  `${BASE}/robots.txt`,
);

const html = (meta = "") =>
  `<!doctype html><html lang="en"><head><title>t</title>${meta}</head><body><h1>t</h1></body></html>`;
const NOINDEX_META = '<meta name="robots" content="noindex">';

function page(path: string, opts: { meta?: string; header?: string } = {}) {
  const url = `${BASE}${path}`;
  return {
    url,
    statusCode: 200,
    headers: opts.header ? { "x-robots-tag": opts.header } : {},
    parsed: parsePage(html(opts.meta), url) as ParsedPage,
  };
}

function ctx(pages: ReturnType<typeof page>[]): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, pages, robotsTxt: ROBOTS, sitemaps: null },
    options: {},
  } as unknown as RuleContext;
}

async function redundant(pages: ReturnType<typeof page>[]): Promise<CheckResult | undefined> {
  const { checks } = await Promise.resolve(robotsMetaConflictRule.run(ctx(pages)));
  return (checks as CheckResult[]).find((c) => c.name === "redundant-noindex");
}

describe("crawl/robots-meta-conflict (pub#556)", () => {
  test("a blocked page with header-only noindex is reported, with its URL", async () => {
    const row = await redundant([page("/blocked-header", { header: "noindex" })]);
    expect(row?.status).toBe("info");
    expect(row?.pages).toEqual([`${BASE}/blocked-header`]);
  });

  test("a blocked page with meta noindex is reported (existing behaviour)", async () => {
    const row = await redundant([page("/blocked-meta", { meta: NOINDEX_META })]);
    expect(row?.pages).toEqual([`${BASE}/blocked-meta`]);
  });

  test("an allowed page with noindex, meta or header, is not reported", async () => {
    expect(await redundant([page("/open", { meta: NOINDEX_META }), page("/open-h", { header: "noindex" })])).toBeUndefined();
  });

  test("a URL a longer Allow wins for is not blocked, and a wildcard Disallow is", async () => {
    const row = await redundant([
      page("/dir/ok", { meta: NOINDEX_META }),
      page("/x.php", { meta: NOINDEX_META }),
    ]);
    expect(row?.pages).toEqual([`${BASE}/x.php`]);
  });

  test("a blocked page that could not be parsed is not counted as noindex", async () => {
    const unparsed = { url: `${BASE}/blocked-x`, statusCode: 200, headers: {}, parsed: null as unknown as ParsedPage };
    const { checks } = await Promise.resolve(robotsMetaConflictRule.run(ctx([unparsed as never])));
    expect((checks as CheckResult[]).find((c) => c.name === "redundant-noindex")).toBeUndefined();
  });

  test("both rules give the same blocked verdict on every URL", async () => {
    const paths = ["/blocked-a", "/dir/ok", "/dir/other", "/x.php", "/open"];
    // robots-meta-conflict lists blocked pages WITH noindex; indexability-
    // conflicts lists blocked pages WITHOUT it. Same pages, both shapes.
    const withNoindex = (await redundant(paths.map((p) => page(p, { meta: NOINDEX_META }))))?.pages ?? [];
    const { checks } = await Promise.resolve(indexabilityConflicts.run(ctx(paths.map((p) => page(p)))));
    const withoutNoindex = (checks as CheckResult[]).find((c) => c.name === "robots-block-without-noindex")?.pages ?? [];
    expect([...withNoindex].sort()).toEqual([...withoutNoindex].sort());
    expect([...withNoindex].sort()).toEqual([`${BASE}/blocked-a`, `${BASE}/dir/other`, `${BASE}/x.php`].sort());
  });
});
