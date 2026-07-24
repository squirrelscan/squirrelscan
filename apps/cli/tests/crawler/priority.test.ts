// Tests for breadth-first priority calculation

import { describe, it, expect } from "bun:test";

import {
  CRAWL_BREADTH_DEPTH_PENALTY,
  CRAWL_BREADTH_MAX_PREFIX_PENALTY,
  CRAWL_BREADTH_PENALTY_MULTIPLIER,
} from "../../src/constants";
import {
  calculateBreadthPenalty,
  calculatePriorityWithBreadth,
  type BreadthFirstFactors,
} from "../../src/crawler/priority";

describe("calculateBreadthPenalty", () => {
  const baseFactors: BreadthFirstFactors = {
    prefixCrawledCount: 0,
    totalPrefixes: 4,
    maxPages: 50,
    depth: 1,
    pendingDepth1Count: 0,
    maxPrefixBudgetRatio: 0.25,
  };

  describe("depth-1 guarantee", () => {
    it("returns depth penalty for depth>1 when depth-1 URLs pending", () => {
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        depth: 2,
        pendingDepth1Count: 5,
      };
      expect(calculateBreadthPenalty(factors)).toBe(
        CRAWL_BREADTH_DEPTH_PENALTY
      );
    });

    it("returns 0 for depth-1 URLs even when other depth-1 pending", () => {
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        depth: 1,
        pendingDepth1Count: 5,
      };
      expect(calculateBreadthPenalty(factors)).toBe(0);
    });

    it("returns normal penalty for depth>1 when no depth-1 pending", () => {
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        depth: 2,
        pendingDepth1Count: 0,
        prefixCrawledCount: 0,
      };
      expect(calculateBreadthPenalty(factors)).toBe(0);
    });
  });

  describe("fair share calculation", () => {
    it("returns 0 when under fair share", () => {
      // maxPages=50, maxPrefixBudgetRatio=0.25 -> maxPrefixPages=12.5
      // totalPrefixes=4 -> equal share=12.5
      // fairShare = min(12.5, 12.5) = 12.5
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        prefixCrawledCount: 10,
      };
      expect(calculateBreadthPenalty(factors)).toBe(0);
    });

    it("returns 0 when exactly at fair share", () => {
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        prefixCrawledCount: 12, // slightly under 12.5
      };
      expect(calculateBreadthPenalty(factors)).toBe(0);
    });

    it("returns increasing penalty when over fair share", () => {
      // fairShare = 12.5
      // crawled 25 -> ratio = 2.0 -> (2.0-1)*multiplier
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        prefixCrawledCount: 25,
      };
      expect(calculateBreadthPenalty(factors)).toBe(
        CRAWL_BREADTH_PENALTY_MULTIPLIER
      );
    });

    it("caps penalty at max", () => {
      // fairShare = 12.5
      // crawled 50 -> ratio = 4.0 -> capped at max
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        prefixCrawledCount: 50,
      };
      expect(calculateBreadthPenalty(factors)).toBe(
        CRAWL_BREADTH_MAX_PREFIX_PENALTY
      );
    });
  });

  describe("maxPrefixBudgetRatio", () => {
    it("uses ratio to cap fair share", () => {
      // maxPages=100, maxPrefixBudgetRatio=0.1 -> maxPrefixPages=10
      // totalPrefixes=2 -> equal share=50
      // fairShare = min(10, 50) = 10
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        maxPages: 100,
        maxPrefixBudgetRatio: 0.1,
        totalPrefixes: 2,
        prefixCrawledCount: 15,
      };
      // ratio = 15/10 = 1.5 -> (1.5-1)*multiplier = 0.5*multiplier
      expect(calculateBreadthPenalty(factors)).toBe(
        Math.floor(0.5 * CRAWL_BREADTH_PENALTY_MULTIPLIER)
      );
    });

    it("uses equal distribution when smaller than ratio cap", () => {
      // maxPages=40, maxPrefixBudgetRatio=0.5 -> maxPrefixPages=20
      // totalPrefixes=10 -> equal share=4
      // fairShare = min(20, 4) = 4
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        maxPages: 40,
        maxPrefixBudgetRatio: 0.5,
        totalPrefixes: 10,
        prefixCrawledCount: 8,
      };
      // ratio = 8/4 = 2.0 -> (2.0-1)*multiplier
      expect(calculateBreadthPenalty(factors)).toBe(
        CRAWL_BREADTH_PENALTY_MULTIPLIER
      );
    });
  });

  describe("edge cases", () => {
    it("handles zero prefixes gracefully", () => {
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        totalPrefixes: 0,
        prefixCrawledCount: 5,
      };
      // totalPrefixes clamped to 1 -> equal share = 50
      // fairShare = min(12.5, 50) = 12.5
      // ratio = 5/12.5 = 0.4 -> no penalty
      expect(calculateBreadthPenalty(factors)).toBe(0);
    });

    it("handles single prefix", () => {
      const factors: BreadthFirstFactors = {
        ...baseFactors,
        totalPrefixes: 1,
        prefixCrawledCount: 20,
      };
      // equal share = 50, fairShare = min(12.5, 50) = 12.5
      // ratio = 20/12.5 = 1.6 -> (1.6-1)*multiplier = 0.6*multiplier
      expect(calculateBreadthPenalty(factors)).toBe(
        Math.floor(0.6 * CRAWL_BREADTH_PENALTY_MULTIPLIER)
      );
    });
  });
});

describe("calculatePriorityWithBreadth", () => {
  it("combines base priority with breadth penalty", () => {
    const factors = {
      depth: 1,
      incomingLinkCount: 0,
      source: "discovered" as const,
    };
    const breadthFactors: BreadthFirstFactors = {
      prefixCrawledCount: 25,
      totalPrefixes: 4,
      maxPages: 50,
      depth: 1,
      pendingDepth1Count: 0,
      maxPrefixBudgetRatio: 0.25,
    };

    const priority = calculatePriorityWithBreadth(
      factors,
      "https://example.com/news/article",
      breadthFactors
    );

    // Base priority for depth=1 discovered URL ~70 (100 - 30 path bonus)
    // Breadth penalty = 200 (from previous test)
    // Total should be around 270
    expect(priority).toBeGreaterThan(200);
    expect(priority).toBeLessThan(400);
  });

  it("adds depth-1 guarantee penalty for deep URLs", () => {
    const factors = {
      depth: 2,
      incomingLinkCount: 0,
      source: "discovered" as const,
    };
    const breadthFactors: BreadthFirstFactors = {
      prefixCrawledCount: 0,
      totalPrefixes: 4,
      maxPages: 50,
      depth: 2,
      pendingDepth1Count: 3,
      maxPrefixBudgetRatio: 0.25,
    };

    const priority = calculatePriorityWithBreadth(
      factors,
      "https://example.com/news/2024/article",
      breadthFactors
    );

    // Should include depth penalty for depth-2 while depth-1 pending
    expect(priority).toBeGreaterThan(CRAWL_BREADTH_DEPTH_PENALTY);
  });
});
