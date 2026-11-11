// pub#1679: the coverage details of every `broken-links` row count the targets the audit got a refusal
// or a throttle for. Their status exists but says nothing about the page, and the rule skips them
// before they reach `unfetchedTargets`, so `linkTargets - unfetchedTargets` alone over-counts what
// was observed. Nothing else about the check changes.

import { describe, expect, test } from "bun:test";

import { brokenLinksRule } from "../src/links/broken-links";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const BASE = "https://example.com";

interface Page {
  url: string;
  statusCode: number;
  internal?: string[];
}

function ctx(
  pages: Page[],
  site: Partial<Pick<SiteData, "linkTargetStatuses" | "fetchedTargets" | "internalLinkProbe">> = {},
): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      robotsTxt: null,
      sitemaps: null,
      pages: pages.map((p) => ({
        url: p.url,
        statusCode: p.statusCode,
        parsed: {
          links: (p.internal ?? []).map((url) => ({ url, isInternal: true, text: "", rel: null })),
        } as unknown as ParsedPage,
      })),
      ...site,
    },
    options: {},
  } as unknown as RuleContext;
}

function details(c: RuleContext) {
  return brokenLinksRule
    .run(c)
    .checks.filter((check) => check.name === "broken-links")
    .map((check) => ({
    status: check.status,
    details: check.details as Record<string, unknown> | undefined,
  }));
}

const home = (internal: string[]): Page => ({ url: `${BASE}/`, statusCode: 200, internal });

describe("links/broken-links: refusedTargets and rateLimitedTargets (pub#1679)", () => {
  test("a fixture with one 403, one 429 and one 404 reports 1, 1 and the 404 as before", () => {
    const c = ctx([home([`${BASE}/walled`, `${BASE}/slow`, `${BASE}/gone`])], {
      linkTargetStatuses: [
        { url: `${BASE}/walled`, status: 403, error: null },
        { url: `${BASE}/slow`, status: 429, error: null, rateLimited: true },
        { url: `${BASE}/gone`, status: 404, error: null },
      ],
    });
    const rows = details(c);
    const fail = rows.find((r) => r.status === "fail")!;
    expect(fail.details).toMatchObject({
      linkTargets: 3,
      unfetchedTargets: 0,
      refusedTargets: 1,
      rateLimitedTargets: 1,
    });
    // The 404 is still the only finding.
    const items = brokenLinksRule.run(c).checks.find((x) => x.status === "fail")!.items!;
    expect(items.map((i) => i.id)).toEqual([`${BASE}/gone`]);
  });

  test("every broken-links row carries both counts, as whole numbers, 0 when none", () => {
    const pass = details(ctx([home([`${BASE}/ok`]), { url: `${BASE}/ok`, statusCode: 200 }]));
    expect(pass).toHaveLength(1);
    expect(pass[0]!.details).toMatchObject({ refusedTargets: 0, rateLimitedTargets: 0 });
    const mixed = details(
      ctx([home([`${BASE}/walled`, `${BASE}/gone`])], {
        linkTargetStatuses: [
          { url: `${BASE}/walled`, status: 401, error: null },
          { url: `${BASE}/gone`, status: 404, error: null },
        ],
      }),
    );
    for (const row of mixed) {
      expect(Number.isInteger(row.details?.refusedTargets)).toBe(true);
      expect(Number.isInteger(row.details?.rateLimitedTargets)).toBe(true);
    }
  });

  test("a target is counted once however many pages link it, and /a, /a/ and /a#x are one", () => {
    const c = ctx(
      [
        home([`${BASE}/walled`, `${BASE}/walled/`, `${BASE}/walled#x`]),
        { url: `${BASE}/other`, statusCode: 200, internal: [`${BASE}/walled`, `${BASE}/slow`] },
      ],
      {
        linkTargetStatuses: [
          { url: `${BASE}/walled`, status: 403, error: null },
          { url: `${BASE}/slow`, status: 429, error: null, rateLimited: true },
        ],
      },
    );
    const row = details(c)[0]!;
    expect(row.details).toMatchObject({ refusedTargets: 1, rateLimitedTargets: 1, linkTargets: 2 });
  });

  test("a bot-wall challenge and a throttled crawl answer count too", () => {
    const c = ctx([home([`${BASE}/challenge`, `${BASE}/throttled`])], {
      fetchedTargets: [
        { url: `${BASE}/challenge`, status: 503, wafChallenge: true },
        { url: `${BASE}/throttled`, status: 429, rateLimited: true },
      ] as unknown as SiteData["fetchedTargets"],
    });
    expect(details(c)[0]!.details).toMatchObject({ refusedTargets: 1, rateLimitedTargets: 1 });
  });

  test("a rate-limit status that reached the rules as a crawled page counts", () => {
    const c = ctx([home([`${BASE}/crawled-429`]), { url: `${BASE}/crawled-429`, statusCode: 429 }]);
    expect(details(c)[0]!.details).toMatchObject({ rateLimitedTargets: 1, refusedTargets: 0 });
  });

  test("a target that was only left unfetched is in neither count", () => {
    const c = ctx([home([`${BASE}/never`])]);
    const row = details(c).find((r) => r.status === "pass" || r.status === "skipped")!;
    expect(row.details).toMatchObject({
      unfetchedTargets: 1,
      refusedTargets: 0,
      rateLimitedTargets: 0,
    });
  });
});
