import { describe, expect, test } from "bun:test";

import { pageShare } from "../src/page-share";

describe("pageShare", () => {
  test("labels by share of the crawl", () => {
    expect(pageShare(1, 401).label).toBe("single page");
    expect(pageShare(201, 401).label).toBe("template");
    expect(pageShare(200, 401).label).toBe("some pages");
    expect(pageShare(361, 401).label).toBe("site-wide");
    expect(pageShare(360, 401).label).toBe("template");
  });

  test("carries count and ratio", () => {
    const s = pageShare(50, 200);
    expect(s).toMatchObject({ affectedPageCount: 50, crawledPages: 200, pageShare: 0.25 });
  });

  test("a one-page crawl is a single page, an empty crawl is share 0", () => {
    expect(pageShare(1, 1).label).toBe("single page");
    expect(pageShare(3, 0)).toMatchObject({ pageShare: 0, label: "some pages" });
  });
});
