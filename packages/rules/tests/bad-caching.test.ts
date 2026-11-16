// perf/bad-caching — site-wide weak-caching detection (#109).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { hasJavaScriptDetections } from "@squirrelscan/utils/cdn";

import { buildCollectedPageSignal } from "../src/collected-signals";
import { badCachingRule } from "../src/performance/bad-caching";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

function siteCtx(
  pages: { url: string; headers: Record<string, string>; fetchedAt?: number; headersRecorded?: boolean }[]
): RuleContext {
  const html = "<html><head><title>t</title></head><body></body></html>";
  const sitePages: SiteData["pages"] = pages.map((p) => ({
    url: p.url,
    statusCode: 200,
    parsed: parsePage(html, p.url),
    headers: { "content-type": "text/html", ...p.headers },
    ...(p.fetchedAt !== undefined ? { fetchedAt: p.fetchedAt } : {}),
    ...(p.headersRecorded !== undefined ? { headersRecorded: p.headersRecorded } : {}),
  }));
  return {
    page: {
      url: sitePages[0]?.url ?? "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: sitePages[0]?.parsed ?? ({} as ParsedPage),
    site: {
      baseUrl: "https://example.com",
      pages: sitePages,
      robotsTxt: null,
      sitemaps: null,
    },
    options: {},
  };
}

async function run(rule: Rule, ctx: RuleContext): Promise<CheckResult[]> {
  return (await rule.run(ctx)).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

/**
 * The freshness and compression checks are info either way (pub#633): the
 * per-page rules score them. Whether the site share fell below the threshold
 * is read from the message.
 */
function verdict(checks: CheckResult[], name: "bad-caching-freshness" | "bad-caching-compression") {
  const c = check(checks, name);
  if (!c) return undefined;
  expect(c.status).toBe("info");
  return /no caching policy|send Cache-Control: no-store|served without/.test(c.message) ? "flagged" : "ok";
}

const goodHeaders = {
  "cache-control": "public, max-age=3600",
  etag: '"abc123"',
  "content-encoding": "br",
};

describe("perf/bad-caching", () => {
  test("skips when no HTML pages with headers", async () => {
    const checks = (await run(badCachingRule, siteCtx([])));
    expect(check(checks, "bad-caching")?.status).toBe("skipped");
  });

  test("passes a well-cached, compressed site", async () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: goodHeaders,
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
    expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
    expect(verdict(checks, "bad-caching-compression")).toBe("ok");
  });

  test("flags missing freshness across the site", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { etag: '"x"', "content-encoding": "gzip" }, // no cache-control/expires
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    const freshness = check(checks, "bad-caching-freshness");
    expect(freshness?.status).toBe("info");
    expect(freshness?.pages?.length).toBeGreaterThan(0);
  });

  test("no-store does not count as freshness", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "no-store, max-age=3600",
        etag: '"x"',
        "content-encoding": "gzip",
      },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
  });

  // #2230 — `no-cache` and `s-maxage=0` still mean "no freshness lifetime",
  // which is what the crawler's own parser says and what these two tests were
  // written for. What changed is the verdict: a response that gives a cache
  // nothing to reuse but DOES give it something to revalidate against has a
  // caching policy, and the correct one for a document that must never be
  // served stale. Each pairs with the same header and no validator, which is
  // the case worth reporting: every request is a full transfer.
  test("no-cache with a validator is a revalidation policy, not a missing one", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "no-cache, max-age=3600",
        etag: '"x"',
        "content-encoding": "gzip",
      },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
  });

  test("no-cache with no validator has no caching policy at all", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "no-cache, max-age=3600", "content-encoding": "gzip" },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
  });

  test("s-maxage=0 with a validator is a revalidation policy", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "max-age=3600, s-maxage=0",
        etag: '"x"',
        "content-encoding": "gzip",
      },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
  });

  test("s-maxage=0 with no validator has no caching policy at all", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "max-age=3600, s-maxage=0", "content-encoding": "gzip" },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
  });

  // The shape the issue was filed for: the default a framework or CDN emits
  // for an HTML document, and the one that used to fail 163 of 196 sites.
  test("max-age=0, must-revalidate with a strong ETag passes", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        etag: '"ff27a01f0a15f0ff44c0abfc199a32d1"', // pragma: allowlist secret
        "content-encoding": "br",
      },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
  });

  test("max-age=0, must-revalidate with Last-Modified instead of an ETag passes", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        "last-modified": "Wed, 16 Sep 2026 08:01:44 UTC",
        "content-encoding": "br",
      },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
  });

  test("max-age=0 with neither validator still fails, and says why", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "public, max-age=0, must-revalidate", "content-encoding": "br" },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    const freshness = check(checks, "bad-caching-freshness");
    expect(freshness?.status).toBe("info");
    expect(freshness?.message).toBe(
      "4/4 pages set no caching policy (no freshness lifetime and no validator)"
    );
  });

  test("no-store is never a caching policy, validator or not", async () => {
    // `no-store, no-cache` would satisfy the revalidation arm on its own, so
    // this is the input that proves no-store is still refused: a per-user page
    // that must not be stored anywhere has no policy a cache can use.
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "no-store, no-cache",
        etag: '"x"',
        "content-encoding": "br",
      },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
  });

  test("a validator with no Cache-Control at all is not a declared policy", async () => {
    // The server said nothing about caching; a cache falls back to a heuristic
    // and nothing about the reuse is under the site's control. That is the
    // case the rule was written for and it still reports.
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { etag: '"x"', "content-encoding": "br" },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
  });

  test("a freshness lifetime alone is still a policy", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "public, max-age=600", "content-encoding": "br" },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
  });

  // pub#600: the validators check warns and never fails. A page with no
  // lifetime and no validator already fails freshness for the same header.
  test("missing validators warn, never fail", async () => {
    const none = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "max-age=600", "content-encoding": "br" },
    }));
    const validators = check(await run(badCachingRule, siteCtx(none)), "bad-caching-validators");
    expect(validators?.status).toBe("warn");
    expect(validators?.message).toBe("4/4 pages lack an ETag or Last-Modified validator");

    // 40% with a validator: under the 60% default, still a warning.
    const some = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "max-age=600",
        "content-encoding": "br",
        ...(i < 2 ? { etag: '"x"' } : {}),
      },
    }));
    expect(check(await run(badCachingRule, siteCtx(some)), "bad-caching-validators")?.status).toBe(
      "warn"
    );
  });

  test("max-age=0 with no validator still fails freshness after the validators cap", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "public, max-age=0, must-revalidate", "content-encoding": "br" },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
    expect(check(checks, "bad-caching-validators")?.status).toBe("warn");
  });

  // pub#600: the reporter's theory was that a weak ETag, or one on a zstd
  // body, was dropped. It is not: any non-empty ETag is a validator, and
  // If-None-Match compares weakly, so `W/` still revalidates.
  for (const encoding of [undefined, "gzip", "br", "zstd"]) {
    test(`a weak ETag is a validator under max-age=0, must-revalidate (${encoding ?? "identity"})`, async () => {
      const pages = Array.from({ length: 4 }, (_, i) => ({
        url: `https://example.com/p${i}`,
        headers: {
          "cache-control": "public, max-age=0, must-revalidate",
          etag: 'W/"ad66933fd8e64dd4529f856985df80eb"', // pragma: allowlist secret
          ...(encoding ? { "content-encoding": encoding } : {}),
        },
      }));
      const checks = (await run(badCachingRule, siteCtx(pages)));
      expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
      expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
    });
  }

  test("flags uncompressed compressible responses", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "max-age=600", etag: '"x"' }, // no content-encoding
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-compression")).toBe("flagged");
  });

  // #2243: Expires is parsed and judged against the response Date, else the
  // page's stored fetch time, never the wall clock. The crawl here is years
  // old, so a re-analysis today must still see the lifetime it had then.
  const FETCHED_AT = Date.parse("2020-03-01T12:00:00Z");
  const hourAfterFetch = new Date(FETCHED_AT + 3600 * 1000).toUTCString();
  const hourBeforeFetch = new Date(FETCHED_AT - 3600 * 1000).toUTCString();

  test("Expires header satisfies freshness", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires: hourAfterFetch, "last-modified": "x", "content-encoding": "gzip" },
      fetchedAt: FETCHED_AT,
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
    expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
  });

  test("an old crawl with no Date: Expires ahead of the fetch time is a lifetime", async () => {
    // hourAfterFetch is long past today; the wall clock would call it expired.
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires: hourAfterFetch, "content-encoding": "gzip" },
      fetchedAt: FETCHED_AT,
    }));
    const checks = await run(badCachingRule, siteCtx(pages));
    const freshness = check(checks, "bad-caching-freshness");
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
    expect(freshness?.message).toBe("4/4 pages declare a caching policy");
  });

  test("an old crawl with no Date: Expires before the fetch time is not a lifetime", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires: hourBeforeFetch, "content-encoding": "gzip" },
      fetchedAt: FETCHED_AT,
    }));
    const checks = await run(badCachingRule, siteCtx(pages));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
    expect(check(checks, "bad-caching-freshness")?.details?.pagesWithCachePolicy).toBe(0);
    expect(check(checks, "bad-caching-validators")?.status).toBe("warn");
  });

  test("no Date and no fetch time: Expires is unjudged, neither a lifetime nor no policy", async () => {
    const expiresPages = Array.from({ length: 2 }, (_, i) => ({
      url: `https://example.com/e${i}`,
      headers: { expires: hourAfterFetch, "content-encoding": "gzip" },
    }));
    const only = await run(badCachingRule, siteCtx(expiresPages));
    const onlyFreshness = check(only, "bad-caching-freshness");
    expect(onlyFreshness?.status).toBe("info");
    expect(onlyFreshness?.message).toContain("freshness is unknown");
    expect(onlyFreshness?.message).not.toContain("no caching policy");
    expect(onlyFreshness?.details?.unjudgedExpiresPages).toBe(2);

    // Mixed with judged pages the unjudged ones are left out of the share:
    // two cached pages out of two judged is 100%, not 50%.
    const cached = Array.from({ length: 2 }, (_, i) => ({
      url: `https://example.com/c${i}`,
      headers: goodHeaders,
    }));
    const mixed = await run(badCachingRule, siteCtx([...cached, ...expiresPages]));
    const mixedFreshness = check(mixed, "bad-caching-freshness");
    expect(verdict(mixed, "bad-caching-freshness")).toBe("ok");
    expect(mixedFreshness?.value).toBe("100%");
    expect(mixedFreshness?.details?.unjudgedExpiresPages).toBe(2);

    // Same with no-policy pages present: they are counted, the unjudged are not.
    const bare = Array.from({ length: 2 }, (_, i) => ({
      url: `https://example.com/b${i}`,
      headers: { "content-encoding": "gzip" },
    }));
    const withBare = await run(badCachingRule, siteCtx([...bare, ...expiresPages]));
    const bareFreshness = check(withBare, "bad-caching-freshness");
    expect(verdict(withBare, "bad-caching-freshness")).toBe("flagged");
    expect(bareFreshness?.message).toStartWith("2/2 pages set no caching policy");
    expect(bareFreshness?.pages).toEqual(bare.map((p) => p.url));
  });

  test("an already-past Expires is not a lifetime", async () => {
    // A Date header is the reference; the fetch time is not needed.
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires: hourBeforeFetch, date: new Date(FETCHED_AT).toUTCString(), "content-encoding": "gzip" },
    }));
    const checks = await run(badCachingRule, siteCtx(pages));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
    expect(check(checks, "bad-caching-validators")?.status).toBe("warn");
  });

  test("a literal `Expires: 0` is not a lifetime", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires: "0", "content-encoding": "gzip" },
    }));
    const checks = await run(badCachingRule, siteCtx(pages));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
  });

  test("an unparsable Expires is not a lifetime", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires: "never", "content-encoding": "gzip" },
    }));
    const checks = await run(badCachingRule, siteCtx(pages));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
  });

  test("Expires is compared against the response Date header when present", async () => {
    // Expires is in the real past but ahead of the (old) Date: still a lifetime.
    const date = new Date(Date.now() - 7200 * 1000).toUTCString();
    const expires = new Date(Date.now() - 3600 * 1000).toUTCString();
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires, date, "content-encoding": "gzip" },
    }));
    const checks = await run(badCachingRule, siteCtx(pages));
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
    // Expires in the future of now but behind Date: not a lifetime.
    const futureDate = new Date(Date.now() + 7200 * 1000).toUTCString();
    const soon = new Date(Date.now() + 3600 * 1000).toUTCString();
    const pages2 = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/q${i}`,
      headers: { expires: soon, date: futureDate, "content-encoding": "gzip" },
    }));
    expect(verdict(await run(badCachingRule, siteCtx(pages2)), "bad-caching-freshness")).toBe("flagged");
  });

  test("a positive max-age wins over a past Expires", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "max-age=600", expires: hourBeforeFetch, "content-encoding": "gzip" },
      fetchedAt: FETCHED_AT,
    }));
    const checks = await run(badCachingRule, siteCtx(pages));
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
  });

  test("an empty Expires is not a lifetime", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires: "", "content-encoding": "gzip" },
    }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(verdict(checks, "bad-caching-freshness")).toBe("flagged");
  });
});

// pub#600: Cloudflare drops the ETag from HTML it rewrites, so a missing
// validator behind it may be the edge's doing. The note explains; it never
// changes a status.
describe("perf/bad-caching Cloudflare note", () => {
  const NOTE =
    "came through Cloudflare, which may drop the ETag from HTML it rewrites with Email Address Obfuscation, Automatic HTTPS Rewrites, Replace insecure JavaScript libraries or JavaScript Detections (Bot Fight Mode). Add no-transform to the HTML Cache-Control, turn those features off, or also send Last-Modified";

  // The shape pub#600 was filed for: revalidate-every-time HTML whose ETag
  // the edge removed, so both the policy and the validator are missing.
  const strippedHeaders = {
    "cache-control": "public, max-age=0, must-revalidate",
    "content-encoding": "zstd",
  };

  function pagesWith(count: number, headers: (i: number) => Record<string, string>) {
    return Array.from({ length: count }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: headers(i),
    }));
  }

  test("pages behind Cloudflare get the note on the validators check", async () => {
    const pages = pagesWith(14, () => ({ ...strippedHeaders, "cf-cache-status": "HIT" }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    const validators = check(checks, "bad-caching-validators");
    expect(validators?.status).toBe("warn");
    expect(validators?.message).toBe(
      `14/14 pages lack an ETag or Last-Modified validator. 14 of them ${NOTE}`
    );
    expect(validators?.details?.cloudflarePages).toBe(14);
    // Freshness is unchanged: same message, no note.
    const freshness = check(checks, "bad-caching-freshness");
    expect(freshness?.status).toBe("info");
    expect(freshness?.message).toBe(
      "14/14 pages set no caching policy (no freshness lifetime and no validator)"
    );
  });

  test("server: cloudflare alone is enough", async () => {
    const pages = pagesWith(4, () => ({ ...strippedHeaders, server: "cloudflare" }));
    const validators = check(await run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.message).toBe(
      `4/4 pages lack an ETag or Last-Modified validator. 4 of them ${NOTE}`
    );
  });

  test("the same headers without Cloudflare carry no note", async () => {
    const pages = pagesWith(4, () => ({ ...strippedHeaders, server: "nginx" }));
    const validators = check(await run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.status).toBe("warn");
    expect(validators?.message).toBe("4/4 pages lack an ETag or Last-Modified validator");
    expect(validators?.details?.cloudflarePages).toBeUndefined();
  });

  test("exactly half of the missing pages behind Cloudflare is enough", async () => {
    const pages = pagesWith(4, (i) => ({
      ...strippedHeaders,
      server: i < 2 ? "cloudflare" : "nginx",
    }));
    const validators = check(await run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.message).toBe(
      `4/4 pages lack an ETag or Last-Modified validator. 2 of them ${NOTE}`
    );
  });

  test("fewer than half of the missing pages behind Cloudflare is not", async () => {
    const pages = pagesWith(4, (i) => ({
      ...strippedHeaders,
      server: i < 1 ? "cloudflare" : "nginx",
    }));
    const validators = check(await run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.message).toBe("4/4 pages lack an ETag or Last-Modified validator");
  });

  test("Cloudflare pages that kept a validator do not count toward the note", async () => {
    // 10 pages: the 4 with an ETag are behind Cloudflare, and only 2 of the 6
    // missing one are. 2 of 6 is under half, so no note.
    const pages = pagesWith(10, (i) => ({
      ...strippedHeaders,
      ...(i < 4 ? { etag: '"x"', server: "cloudflare" } : {}),
      ...(i >= 4 && i < 6 ? { server: "cloudflare" } : {}),
    }));
    const validators = check(await run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.status).toBe("warn");
    expect(validators?.message).toBe("6/10 pages lack an ETag or Last-Modified validator");
  });

  test("half is measured against the pages missing a validator, not all pages", async () => {
    // 3 of the 6 missing are behind Cloudflare: half of the missing pages,
    // though under half of the 10 crawled.
    const pages = pagesWith(10, (i) => ({
      ...strippedHeaders,
      ...(i < 4 ? { etag: '"x"' } : {}),
      ...(i >= 4 && i < 7 ? { server: "cloudflare" } : {}),
    }));
    const validators = check(await run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.message).toBe(
      `6/10 pages lack an ETag or Last-Modified validator. 3 of them ${NOTE}`
    );
  });

  test("at exactly the 60% threshold the check passes with no note", async () => {
    const pages = pagesWith(5, (i) => ({
      ...strippedHeaders,
      "cf-cache-status": "HIT",
      ...(i < 3 ? { etag: 'W/"x"' } : {}),
    }));
    const validators = check(await run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.status).toBe("pass");
    expect(validators?.message).toBe("3/5 pages expose a revalidation validator");
  });

  test("a passing validators check behind Cloudflare carries no note", async () => {
    const pages = pagesWith(5, (i) => ({
      ...strippedHeaders,
      "cf-cache-status": "HIT",
      ...(i < 4 ? { etag: 'W/"x"' } : {}),
    }));
    const validators = check(await run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.status).toBe("pass");
    expect(validators?.message).toBe("4/5 pages expose a revalidation validator");
  });
});

// pub#633: one missing server setting costs the score once. The per-page rules
// score freshness and compression; this rule reports the site share as info.
describe("perf/bad-caching freshness and compression are info (pub#633)", () => {
  test.each([
    ["no caching headers, no compression", {}],
    ["a healthy site", goodHeaders],
  ])("%s: neither check moves the score", async (_name, headers) => {
    const pages = Array.from({ length: 4 }, (_, i) => ({ url: `https://example.com/p${i}`, headers }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    for (const name of ["bad-caching-freshness", "bad-caching-compression"]) {
      expect(check(checks, name)?.status).toBe("info");
    }
  });

  test("below the threshold, the messages and example pages are as before", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({ url: `https://example.com/p${i}`, headers: {} }));
    const checks = (await run(badCachingRule, siteCtx(pages)));
    expect(check(checks, "bad-caching-freshness")?.message).toBe(
      "4/4 pages set no caching policy (no freshness lifetime and no validator)"
    );
    expect(check(checks, "bad-caching-compression")?.message).toBe(
      "4/4 compressible pages served without gzip/Brotli"
    );
    // The pages are still listed.
    expect(check(checks, "bad-caching-freshness")?.pages).toHaveLength(4);
    expect(check(checks, "bad-caching-compression")?.pages).toHaveLength(4);
  });
});

// #605: Cloudflare JavaScript Detections is the one ETag-removing feature with a marker in the page.
describe("perf/bad-caching names JavaScript Detections (#605)", () => {
  const JSD = `<script>(function(){window.__CF$cv$params={r:'8a1',t:'MTcz'};var a=document.createElement('script');a.nonce='';a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);})();</script>`;
  const stripped = { "cache-control": "max-age=0", server: "cloudflare" };
  const NAMES = "which may drop the ETag from HTML it rewrites";
  const page = (i: number, html: string) => ({ url: `https://example.com/p${i}`, html, headers: stripped });

  /** The resident engine reads each page's document; the streaming engine reads the recorded markers. */
  function ctxFor(engine: "resident" | "streaming", htmls: string[]): RuleContext {
    const pages = htmls.map((h, i) => page(i, h));
    const base = siteCtx(pages.map((p) => ({ url: p.url, headers: p.headers })));
    const parsed = pages.map((p) => parsePage(p.html, p.url));
    base.site!.pages = base.site!.pages.map((sp, i) => ({ ...sp, parsed: parsed[i]! }));
    if (engine === "resident") return base;
    return {
      ...base,
      collectedSignals: { pages: pages.map((p, i) => buildCollectedPageSignal({ url: p.url, parsed: parsed[i]!, htmlBytes: 100 })) },
    } as unknown as RuleContext;
  }
  const doc = (body: string) => `<html><head><title>t</title>${body}</head><body></body></html>`;

  for (const engine of ["resident", "streaming"] as const) {
    test(`${engine}: the marker at the end of a script-heavy page is found`, async () => {
      const filler = '<script src="/a.js"></script>'.repeat(150);
      const heavy = `<html><head><title>t</title></head><body>${filler}${JSD}</body></html>`;
      const ctx = ctxFor(engine, [heavy, heavy]);
      const v = check(await run(badCachingRule, ctx), "bad-caching-validators")!;
      expect(v.message).toContain("Cloudflare JavaScript Detections");
    });
  }

  for (const engine of ["resident", "streaming"] as const) {
    test(`${engine}: half or more of the missing pages carrying the marker names JavaScript Detections`, async () => {
      const ctx = ctxFor(engine, [doc(JSD), doc(JSD), doc(JSD), doc("")]);
      const v = check(await run(badCachingRule, ctx), "bad-caching-validators")!;
      expect(v.message).toContain("Cloudflare JavaScript Detections");
      expect(v.message).toContain("found on 3 of them");
      expect(v.message).not.toContain(NAMES);
      expect(v.details?.javascriptDetectionsPages).toBe(3);
    });

    test(`${engine}: Cloudflare pages without the marker keep the headers-only note`, async () => {
      const ctx = ctxFor(engine, [doc(""), doc(""), doc(""), doc("")]);
      const v = check(await run(badCachingRule, ctx), "bad-caching-validators")!;
      expect(v.message).toContain(NAMES);
      expect(v.details?.javascriptDetectionsPages).toBeUndefined();
    });

    test(`${engine}: fewer than half carrying the marker is not enough`, async () => {
      const ctx = ctxFor(engine, [doc(JSD), doc(""), doc(""), doc("")]);
      const v = check(await run(badCachingRule, ctx), "bad-caching-validators")!;
      expect(v.message).toContain(NAMES);
      expect(v.details?.javascriptDetectionsPages).toBeUndefined();
    });

    test(`${engine}: the path in visible text, or in a code sample, is not a script marker`, async () => {
      const text = `<p>Cloudflare loads /cdn-cgi/challenge-platform/scripts/jsd/main.js on your pages</p><pre>__CF$cv$params</pre>`;
      const ctx = ctxFor(engine, [text, text, text, text].map((t) => `<html><head></head><body>${t}</body></html>`));
      const v = check(await run(badCachingRule, ctx), "bad-caching-validators")!;
      expect(v.details?.javascriptDetectionsPages).toBeUndefined();
    });

    test(`${engine}: an external script from the challenge platform counts too`, async () => {
      const ext = doc(`<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js" defer></script>`);
      const v = check(await run(badCachingRule, ctxFor(engine, [ext, ext, ext, ext])), "bad-caching-validators")!;
      expect(v.details?.javascriptDetectionsPages).toBe(4);
    });
  }

  test("detection stays linear on a 1 MB page of scripts and on thousands of script tags", () => {
    const big = `<html><head><script>${"x".repeat(1024 * 1024)}</script></head><body></body></html>`;
    const many = `<html><head>${"<script>var a=1</script>".repeat(40_000)}</head><body></body></html>`;
    for (const html of [big, many]) {
      const parsed = parsePage(html, "https://example.com/");
      const started = performance.now();
      expect(hasJavaScriptDetections(parsed.document!)).toBe(false);
      expect(performance.now() - started).toBeLessThan(100);
    }
    // the marker beyond the read window of a huge script is not found, and that is the documented bound
    expect(hasJavaScriptDetections(parsePage(`<html><head><script>${"x".repeat(5000)}/cdn-cgi/challenge-platform/</script></head></html>`, "https://example.com/").document!)).toBe(false);
  });
});

// #1754: the origin sent no-store, so the missing validator is its choice, not Cloudflare's.
describe("perf/bad-caching no-store (#1754)", () => {
  const noStorePages = (n: number, extra: Record<string, string> = {}) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "no-store", "content-encoding": "gzip", ...extra },
    }));

  test("no-store behind Cloudflare names no-store and does not blame Cloudflare", async () => {
    const checks = (await run(badCachingRule, siteCtx(noStorePages(6, { "cf-cache-status": "DYNAMIC" }))));
    const validators = check(checks, "bad-caching-validators");
    expect(validators?.status).toBe("warn");
    expect(validators?.message).toContain("Cache-Control: no-store");
    expect(validators?.message).not.toContain("Cloudflare");
    expect(validators?.details?.noStorePages).toBe(6);
    expect(validators?.details?.cloudflarePages).toBeUndefined();
  });

  test("freshness distinguishes no-store from no policy", async () => {
    const checks = (await run(badCachingRule, siteCtx(noStorePages(4))));
    const msg = check(checks, "bad-caching-freshness")?.message ?? "";
    expect(msg).toContain("Cache-Control: no-store");
    expect(msg).not.toContain("no caching policy");
  });

  test("a mix reports both counts", async () => {
    const pages = [
      ...noStorePages(2),
      ...Array.from({ length: 2 }, (_, i) => ({
        url: `https://example.com/q${i}`,
        headers: { "content-encoding": "gzip" },
      })),
    ];
    const msg = check(await run(badCachingRule, siteCtx(pages)), "bad-caching-freshness")?.message ?? "";
    expect(msg).toContain("2 send Cache-Control: no-store");
    expect(msg).toContain("2 set no caching policy");
  });
});

describe("perf/bad-caching sub-resources (repo#4492)", () => {
  const pages = [{ url: "https://example.com/", headers: goodHeaders }];
  function withAssets(css: { url: string; cacheControl: string | null; extra?: Record<string, unknown> }[]): RuleContext {
    const ctx = siteCtx(pages);
    ctx.site!.resourceSizes = {
      css: css.map((c) => ({
        url: c.url,
        status: 200,
        error: null,
        contentType: "text/css",
        sizeBytes: 100,
        sourcePages: ["https://example.com/"],
        cacheControl: c.cacheControl,
        ...c.extra,
      })),
      images: [],
    } as unknown as NonNullable<SiteData["resourceSizes"]>;
    return ctx;
  }

  test("a sub-resource with a lifetime passes", async () => {
    const checks = await run(badCachingRule, withAssets([{ url: "https://example.com/a.css", cacheControl: "public, max-age=31536000, immutable" }]));
    expect(check(checks, "bad-caching-subresources")?.status).toBe("pass");
  });

  test("a sub-resource without a lifetime is its own finding", async () => {
    const checks = await run(badCachingRule, withAssets([
      { url: "https://example.com/a.css", cacheControl: "public, max-age=31536000" },
      { url: "https://example.com/b.css", cacheControl: null },
      { url: "https://example.com/c.css", cacheControl: "max-age=0", extra: { etag: '"x"' } },
    ]));
    const sub = check(checks, "bad-caching-subresources");
    expect(sub?.status).toBe("warn");
    expect(sub?.items?.map((i) => i.id)).toEqual(["https://example.com/b.css", "https://example.com/c.css"]);
    // The document-level checks are untouched.
    expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
  });

  test("a document-only site has no sub-resource check", async () => {
    const checks = await run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-subresources")).toBeUndefined();
  });

  test("cross-site, reused and unobserved records are not judged", async () => {
    const checks = await run(badCachingRule, withAssets([
      { url: "https://cdn.other.com/a.css", cacheControl: null },
      { url: "https://example.com/b.css", cacheControl: null, extra: { cacheReason: "max-age" } },
      { url: "https://example.com/c.css", cacheControl: undefined as unknown as null },
    ]));
    expect(check(checks, "bad-caching-subresources")).toBeUndefined();
  });

  test("an asset revalidated with a 304 on this crawl is judged like a fresh fetch", async () => {
    // The CLI audits incrementally by default, so a re-audit sees an asset with a
    // validator and no lifetime as a 304, never a 200. It must still be flagged.
    const checks = await run(badCachingRule, withAssets([
      { url: "https://example.com/a.css", cacheControl: null, extra: { etag: '"a"', cacheReason: "304" } },
      { url: "https://example.com/b.css", cacheControl: "max-age=0", extra: { etag: '"b"', cacheReason: "304" } },
    ]));
    const sub = check(checks, "bad-caching-subresources");
    expect(sub?.status).toBe("warn");
    expect(sub?.items?.map((i) => i.id)).toEqual(["https://example.com/a.css", "https://example.com/b.css"]);
  });

  test("a 304 with a lifetime passes", async () => {
    const checks = await run(badCachingRule, withAssets([
      { url: "https://example.com/a.css", cacheControl: "max-age=600", extra: { etag: '"a"', cacheReason: "304" } },
    ]));
    expect(check(checks, "bad-caching-subresources")?.status).toBe("pass");
  });

  test("the sample is bounded by max_subresources, in URL order", async () => {
    const ctx = withAssets([
      { url: "https://example.com/c.css", cacheControl: null },
      { url: "https://example.com/a.css", cacheControl: "max-age=60" },
      { url: "https://example.com/b.css", cacheControl: "max-age=60" },
    ]);
    ctx.options = { max_subresources: 2 };
    const sub = check(await run(badCachingRule, ctx), "bad-caching-subresources");
    expect(sub?.status).toBe("pass");
    expect(sub?.details?.sampled).toBe(2);
  });

  test("script fetches carry their cache headers", async () => {
    const ctx = siteCtx(pages);
    ctx.site!.scripts = [{
      url: "https://example.com/app.js", status: 200, error: null, contentType: "application/javascript",
      sizeBytes: 1, content: null, sourcePages: ["https://example.com/"],
      cacheHeaders: { cacheControl: null, expires: null, date: null, etag: null, lastModified: null },
    }] as unknown as NonNullable<SiteData["scripts"]>;
    expect(check(await run(badCachingRule, ctx), "bad-caching-subresources")?.status).toBe("warn");
  });
});

describe("perf/bad-caching header case and not-recorded headers (repo#4641)", () => {
  const mixedCase = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://example.com/m${i}`,
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=3600",
        ETag: '"abc"',
        "Content-Encoding": "br",
      },
    }));

  test("mixed-case ETag and Cache-Control read the same as lowercase", async () => {
    const checks = await run(badCachingRule, siteCtx(mixedCase(4)));
    expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
    expect(verdict(checks, "bad-caching-freshness")).toBe("ok");
    expect(verdict(checks, "bad-caching-compression")).toBe("ok");
  });

  test("a mixed-case Last-Modified counts as a validator", async () => {
    const pages = Array.from({ length: 3 }, (_, i) => ({
      url: `https://example.com/l${i}`,
      headers: { "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT" },
    }));
    expect(check(await run(badCachingRule, siteCtx(pages)), "bad-caching-validators")?.status).toBe("pass");
  });

  test("headers not recorded: not checked with a reason, never a failure", async () => {
    const pages = Array.from({ length: 3 }, (_, i) => ({
      url: `https://example.com/u${i}`,
      headers: {},
      headersRecorded: false,
    }));
    const checks = await run(badCachingRule, siteCtx(pages));
    expect(checks).toHaveLength(1);
    const c = checks[0]!;
    expect(c.name).toBe("bad-caching");
    expect(c.status).toBe("skipped");
    expect(c.skipReason).toBe("headers-not-recorded");
    expect(c.status).not.toBe("fail");
    expect(check(checks, "bad-caching-validators")).toBeUndefined();
  });

  test("the absence of a header on a recorded page still warns", async () => {
    const pages = Array.from({ length: 3 }, (_, i) => ({
      url: `https://example.com/r${i}`,
      headers: {},
      headersRecorded: true,
    }));
    expect(check(await run(badCachingRule, siteCtx(pages)), "bad-caching-validators")?.status).toBe("warn");
  });

  test("some pages unrecorded: they are left out of the shares and listed as not checked", async () => {
    const pages = [
      ...mixedCase(3),
      { url: "https://example.com/x", headers: {}, headersRecorded: false },
    ];
    const checks = await run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
    const note = check(checks, "bad-caching-headers-not-recorded");
    expect(note?.status).toBe("skipped");
    expect(note?.skipReason).toBe("headers-not-recorded");
    expect(note?.pages).toEqual(["https://example.com/x"]);
  });
});
