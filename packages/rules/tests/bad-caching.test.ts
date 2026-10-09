// perf/bad-caching — site-wide weak-caching detection (#109).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { badCachingRule } from "../src/performance/bad-caching";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

function siteCtx(
  pages: { url: string; headers: Record<string, string> }[]
): RuleContext {
  const html = "<html><head><title>t</title></head><body></body></html>";
  const sitePages: SiteData["pages"] = pages.map((p) => ({
    url: p.url,
    statusCode: 200,
    parsed: parsePage(html, p.url),
    headers: { "content-type": "text/html", ...p.headers },
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

function run(rule: Rule, ctx: RuleContext): CheckResult[] {
  return rule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

const goodHeaders = {
  "cache-control": "public, max-age=3600",
  etag: '"abc123"',
  "content-encoding": "br",
};

describe("perf/bad-caching", () => {
  test("skips when no HTML pages with headers", () => {
    const checks = run(badCachingRule, siteCtx([]));
    expect(check(checks, "bad-caching")?.status).toBe("skipped");
  });

  test("passes a well-cached, compressed site", () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: goodHeaders,
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
    expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
    expect(check(checks, "bad-caching-compression")?.status).toBe("pass");
  });

  test("flags missing freshness across the site", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { etag: '"x"', "content-encoding": "gzip" }, // no cache-control/expires
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    const freshness = check(checks, "bad-caching-freshness");
    expect(freshness?.status).toBe("fail");
    expect(freshness?.pages?.length).toBeGreaterThan(0);
  });

  test("no-store does not count as freshness", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "no-store, max-age=3600",
        etag: '"x"',
        "content-encoding": "gzip",
      },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("fail");
  });

  // #2230 — `no-cache` and `s-maxage=0` still mean "no freshness lifetime",
  // which is what the crawler's own parser says and what these two tests were
  // written for. What changed is the verdict: a response that gives a cache
  // nothing to reuse but DOES give it something to revalidate against has a
  // caching policy, and the correct one for a document that must never be
  // served stale. Each pairs with the same header and no validator, which is
  // the case worth reporting: every request is a full transfer.
  test("no-cache with a validator is a revalidation policy, not a missing one", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "no-cache, max-age=3600",
        etag: '"x"',
        "content-encoding": "gzip",
      },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
  });

  test("no-cache with no validator has no caching policy at all", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "no-cache, max-age=3600", "content-encoding": "gzip" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("fail");
  });

  test("s-maxage=0 with a validator is a revalidation policy", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "max-age=3600, s-maxage=0",
        etag: '"x"',
        "content-encoding": "gzip",
      },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
  });

  test("s-maxage=0 with no validator has no caching policy at all", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "max-age=3600, s-maxage=0", "content-encoding": "gzip" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("fail");
  });

  // The shape the issue was filed for: the default a framework or CDN emits
  // for an HTML document, and the one that used to fail 163 of 196 sites.
  test("max-age=0, must-revalidate with a strong ETag passes", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        etag: '"ff27a01f0a15f0ff44c0abfc199a32d1"', // pragma: allowlist secret
        "content-encoding": "br",
      },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
  });

  test("max-age=0, must-revalidate with Last-Modified instead of an ETag passes", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        "last-modified": "Wed, 16 Sep 2026 08:01:44 UTC",
        "content-encoding": "br",
      },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
  });

  test("max-age=0 with neither validator still fails, and says why", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "public, max-age=0, must-revalidate", "content-encoding": "br" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    const freshness = check(checks, "bad-caching-freshness");
    expect(freshness?.status).toBe("fail");
    expect(freshness?.message).toBe(
      "4/4 pages set no caching policy (no freshness lifetime and no validator)"
    );
  });

  test("no-store is never a caching policy, validator or not", () => {
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
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("fail");
  });

  test("a validator with no Cache-Control at all is not a declared policy", () => {
    // The server said nothing about caching; a cache falls back to a heuristic
    // and nothing about the reuse is under the site's control. That is the
    // case the rule was written for and it still reports.
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { etag: '"x"', "content-encoding": "br" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("fail");
  });

  test("a freshness lifetime alone is still a policy", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "public, max-age=600", "content-encoding": "br" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
  });

  // pub#600: the validators check warns and never fails. A page with no
  // lifetime and no validator already fails freshness for the same header.
  test("missing validators warn, never fail", () => {
    const none = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "max-age=600", "content-encoding": "br" },
    }));
    const validators = check(run(badCachingRule, siteCtx(none)), "bad-caching-validators");
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
    expect(check(run(badCachingRule, siteCtx(some)), "bad-caching-validators")?.status).toBe(
      "warn"
    );
  });

  test("max-age=0 with no validator still fails freshness after the validators cap", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "public, max-age=0, must-revalidate", "content-encoding": "br" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("fail");
    expect(check(checks, "bad-caching-validators")?.status).toBe("warn");
  });

  // pub#600: the reporter's theory was that a weak ETag, or one on a zstd
  // body, was dropped. It is not: any non-empty ETag is a validator, and
  // If-None-Match compares weakly, so `W/` still revalidates.
  for (const encoding of [undefined, "gzip", "br", "zstd"]) {
    test(`a weak ETag is a validator under max-age=0, must-revalidate (${encoding ?? "identity"})`, () => {
      const pages = Array.from({ length: 4 }, (_, i) => ({
        url: `https://example.com/p${i}`,
        headers: {
          "cache-control": "public, max-age=0, must-revalidate",
          etag: 'W/"ad66933fd8e64dd4529f856985df80eb"', // pragma: allowlist secret
          ...(encoding ? { "content-encoding": encoding } : {}),
        },
      }));
      const checks = run(badCachingRule, siteCtx(pages));
      expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
      expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
    });
  }

  test("flags uncompressed compressible responses", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { "cache-control": "max-age=600", etag: '"x"' }, // no content-encoding
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-compression")?.status).toBe("fail");
  });

  test("Expires header satisfies freshness", () => {
    const expires = new Date(Date.now() + 3600 * 1000).toUTCString();
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires, "last-modified": "x", "content-encoding": "gzip" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
    expect(check(checks, "bad-caching-validators")?.status).toBe("pass");
  });

  // Documented gap, #2243. The rule reads `Boolean(expires)` and never parses
  // the value, so an already-expired Expires counts as a lifetime even with no
  // validator to fall back on. Pinned here so the fix has to flip it on
  // purpose rather than change it by accident; docs state the same at
  // docs/rules/perf/bad-caching.mdx.
  test("an already-past Expires still counts as a lifetime (documented gap, #2243)", () => {
    const past = new Date(Date.now() - 3600 * 1000).toUTCString();
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires: past, "content-encoding": "gzip" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
    // No validator anywhere, so that check still reports the real gap.
    expect(check(checks, "bad-caching-validators")?.status).toBe("warn");
  });

  test("a literal `Expires: 0` still counts as a lifetime (documented gap, #2243)", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires: "0", "content-encoding": "gzip" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("pass");
  });

  test("an empty Expires is not a lifetime", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: { expires: "", "content-encoding": "gzip" },
    }));
    const checks = run(badCachingRule, siteCtx(pages));
    expect(check(checks, "bad-caching-freshness")?.status).toBe("fail");
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

  test("pages behind Cloudflare get the note on the validators check", () => {
    const pages = pagesWith(14, () => ({ ...strippedHeaders, "cf-cache-status": "HIT" }));
    const checks = run(badCachingRule, siteCtx(pages));
    const validators = check(checks, "bad-caching-validators");
    expect(validators?.status).toBe("warn");
    expect(validators?.message).toBe(
      `14/14 pages lack an ETag or Last-Modified validator. 14 of them ${NOTE}`
    );
    expect(validators?.details?.cloudflarePages).toBe(14);
    // Freshness is unchanged: same status, same message, no note.
    const freshness = check(checks, "bad-caching-freshness");
    expect(freshness?.status).toBe("fail");
    expect(freshness?.message).toBe(
      "14/14 pages set no caching policy (no freshness lifetime and no validator)"
    );
  });

  test("server: cloudflare alone is enough", () => {
    const pages = pagesWith(4, () => ({ ...strippedHeaders, server: "cloudflare" }));
    const validators = check(run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.message).toBe(
      `4/4 pages lack an ETag or Last-Modified validator. 4 of them ${NOTE}`
    );
  });

  test("the same headers without Cloudflare carry no note", () => {
    const pages = pagesWith(4, () => ({ ...strippedHeaders, server: "nginx" }));
    const validators = check(run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.status).toBe("warn");
    expect(validators?.message).toBe("4/4 pages lack an ETag or Last-Modified validator");
    expect(validators?.details?.cloudflarePages).toBeUndefined();
  });

  test("exactly half of the missing pages behind Cloudflare is enough", () => {
    const pages = pagesWith(4, (i) => ({
      ...strippedHeaders,
      server: i < 2 ? "cloudflare" : "nginx",
    }));
    const validators = check(run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.message).toBe(
      `4/4 pages lack an ETag or Last-Modified validator. 2 of them ${NOTE}`
    );
  });

  test("fewer than half of the missing pages behind Cloudflare is not", () => {
    const pages = pagesWith(4, (i) => ({
      ...strippedHeaders,
      server: i < 1 ? "cloudflare" : "nginx",
    }));
    const validators = check(run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.message).toBe("4/4 pages lack an ETag or Last-Modified validator");
  });

  test("Cloudflare pages that kept a validator do not count toward the note", () => {
    // 10 pages: the 4 with an ETag are behind Cloudflare, and only 2 of the 6
    // missing one are. 2 of 6 is under half, so no note.
    const pages = pagesWith(10, (i) => ({
      ...strippedHeaders,
      ...(i < 4 ? { etag: '"x"', server: "cloudflare" } : {}),
      ...(i >= 4 && i < 6 ? { server: "cloudflare" } : {}),
    }));
    const validators = check(run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.status).toBe("warn");
    expect(validators?.message).toBe("6/10 pages lack an ETag or Last-Modified validator");
  });

  test("half is measured against the pages missing a validator, not all pages", () => {
    // 3 of the 6 missing are behind Cloudflare: half of the missing pages,
    // though under half of the 10 crawled.
    const pages = pagesWith(10, (i) => ({
      ...strippedHeaders,
      ...(i < 4 ? { etag: '"x"' } : {}),
      ...(i >= 4 && i < 7 ? { server: "cloudflare" } : {}),
    }));
    const validators = check(run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.message).toBe(
      `6/10 pages lack an ETag or Last-Modified validator. 3 of them ${NOTE}`
    );
  });

  test("at exactly the 60% threshold the check passes with no note", () => {
    const pages = pagesWith(5, (i) => ({
      ...strippedHeaders,
      "cf-cache-status": "HIT",
      ...(i < 3 ? { etag: 'W/"x"' } : {}),
    }));
    const validators = check(run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.status).toBe("pass");
    expect(validators?.message).toBe("3/5 pages expose a revalidation validator");
  });

  test("a passing validators check behind Cloudflare carries no note", () => {
    const pages = pagesWith(5, (i) => ({
      ...strippedHeaders,
      "cf-cache-status": "HIT",
      ...(i < 4 ? { etag: 'W/"x"' } : {}),
    }));
    const validators = check(run(badCachingRule, siteCtx(pages)), "bad-caching-validators");
    expect(validators?.status).toBe("pass");
    expect(validators?.message).toBe("4/5 pages expose a revalidation validator");
  });
});
