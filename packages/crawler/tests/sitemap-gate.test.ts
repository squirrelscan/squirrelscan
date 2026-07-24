import { describe, expect, test } from "bun:test";
import { sitemapGateFromFrontier } from "../src/core/sitemap-gate";
import type { FrontierRecord } from "../src/storage/types";

const entry = (over: Partial<FrontierRecord>): FrontierRecord => ({
  normalizedUrl: "https://example.com/",
  rawUrl: "https://example.com/",
  depth: 0,
  priority: 0,
  status: "pending",
  source: "discovered",
  enqueuedAt: 0,
  retryCount: 0,
  ...over,
});

describe("sitemapGateFromFrontier (#133)", () => {
  test("counts sitemap URLs that passed filtering (not skipped)", () => {
    const gate = sitemapGateFromFrontier([
      entry({ source: "sitemap", status: "pending" }),
      entry({ source: "sitemap", status: "done" }), // already crawled — still counts
      entry({ source: "sitemap", status: "skipped" }), // filtered out — NOT pending
      entry({ source: "seed", status: "pending" }), // not from sitemap
      entry({ source: "discovered", status: "pending" }),
    ]);
    expect(gate.sitemapUrlCount).toBe(3); // all source="sitemap"
    expect(gate.sitemapPendingCount).toBe(2); // minus the skipped one
  });

  test("no sitemap rows → gate stays 0 (discovery falls back on)", () => {
    const gate = sitemapGateFromFrontier([
      entry({ source: "seed", status: "pending" }),
      entry({ source: "discovered", status: "done" }),
    ]);
    expect(gate.sitemapUrlCount).toBe(0);
    expect(gate.sitemapPendingCount).toBe(0);
  });

  test("all sitemap URLs skipped → pending is 0 (sitemap gave nothing crawlable)", () => {
    const gate = sitemapGateFromFrontier([
      entry({ source: "sitemap", status: "skipped" }),
      entry({ source: "sitemap", status: "skipped" }),
    ]);
    expect(gate.sitemapUrlCount).toBe(2);
    expect(gate.sitemapPendingCount).toBe(0);
  });

  test("empty frontier → zeros", () => {
    expect(sitemapGateFromFrontier([])).toEqual({
      sitemapUrlCount: 0,
      sitemapPendingCount: 0,
    });
  });
});
