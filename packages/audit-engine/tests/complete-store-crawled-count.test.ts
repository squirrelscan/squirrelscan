// (#3413) A clipped signal lists only part of the crawl; its count sizes the
// complete-store denominator (clean = crawled - failing), never shrinks it.
import { describe, expect, test } from "bun:test";

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
});
