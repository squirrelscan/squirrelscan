import { describe, expect, test } from "bun:test";

import {
  COVERAGE_QUICK_MAX_PAGES,
  COVERAGE_SURFACE_MAX_PAGES,
  COVERAGE_FULL_MAX_PAGES,
  PATTERN_SAMPLED_PENALTY,
  PATTERN_SAMPLE_LIMIT,
} from "@/constants";
import { DEFAULT_CRAWLER_CONFIG } from "@/crawler/core/types";
import {
  calculatePatternPenalty,
  calculatePriorityWithSurface,
} from "@/crawler/priority";

describe("coverage mode constants", () => {
  test("has correct default page limits", () => {
    expect(COVERAGE_QUICK_MAX_PAGES).toBe(25);
    expect(COVERAGE_SURFACE_MAX_PAGES).toBe(100);
    expect(COVERAGE_FULL_MAX_PAGES).toBe(500);
  });

  test("has pattern sampling constants", () => {
    expect(PATTERN_SAMPLED_PENALTY).toBe(2000);
    expect(PATTERN_SAMPLE_LIMIT).toBe(1);
  });
});

describe("default crawler config", () => {
  test("defaults to quick mode", () => {
    expect(DEFAULT_CRAWLER_CONFIG.coverageMode).toBe("quick");
    expect(DEFAULT_CRAWLER_CONFIG.disableLinkDiscovery).toBe(false);
    // maxPages stays at the 100 sentinel; the quick coverage budget (25) is
    // applied by the audit resolver when max_pages is left unset.
    expect(DEFAULT_CRAWLER_CONFIG.maxPages).toBe(100);
  });
});

describe("pattern penalty calculation", () => {
  test("returns zero when not sampled", () => {
    expect(
      calculatePatternPenalty({
        patternCrawledCount: 0,
        patternSampleLimit: 1,
      })
    ).toBe(0);
  });

  test("returns heavy penalty when sampled", () => {
    expect(
      calculatePatternPenalty({
        patternCrawledCount: 1,
        patternSampleLimit: 1,
      })
    ).toBe(PATTERN_SAMPLED_PENALTY);
  });

  test("respects custom sample limit", () => {
    expect(
      calculatePatternPenalty({
        patternCrawledCount: 1,
        patternSampleLimit: 3,
      })
    ).toBe(0);

    expect(
      calculatePatternPenalty({
        patternCrawledCount: 3,
        patternSampleLimit: 3,
      })
    ).toBe(PATTERN_SAMPLED_PENALTY);
  });
});

describe("surface mode priority calculation", () => {
  const basePriorityFactors = {
    depth: 1,
    sitemapPriority: 0,
    incomingLinkCount: 0,
    source: "discovered" as const,
  };

  const baseBreadthFactors = {
    prefixCrawledCount: 0,
    totalPrefixes: 5,
    maxPages: 100,
    depth: 1,
    pendingDepth1Count: 0,
    maxPrefixBudgetRatio: 0.25,
  };

  test("includes pattern penalty in surface mode", () => {
    const url = "https://example.com/blog/test-post";

    // Not sampled yet
    const priorityNotSampled = calculatePriorityWithSurface(
      basePriorityFactors,
      url,
      baseBreadthFactors,
      { patternCrawledCount: 0, patternSampleLimit: 1 }
    );

    // Already sampled
    const prioritySampled = calculatePriorityWithSurface(
      basePriorityFactors,
      url,
      baseBreadthFactors,
      { patternCrawledCount: 1, patternSampleLimit: 1 }
    );

    // Sampled URLs should have much higher priority value (lower crawl priority)
    expect(prioritySampled - priorityNotSampled).toBe(PATTERN_SAMPLED_PENALTY);
  });
});
