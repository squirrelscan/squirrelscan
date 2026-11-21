// --compare-url must reach the crawler (#2096): the controller spreads
// targetedCrawlerOptions into createCrawler.
import { describe, expect, test } from "bun:test";

import { targetedCrawlerOptions } from "../../src/controllers/audit";

describe("targetedCrawlerOptions", () => {
  test("passes compareUrls and targetUrls through", () => {
    expect(
      targetedCrawlerOptions({
        targetUrls: ["https://a.test/x"],
        compareUrls: ["https://a.test/y"],
      })
    ).toEqual({
      targetUrls: ["https://a.test/x"],
      compareUrls: ["https://a.test/y"],
    });
  });

  test("omits empty or missing lists", () => {
    expect(targetedCrawlerOptions({})).toEqual({});
    expect(targetedCrawlerOptions({ targetUrls: [], compareUrls: [] })).toEqual(
      {}
    );
  });
});
