// (#3413) A clipped signal lists only part of the crawl; its count sizes the
// complete-store denominator (clean = crawled - failing), never shrinks it.
import { describe, expect, test } from "bun:test";

import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";

import { foldCompleteStoreTallies } from "../src/complete-store-fold";

const META = {
  id: "content/word-count",
  name: "Word count",
  description: "Pages need enough words",
  category: "content",
  scope: "page" as const,
  severity: "error" as const,
  weight: 5,
};

async function* noPages(): AsyncGenerator<never[]> {}

async function passes(crawled: string[], crawledCount?: number): Promise<number> {
  const tallies = await foldCompleteStoreTallies({
    ruleResults: { [META.id]: { meta: META, checks: [] } } as never,
    findingPages: noPages() as never,
    crawledUrls: new Set(crawled),
    ...(crawledCount === undefined ? {} : { crawledCount }),
    carriedFindings: [],
    carriedPageUrls: new Set(),
    ruleMetaIndex: new Map(),
  });
  const tally = tallies.get(META.id)!.tally;
  return tally.passed;
}

describe("crawledCount sizes the denominator (#3413)", () => {
  const listed = ["https://x.test/a", "https://x.test/b"];

  test("the larger of the count and the listed pages", async () => {
    const base = await passes(listed);
    expect(await passes(listed, 5)).toBeGreaterThan(base);
    expect(await passes(listed, 2)).toBe(base);
    // A count below the list never shrinks it; neither does junk.
    expect(await passes(listed, 1)).toBe(base);
    expect(await passes(listed, Number.NaN)).toBe(base);
  });

  test("an inflated count is bounded by the crawl ceiling, never an unbounded denominator", async () => {
    const atCeiling = await passes(listed, REPORT_LIMITS.maxPages);
    expect(await passes(listed, REPORT_LIMITS.maxPages * 1000)).toBe(atCeiling);
    expect(await passes(listed, Number.MAX_SAFE_INTEGER)).toBe(atCeiling);
    expect(await passes(listed, -5)).toBe(await passes(listed));
  });

  test("the count only sizes clean passes: failures and their units are untouched", async () => {
    const failing = (crawledCount?: number) =>
      foldCompleteStoreTallies({
        ruleResults: {
          "security/csp": {
            meta: { ...META, id: "security/csp", category: "security", severity: "error" },
            checks: [],
          },
        } as never,
        findingPages: (async function* () {
          yield [
            {
              normalizedUrl: "https://x.test/a",
              ruleId: "security/csp",
              checkName: "csp",
              locator: "",
              status: "fail",
              severity: "error",
              message: "m",
              value: null,
              expected: null,
              payload: null,
              fingerprint: "f",
              firstSeenAt: 1,
              lastSeenAt: 1,
              lastSeenCrawlId: "a",
              provenance: "fresh",
              state: "open",
              siteKey: "s",
            },
          ];
        })() as never,
        crawledUrls: new Set(listed),
        ...(crawledCount === undefined ? {} : { crawledCount }),
        carriedFindings: [],
        carriedPageUrls: new Set(),
        ruleMetaIndex: new Map(),
      }).then((t) => t.get("security/csp")!.tally);
    const base = await failing();
    const inflated = await failing(REPORT_LIMITS.maxPages * 1000);
    expect(inflated.failed).toBe(base.failed);
    expect(inflated.failUnits).toBe(base.failUnits);
    expect(base.failed).toBeGreaterThan(0);
  });
});
