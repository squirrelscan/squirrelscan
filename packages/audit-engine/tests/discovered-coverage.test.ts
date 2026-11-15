import { describe, expect, test } from "bun:test";
import type { FrontierRecord } from "@squirrelscan/core-contracts";
import { discoveredCoverage } from "../src/report-stream";

const row = (
  n: number,
  source: FrontierRecord["source"],
  status: FrontierRecord["status"],
): FrontierRecord => ({
  normalizedUrl: `https://example.com/p${n}`,
  rawUrl: `https://example.com/p${n}`,
  depth: 1,
  priority: 0,
  status,
  source,
  enqueuedAt: 1,
  retryCount: 0,
});

describe("discoveredCoverage", () => {
  test("a capped crawl counts pending links beyond the fetched pages", () => {
    const entries = [
      row(1, "seed", "done"),
      row(2, "sitemap", "done"),
      row(3, "discovered", "pending"),
      row(4, "discovered", "pending"),
      row(5, "sitemap", "pending"),
    ];
    expect(discoveredCoverage(entries)).toEqual({ total: 5, sitemap: 2, links: 3 });
  });

  test("skipped and failed rows are not discovered pages", () => {
    const entries = [
      row(1, "seed", "done"),
      row(2, "discovered", "skipped"),
      row(3, "sitemap", "failed"),
    ];
    expect(discoveredCoverage(entries)).toEqual({ total: 1, sitemap: 0, links: 1 });
  });
});
