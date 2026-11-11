// #1074, #1656: lcp-preload is a per-page check, while JSON reports group
// matching page checks into one finding. The legacy `details.page/candidates`
// still describe one page; `details.pageEvidence` addresses every page.

import { describe, expect, test } from "bun:test";
import type { ReportRuleResult } from "@squirrelscan/core-contracts";
import { LCP_PAGE_EVIDENCE } from "@squirrelscan/core-contracts/limits";

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
          message: "Likely-LCP image loaded without preload",
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
          message: "Likely-LCP image loaded without preload",
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
      pageEvidence: [
        { page: "https://example.com/a", candidates: [{ src: "https://example.com/a.jpg", reason: "candidate" }] },
        { page: "https://example.com/b", candidates: [{ src: "https://example.com/b.jpg", reason: "candidate" }] },
      ],
      pageEvidenceOmittedPages: 0,
    });
  });

  test("each page keeps only its own image, whatever the merge order", () => {
    const check = groupIssuesByCategory({ "perf/lcp-hints": lcpResult(["z", "a"]) })[0]!.rules[0]!
      .checks[0]!;
    const evidence = check.details!.pageEvidence as { page: string; candidates: { src: string }[] }[];
    expect(evidence.map((e) => e.page)).toEqual(["https://example.com/a", "https://example.com/z"]);
    for (const entry of evidence) {
      const slug = entry.page.split("/").pop();
      expect(entry.candidates.map((c) => c.src)).toEqual([`https://example.com/${slug}.jpg`]);
    }
  });

  test("evidence stays bounded across several hundred pages", { timeout: 20_000 }, () => {
    const slugs = Array.from({ length: 400 }, (_, i) => `p${String(i).padStart(3, "0")}`);
    const check = groupIssuesByCategory({ "perf/lcp-hints": lcpResult(slugs, 10) })[0]!.rules[0]!
      .checks[0]!;
    const details = check.details as {
      pageEvidence: { page: string; candidates: unknown[] }[];
      pageEvidenceOmittedPages: number;
    };
    expect(check.pages).toHaveLength(400);
    expect(details.pageEvidence).toHaveLength(LCP_PAGE_EVIDENCE.maxPages);
    expect(details.pageEvidenceOmittedPages).toBe(400 - LCP_PAGE_EVIDENCE.maxPages);
    for (const entry of details.pageEvidence) {
      expect(entry.candidates).toHaveLength(LCP_PAGE_EVIDENCE.maxCandidatesPerPage);
    }
  });
});

function lcpResult(slugs: string[], candidatesPerPage = 1): ReportRuleResult {
  return {
    meta: {
      id: "perf/lcp-hints",
      name: "LCP Optimization Hints",
      description: "",
      category: "perf",
      scope: "page",
      severity: "warning",
      weight: 7,
    },
    checks: slugs.map((slug) => {
      const page = `https://example.com/${slug}`;
      return {
        name: "lcp-preload",
        status: "warn" as const,
        message: "Likely-LCP image loaded without preload",
        pageUrl: page,
        details: {
          page,
          candidates: Array.from({ length: candidatesPerPage }, (_, i) => ({
            src: i === 0 ? `${page}.jpg` : `${page}-${i}.jpg`,
            reason: "candidate",
          })),
          preloads: [],
          additionalPreloads: 0,
        },
      };
    }),
  };
}
