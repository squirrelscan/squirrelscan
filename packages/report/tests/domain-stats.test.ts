// Domain-stats report helpers (#111): number formatting, the headline metric
// rows (present-only), the one-line summary, and the SERP position bands.

import { describe, expect, test } from "bun:test";

import type { DomainStats, DomainStatsMetrics, DomainStatsPositions } from "../src/types";
import {
  buildDomainStatsSummary,
  domainStatRows,
  formatCompact,
  formatUsd,
  positionBands,
} from "../src/domain-stats";

const positions: DomainStatsPositions = {
  pos1: 12,
  pos2_3: 0,
  pos4_10: 200,
  pos11_20: null,
  pos21_30: null,
  pos31_40: null,
  pos41_50: null,
  pos51_60: null,
  pos61_70: null,
  pos71_80: null,
  pos81_90: null,
  pos91_100: null,
};

const metrics: DomainStatsMetrics = {
  backlinks: 15234,
  referringDomains: 412,
  referringMainDomains: 388,
  referringPages: 9100,
  dofollow: 12000,
  rank: 421,
  backlinksUpdatedAt: "2026-01-02 03:04:05 +00:00",
  organicKeywords: 1820,
  organicTraffic: 54000,
  organicImpressions: 980000,
  positions,
  paidKeywords: 30,
  paidTraffic: 1200,
  paidTrafficCost: 4500,
};

const emptyMetrics: DomainStatsMetrics = {
  backlinks: null,
  referringDomains: null,
  referringMainDomains: null,
  referringPages: null,
  dofollow: null,
  rank: null,
  backlinksUpdatedAt: null,
  organicKeywords: null,
  organicTraffic: null,
  organicImpressions: null,
  positions: null,
  paidKeywords: null,
  paidTraffic: null,
  paidTrafficCost: null,
};

describe("formatCompact", () => {
  test("compacts thousands/millions/billions, trims .0", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1000)).toBe("1k");
    expect(formatCompact(1234)).toBe("1.2k");
    expect(formatCompact(1_500_000)).toBe("1.5M");
    expect(formatCompact(2_000_000_000)).toBe("2B");
  });

  test("null/non-finite render as em dash", () => {
    expect(formatCompact(null)).toBe("—");
    expect(formatCompact(undefined)).toBe("—");
    expect(formatCompact(Number.NaN)).toBe("—");
  });
});

describe("formatUsd", () => {
  test("prefixes a compacted dollar amount; null → dash", () => {
    expect(formatUsd(4500)).toBe("$4.5k");
    expect(formatUsd(null)).toBe("—");
  });
});

describe("domainStatRows", () => {
  test("includes only present metrics, in display order", () => {
    const rows = domainStatRows(metrics);
    expect(rows.map((r) => r.label)).toEqual([
      "Backlinks",
      "Ref. domains",
      "Domain rank",
      "Organic keywords",
      "Organic traffic",
      "Paid traffic",
      "Paid traffic cost",
    ]);
    expect(rows[0]).toEqual({ label: "Backlinks", value: "15.2k" });
    expect(rows.find((r) => r.label === "Domain rank")?.value).toBe("421");
    expect(rows.find((r) => r.label === "Paid traffic cost")?.value).toBe("$4.5k");
  });

  test("empty metrics produce no rows", () => {
    expect(domainStatRows(emptyMetrics)).toEqual([]);
  });
});

describe("buildDomainStatsSummary", () => {
  test("joins the headline metrics into one line", () => {
    const stats: DomainStats = { domain: "example.com", metrics, capturedAt: "2026-01-02T00:00:00Z" };
    const line = buildDomainStatsSummary(stats);
    expect(line).toContain("example.com");
    expect(line).toContain("15.2k backlinks");
    expect(line).toContain("412 referring domains");
    expect(line).toContain("1.8k organic keywords");
  });

  test("falls back to a no-data line when nothing present", () => {
    const stats: DomainStats = {
      domain: "x.com",
      metrics: emptyMetrics,
      capturedAt: "2026-01-02T00:00:00Z",
    };
    expect(buildDomainStatsSummary(stats)).toBe("No domain stats available for x.com.");
  });
});

describe("positionBands", () => {
  test("returns only non-empty bands in order", () => {
    expect(positionBands(positions)).toEqual([
      { label: "#1", count: 12 },
      { label: "#4–10", count: 200 },
    ]);
  });

  test("null positions → []", () => {
    expect(positionBands(null)).toEqual([]);
  });
});
