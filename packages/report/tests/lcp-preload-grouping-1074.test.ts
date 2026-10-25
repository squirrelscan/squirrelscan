// #1074 — lcp-preload is a per-page check, while JSON reports group matching
// page checks into one finding. The grouped details intentionally represent one
// affected page; rule_results remain the source for every page's evidence.

import { describe, expect, test } from "bun:test";
import type { ReportRuleResult } from "@squirrelscan/core-contracts";

import { groupIssuesByCategory } from "../src/grouping";

describe("perf/lcp-hints grouped evidence (#1074)", () => {
  test("the grouped check carries one named page without stale preload counts", () => {
    const result: ReportRuleResult = {
      meta: {
        id: "perf/lcp-hints",
        name: "LCP Optimization Hints",
        description: "",
        category: "perf",
        scope: "page",
        severity: "warning",
        weight: 7,
      },
      checks: [
        {
          name: "lcp-preload",
          status: "warn",
          message: "1 likely-LCP image loaded without preload",
          pageUrl: "https://example.com/a",
          details: {
            page: "https://example.com/a",
            candidates: [{ src: "https://example.com/a.jpg", reason: "candidate" }],
            preloads: ["https://example.com/other.jpg"],
            additionalPreloads: 3,
          },
        },
        {
          name: "lcp-preload",
          status: "warn",
          message: "1 likely-LCP image loaded without preload",
          pageUrl: "https://example.com/b",
          details: {
            page: "https://example.com/b",
            candidates: [{ src: "https://example.com/b.jpg", reason: "candidate" }],
            preloads: [],
            additionalPreloads: 0,
          },
        },
      ],
    };

    const check = groupIssuesByCategory({ "perf/lcp-hints": result })[0]!.rules[0]!.checks[0]!;
    expect(check.pages).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(check.details).toEqual({
      page: "https://example.com/b",
      candidates: [{ src: "https://example.com/b.jpg", reason: "candidate" }],
      preloads: [],
      additionalPreloads: 0,
    });
  });
});
