// crawl/server-errors reports each crawled page whose final response is 5xx (#2036), one finding per page (#2130).

import { describe, expect, test } from "bun:test";

import { resolutionCheckKey, resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { skipReasonClass } from "@squirrelscan/core-contracts/rule-outcome";

import { buildResolutionSignal } from "../src/resolution";
import { serverErrorsRule } from "../src/crawl/server-errors";
import type { RuleContext } from "../src/types";

type SiteExtras = {
  crawlLimits?: { pagesCrawled: number; maxPages: number };
  unfetchedPages?: number;
  failedFetches?: number;
};

function run(
  pages: Array<{ url: string; statusCode: number; redirectSource?: boolean }>,
  extras: SiteExtras = {},
) {
  const ctx = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    options: {},
    site: {
      baseUrl: "https://example.com/",
      pages: pages.map((p) => ({ ...p, parsed: {} })),
      ...extras,
    },
  } as unknown as RuleContext;
  return serverErrorsRule.run(ctx) as { checks: Array<Record<string, any>> };
}

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";
const KEY = resolutionCheckKey("crawl/server-errors", "server-errors");
const hash = (u: string) => resolutionUrlHash(u);
const pageChecks = (r: { checks: Array<Record<string, any>> }) => r.checks.filter((c) => c.pageUrl);
const siteChecks = (r: { checks: Array<Record<string, any>> }) => r.checks.filter((c) => !c.pageUrl);

describe("crawl/server-errors", () => {
  test("a 500 page fails as its own page finding with its status", () => {
    const fails = pageChecks(
      run([
        { url: "https://example.com/", statusCode: 200 },
        { url: "https://example.com/boom", statusCode: 500 },
      ]),
    ).filter((c) => c.status === "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0]!.pageUrl).toBe("https://example.com/boom");
    expect(fails[0]!.details).toEqual({ statusCode: 500 });
    expect(fails[0]!.items).toEqual([
      { id: "https://example.com/boom", label: "https://example.com/boom (500)", meta: { statusCode: 500 } },
    ]);
  });

  test("each 5xx page is its own finding, and no site-level row repeats them", () => {
    const result = run([
      { url: URL_A, statusCode: 503 },
      { url: URL_B, statusCode: 502 },
    ]);
    const fails = pageChecks(result).filter((c) => c.status === "fail");
    expect(fails.map((c) => [c.pageUrl, c.details.statusCode])).toEqual([
      [URL_A, 503],
      [URL_B, 502],
    ]);
    expect(siteChecks(result)).toEqual([]);
  });

  test("a healthy site, and a page that recovered on retry (stored as 200), pass", () => {
    const result = run([
      { url: "https://example.com/", statusCode: 200 },
      { url: "https://example.com/flaky", statusCode: 200 },
      { url: "https://example.com/gone", statusCode: 404 },
    ]);
    expect(siteChecks(result).map((c) => c.status)).toEqual(["pass"]);
    expect(pageChecks(result).every((c) => c.status === "pass")).toBe(true);
    expect(pageChecks(result)).toHaveLength(3);
  });

  test("a redirect entry is not a page", () => {
    const result = run([{ url: "https://example.com/r", statusCode: 500, redirectSource: true }]);
    expect(pageChecks(result)).toEqual([]);
    expect(siteChecks(result)[0]?.status).toBe("pass");
  });

  test("no pages skips", () => {
    expect(run([]).checks[0]?.status).toBe("skipped");
  });

  // A clean pass on a crawl that did not reach every page would mark a stored 5xx finding for an
  // unfetched page fixed; the rule skips with a coded gap instead.
  test("a crawl stopped at its page cap does not pass: skipped as a coverage gap", () => {
    const [check] = siteChecks(
      run([{ url: "https://example.com/", statusCode: 200 }], {
        crawlLimits: { pagesCrawled: 1, maxPages: 1 },
      }),
    );
    expect(check!.status).toBe("skipped");
    expect(skipReasonClass(check!.skipReason)?.notChecked).toBe(true);
  });

  test("a crawl that left URLs queued does not pass: skipped as a coverage gap", () => {
    const [check] = siteChecks(
      run([{ url: "https://example.com/", statusCode: 200 }], {
        crawlLimits: { pagesCrawled: 1, maxPages: 100 },
        unfetchedPages: 3,
      }),
    );
    expect(check!.status).toBe("skipped");
    expect(skipReasonClass(check!.skipReason)?.notChecked).toBe(true);
  });

  // A page that answered 5xx last audit and timed out this one was not fetched: no 5xx row, nothing
  // queued, under the cap. Passing would mark its stored finding fixed.
  test("a crawl that failed to fetch a page does not pass: skipped as pages-not-fetched", () => {
    const [check] = siteChecks(
      run([{ url: "https://example.com/", statusCode: 200 }], {
        crawlLimits: { pagesCrawled: 1, maxPages: 100 },
        unfetchedPages: 0,
        failedFetches: 1,
      }),
    );
    expect(check!.status).toBe("skipped");
    expect(check!.skipReason).toBe("pages-not-fetched");
    expect(skipReasonClass(check!.skipReason)?.notChecked).toBe(true);
  });

  test("a crawl with failed fetches still reports the 5xx pages it did fetch", () => {
    const result = run([{ url: "https://example.com/boom", statusCode: 500 }], { failedFetches: 2 });
    expect(pageChecks(result).map((c) => c.status)).toEqual(["fail"]);
    expect(siteChecks(result)[0]?.skipReason).toBe("pages-not-fetched");
  });

  test("a capped crawl still reports the 5xx pages it did fetch", () => {
    const result = run([{ url: "https://example.com/boom", statusCode: 500 }], {
      crawlLimits: { pagesCrawled: 1, maxPages: 1 },
    });
    expect(pageChecks(result).map((c) => c.status)).toEqual(["fail"]);
  });

  test("a complete crawl under its cap with nothing queued passes", () => {
    const [check] = siteChecks(
      run([{ url: "https://example.com/", statusCode: 200 }], {
        crawlLimits: { pagesCrawled: 1, maxPages: 100 },
        unfetchedPages: 0,
        failedFetches: 0,
      }),
    );
    expect(check!.status).toBe("pass");
  });
});

describe("crawl/server-errors resolution signal (#2130)", () => {
  const signalFor = (
    pages: Array<{ url: string; statusCode: number }>,
    extras: SiteExtras = {},
  ) =>
    buildResolutionSignal(
      { "crawl/server-errors": { checks: run(pages, extras).checks as any } },
      pages.map((p) => p.url),
    )!;

  test("a page that answered 5xx before and 200 now is evaluated clean while another page still fails", () => {
    const signal = signalFor([
      { url: URL_A, statusCode: 200 },
      { url: URL_B, statusCode: 500 },
    ]);
    expect(signal.failing[KEY]).toEqual([hash(URL_B)]);
    expect(signal.notEvaluated?.[KEY] ?? []).not.toContain(hash(URL_A));
  });

  test("a prior finding on a page not fetched this audit is not resolvable: it is not in the crawl", () => {
    const signal = signalFor(
      [
        { url: URL_A, statusCode: 200 },
        { url: URL_B, statusCode: 200 },
      ],
      { crawlLimits: { pagesCrawled: 2, maxPages: 2 } },
    );
    const unfetched = "https://example.com/not-fetched";
    expect(signal.crawledUrls).not.toContain(unfetched);
    expect(signal.failing[KEY]).toEqual([]);
    expect(signal.notEvaluated?.[KEY] ?? []).not.toContain(hash(URL_A));
  });
});
