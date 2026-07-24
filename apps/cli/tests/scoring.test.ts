// Tests for dynamic scoring

import { describe, expect, test } from "bun:test";

import type { RuleRunResult } from "../src/rules/types";

import { calculateHealthScore, deriveAuditStatus } from "../src/audit/scoring";

// Mock rule metadata for testing
const mockCoreMeta = {
  id: "core/test-rule",
  name: "Test Rule",
  description: "A test rule",
  solution: "Fix the test issue",
  category: "core" as const,
  scope: "page" as const,
  severity: "error" as const,
  weight: 10,
};

const mockA11yMeta = {
  id: "a11y/test-rule",
  name: "A11y Test Rule",
  description: "An accessibility test rule",
  solution: "Fix the accessibility issue",
  category: "a11y" as const,
  scope: "page" as const,
  severity: "warning" as const,
  weight: 5,
};

const mockLinksMeta = {
  id: "links/test-rule",
  name: "Links Test Rule",
  description: "A links test rule",
  solution: "Fix the links issue",
  category: "links" as const,
  scope: "page" as const,
  severity: "error" as const,
  weight: 8,
};

describe("calculateHealthScore", () => {
  test("returns 100 for all passing checks", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [{ name: "test", status: "pass", message: "Passed" }],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    expect(score.overall).toBe(100);
  });

  test("returns 0 for all failing checks", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [{ name: "test", status: "fail", message: "Failed" }],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    expect(score.overall).toBe(0);
  });

  test("returns 44 for all warning checks (after curve)", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [{ name: "test", status: "warn", message: "Warning" }],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    // Base score: 50, Curve: 50^1.2 = 43.5 → 44
    expect(score.overall).toBe(44);
  });

  test("weights rules correctly (with curve)", () => {
    // Core rule (weight 10) has 1 fail 1 pass, a11y rule (weight 5) fails
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [
            { name: "test1", status: "pass", message: "Passed" },
            { name: "test2", status: "fail", message: "Failed" },
          ],
        },
      ],
      [
        "a11y/test-rule",
        {
          meta: mockA11yMeta,
          checks: [{ name: "test", status: "fail", message: "Failed" }],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    // Base: 10*0.5 + 5*0 = 5, total = 15, base score = 33
    // Curve: 33^1.2 = 27
    expect(score.overall).toBe(27);
  });

  test("groups by category correctly", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [{ name: "test", status: "warn", message: "Warning" }],
        },
      ],
      [
        "a11y/test-rule",
        {
          meta: mockA11yMeta,
          checks: [{ name: "test", status: "fail", message: "Failed" }],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    expect(score.categories.length).toBe(2);
    expect(score.categories.some((c) => c.name === "Core SEO")).toBe(true);
    expect(score.categories.some((c) => c.name === "Accessibility")).toBe(true);
  });

  test("counts passed/warning/failed correctly", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [
            { name: "test1", status: "pass", message: "Passed" },
            { name: "test2", status: "warn", message: "Warning" },
            { name: "test3", status: "fail", message: "Failed" },
          ],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    expect(score.passedCount).toBe(1);
    expect(score.warningCount).toBe(1);
    expect(score.errorCount).toBe(1);
  });

  test("empty results map scores null / N-A, not 0 or a perfect 100 (#489/#586)", () => {
    // No rules ran (down/403/0-page site) ⇒ no audit happened. Must NOT read as
    // 100/A; and the score is null (N/A), not 0 — 0 reads as "audited, scored
    // zero". The failure is surfaced via AuditReport.status (#586).
    const results = new Map<string, RuleRunResult>();
    const score = calculateHealthScore({ results });
    expect(score.overall).toBeNull();
    expect(score.categories.length).toBe(0);
  });

  test("skipped checks don't affect score", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [
            { name: "test1", status: "pass", message: "Passed" },
            { name: "test2", status: "skipped", message: "Skipped" },
          ],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    expect(score.overall).toBe(100);
  });

  test("info checks don't affect score", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [
            { name: "test1", status: "pass", message: "Passed" },
            { name: "test2", status: "info", message: "Info" },
          ],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    expect(score.overall).toBe(100);
  });

  test("excludes fully-skipped rules from scoring", () => {
    // Rule with only skipped checks should be excluded
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [{ name: "test1", status: "pass", message: "Passed" }],
        },
      ],
      [
        "a11y/test-rule",
        {
          meta: mockA11yMeta,
          checks: [{ name: "test2", status: "skipped", message: "Skipped" }],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    // Only core rule counts, a11y rule excluded (weight 5 not counted)
    expect(score.overall).toBe(100);
  });

  test("applies penalty for missing robots.txt", () => {
    const mockRobotsMeta = {
      id: "crawl/robots-txt",
      name: "Robots.txt",
      description: "Robots.txt check",
      solution: "Add robots.txt",
      category: "crawl" as const,
      scope: "site" as const,
      severity: "warning" as const,
      weight: 8,
    };

    const results = new Map<string, RuleRunResult>([
      [
        "crawl/robots-txt",
        {
          meta: mockRobotsMeta,
          checks: [
            {
              name: "robots-txt-exists",
              status: "warn",
              message: "robots.txt not found",
            },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });
    // Base: 50 (warn = 0.5), Curve: 50^1.2 = 44, Penalty: 15% reduction, Overall: 44 × 0.85 = 37
    expect(score.overall).toBe(37);
  });

  test("applies penalty for robots blocking all", () => {
    const mockRobotsMeta = {
      id: "crawl/robots-txt",
      name: "Robots.txt",
      description: "Robots.txt check",
      solution: "Fix robots.txt",
      category: "crawl" as const,
      scope: "site" as const,
      severity: "error" as const,
      weight: 8,
    };

    const results = new Map<string, RuleRunResult>([
      [
        "crawl/robots-txt",
        {
          meta: mockRobotsMeta,
          checks: [
            {
              name: "robots-txt-disallow",
              status: "fail",
              message: "robots.txt blocks all",
            },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });
    // Base: 0 (failed), Curve: 0, Penalty: -40, Overall: 0 (max with 0)
    expect(score.overall).toBe(0);
  });

  test("applies penalty for missing sitemap", () => {
    const mockSitemapMeta = {
      id: "crawl/sitemap-exists",
      name: "Sitemap Exists",
      description: "Sitemap check",
      solution: "Add sitemap",
      category: "crawl" as const,
      scope: "site" as const,
      severity: "error" as const,
      weight: 10,
    };

    const results = new Map<string, RuleRunResult>([
      [
        "crawl/sitemap-exists",
        {
          meta: mockSitemapMeta,
          checks: [
            {
              name: "sitemap-exists",
              status: "fail",
              message: "No sitemap found",
            },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });
    // Base: 0 (failed), Curve: 0, Penalty: -25, Overall: 0 (max with 0)
    expect(score.overall).toBe(0);
  });

  test("applies scoring curve to compress high scores", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: { ...mockCoreMeta, weight: 10 },
          checks: [
            { name: "test1", status: "pass", message: "Passed" },
            { name: "test2", status: "pass", message: "Passed" },
            { name: "test3", status: "pass", message: "Passed" },
            { name: "test4", status: "pass", message: "Passed" },
            { name: "test5", status: "warn", message: "Warning" },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });
    // Base: (4 + 0.5) / 5 = 0.9 = 90%
    // Curve: 90^1.2 = 88
    expect(score.overall).toBe(88);
  });

  test("combines curve and penalties correctly", () => {
    const mockRobotsMeta = {
      id: "crawl/robots-txt",
      name: "Robots.txt",
      description: "Robots.txt check",
      solution: "Add robots.txt",
      category: "crawl" as const,
      scope: "site" as const,
      severity: "warning" as const,
      weight: 8,
    };

    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [
            { name: "test1", status: "pass", message: "Passed" },
            { name: "test2", status: "warn", message: "Warning" },
          ],
        },
      ],
      [
        "crawl/robots-txt",
        {
          meta: mockRobotsMeta,
          checks: [
            {
              name: "robots-txt-exists",
              status: "warn",
              message: "robots.txt not found",
            },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });
    // Base: (10*0.75 + 8*0.5) / 18 = 64%
    // Curve: 64^1.2 = 58
    // Penalty: 15% reduction (missing robots)
    // Overall: 58 × 0.85 = 49
    expect(score.overall).toBe(49);
  });

  test("does not apply penalty for robots.txt with info status", () => {
    const mockRobotsMeta = {
      id: "crawl/robots-txt",
      name: "Robots.txt",
      description: "Robots.txt check",
      solution: "Check robots.txt",
      category: "crawl" as const,
      scope: "site" as const,
      severity: "warning" as const,
      weight: 8,
    };

    const results = new Map<string, RuleRunResult>([
      [
        "crawl/robots-txt",
        {
          meta: mockRobotsMeta,
          checks: [
            {
              name: "robots-txt-exists",
              status: "info",
              message: "Data not available",
            },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });
    // Info status is excluded from scoring, no penalty applied
    expect(score.overall).toBe(100);
  });

  test("applies cumulative penalties for multiple failures", () => {
    const mockRobotsMeta = {
      id: "crawl/robots-txt",
      name: "Robots.txt",
      description: "Robots.txt check",
      solution: "Fix robots.txt",
      category: "crawl" as const,
      scope: "site" as const,
      severity: "error" as const,
      weight: 8,
    };

    const mockSitemapMeta = {
      id: "crawl/sitemap-exists",
      name: "Sitemap Exists",
      description: "Sitemap check",
      solution: "Add sitemap",
      category: "crawl" as const,
      scope: "site" as const,
      severity: "error" as const,
      weight: 10,
    };

    const results = new Map<string, RuleRunResult>([
      [
        "crawl/robots-txt",
        {
          meta: mockRobotsMeta,
          checks: [
            {
              name: "robots-txt-disallow",
              status: "fail",
              message: "robots.txt blocks all",
            },
          ],
        },
      ],
      [
        "crawl/sitemap-exists",
        {
          meta: mockSitemapMeta,
          checks: [
            {
              name: "sitemap-exists",
              status: "fail",
              message: "No sitemap found",
            },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });
    // Base: 0 (both failed), Curve: 0
    // Penalties: 50% (robots blocks all) × 20% (no sitemap) = 60% total reduction
    // Multiplier: (1 - 0.50) × (1 - 0.20) = 0.40
    // Overall: 0 × 0.40 = 0
    expect(score.overall).toBe(0);
    // Verify penalties are tracked in debug (on 0 score, penalty is 0)
    expect(score.debug?.penalties).toBe(0);
  });

  test("exposes debug breakdown in score", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: { ...mockCoreMeta, weight: 10 },
          checks: [
            { name: "test1", status: "pass", message: "Passed" },
            { name: "test2", status: "warn", message: "Warning" },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });
    // Base: (1 + 0.5) / 2 = 0.75 = 75%
    // Curve: 75^1.2 = 71
    expect(score.debug).toBeDefined();
    expect(score.debug?.base).toBe(75);
    expect(score.debug?.curved).toBe(71);
    expect(score.debug?.penalties).toBe(0);
    expect(score.debug?.issuePenalty).toBe(0);
    expect(score.overall).toBe(71);
  });

  test("applies issue density penalty when many warnings/fails", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: { ...mockCoreMeta, weight: 10 },
          checks: [
            // 10 pass
            ...Array.from({ length: 10 }, (_, i) => ({
              name: `pass-${i}`,
              status: "pass" as const,
              message: "Passed",
            })),
            // 50 warnings
            ...Array.from({ length: 50 }, (_, i) => ({
              name: `warn-${i}`,
              status: "warn" as const,
              message: "Warning",
            })),
            // 10 fails
            ...Array.from({ length: 10 }, (_, i) => ({
              name: `fail-${i}`,
              status: "fail" as const,
              message: "Failed",
            })),
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });
    // Base: (10*1 + 50*0.5 + 10*0) / 70 = 0.5 = 50%
    // Curve: 50^1.2 = 44
    // Issue penalty: weighted issues = 10*2 + 50*1 = 70
    // Density = 70 / 70 = 1 → capped at 45% deduction
    // Overall: 44 × 0.55 = 24
    expect(score.overall).toBe(24);
    expect(score.debug?.issuePenalty).toBe(20);
    expect(score.debug?.issueDensity).toBe(45);
  });

  test("filters out categories with only skipped rules", () => {
    const mockVideoMeta = {
      id: "video/test-rule",
      name: "Video Test Rule",
      description: "A video test rule",
      solution: "Add video content",
      category: "video" as const,
      scope: "page" as const,
      severity: "info" as const,
      weight: 5,
    };

    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: { ...mockCoreMeta, category: "core" },
          checks: [{ name: "test", status: "fail", message: "Failed" }],
        },
      ],
      [
        "video/test-rule",
        {
          meta: mockVideoMeta,
          checks: [{ name: "test", status: "info", message: "No video" }],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });

    // Only Core SEO should appear, Video should be filtered
    expect(score.categories.length).toBe(1);
    expect(score.categories[0].name).toBe("Core SEO");
    expect(score.categories.find((c) => c.name === "Video")).toBeUndefined();
  });

  test("sorts categories by error count", () => {
    const mockLinksMeta = {
      id: "links/test-rule",
      name: "Links Test Rule",
      description: "A links test rule",
      solution: "Fix links",
      category: "links" as const,
      scope: "page" as const,
      severity: "error" as const,
      weight: 10,
    };

    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: { ...mockCoreMeta, category: "core" },
          checks: [
            { name: "test1", status: "fail", message: "Failed" },
            { name: "test2", status: "fail", message: "Failed" },
          ],
        },
      ],
      [
        "links/test-rule",
        {
          meta: mockLinksMeta,
          checks: [
            { name: "test1", status: "fail", message: "Failed" },
            { name: "test2", status: "warn", message: "Warning" },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });

    // Should be sorted by error count: Core (2 errors) > Links (1 error)
    expect(score.categories.length).toBe(2);
    expect(score.categories[0].name).toBe("Core SEO");
    expect(score.categories[0].failed).toBe(2);
    expect(score.categories[1].name).toBe("Links");
    expect(score.categories[1].failed).toBe(1);
  });

  test("sorts by warnings when error counts equal", () => {
    const mockLinksMeta = {
      id: "links/test-rule",
      name: "Links Test Rule",
      description: "A links test rule",
      solution: "Fix links",
      category: "links" as const,
      scope: "page" as const,
      severity: "warning" as const,
      weight: 10,
    };

    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: { ...mockCoreMeta, category: "core" },
          checks: [
            { name: "test1", status: "fail", message: "Failed" },
            { name: "test2", status: "warn", message: "Warning" },
            { name: "test3", status: "warn", message: "Warning" },
          ],
        },
      ],
      [
        "links/test-rule",
        {
          meta: mockLinksMeta,
          checks: [
            { name: "test1", status: "fail", message: "Failed" },
            { name: "test2", status: "warn", message: "Warning" },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });

    // Same errors (1 each), but Core has more warnings (2 vs 1)
    expect(score.categories[0].name).toBe("Core SEO");
    expect(score.categories[0].warnings).toBe(2);
    expect(score.categories[1].name).toBe("Links");
    expect(score.categories[1].warnings).toBe(1);
  });

  test("handles all rules skipped across all categories", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/test-rule",
        {
          meta: mockCoreMeta,
          checks: [
            { name: "test1", status: "skipped", message: "Skipped" },
            { name: "test2", status: "info", message: "Info" },
          ],
        },
      ],
      [
        "links/test-rule",
        {
          meta: mockLinksMeta,
          checks: [{ name: "test3", status: "skipped", message: "Skipped" }],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });

    // All checks skipped - should return 100% score
    expect(score.overall).toBe(100);
    expect(score.categories.length).toBe(0); // No scoreable categories
  });

  test("handles extreme penalty values safely", () => {
    const mockRobotsMeta = {
      id: "crawl/robots-txt",
      name: "Robots.txt",
      description: "Robots.txt check",
      solution: "Add robots.txt",
      category: "crawl" as const,
      scope: "site" as const,
      severity: "error" as const,
      weight: 8,
    };

    const mockSitemapMeta = {
      id: "crawl/sitemap-exists",
      name: "Sitemap Exists",
      description: "Sitemap check",
      solution: "Add sitemap",
      category: "crawl" as const,
      scope: "site" as const,
      severity: "error" as const,
      weight: 8,
    };

    const results = new Map<string, RuleRunResult>([
      [
        "crawl/robots-txt",
        {
          meta: mockRobotsMeta,
          checks: [
            {
              name: "robots-txt-exists",
              status: "warn",
              message: "No robots.txt found",
            },
            {
              name: "robots-txt-disallow",
              status: "fail",
              message: "Robots blocks all",
            },
          ],
        },
      ],
      [
        "crawl/sitemap-exists",
        {
          meta: mockSitemapMeta,
          checks: [
            {
              name: "sitemap-exists",
              status: "fail",
              message: "No sitemap found",
            },
          ],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });

    // With all 3 penalties applied multiplicatively
    // Base: (8*0.25 + 8*0) / 16 = 12.5% (robots has 1 warn + 1 fail = 0.5/2 = 0.25)
    // Curve: 12.5^1.2 = 9
    // Penalties: (1-0.15) × (1-0.50) × (1-0.20) = 0.34
    // Overall: 9 × 0.34 = 3
    expect(score.overall).toBe(3);
    expect(score.overall).toBeGreaterThanOrEqual(0); // Score never goes below 0
  });
});

describe("group scores (#626)", () => {
  const meta = (id: string, category: string, weight = 10) => ({
    id,
    name: id,
    description: "d",
    solution: "s",
    category: category as never,
    scope: "page" as const,
    severity: "error" as const,
    weight,
  });

  test("aggregates categories into their top-level groups", () => {
    const results = new Map<string, RuleRunResult>([
      // seo group: core (1 pass, 1 fail) + links (1 warn)
      [
        "core/x",
        {
          meta: meta("core/x", "core", 10),
          checks: [
            { name: "a", status: "pass", message: "" },
            { name: "b", status: "fail", message: "" },
          ],
        },
      ],
      [
        "links/x",
        {
          meta: meta("links/x", "links", 5),
          checks: [{ name: "a", status: "warn", message: "" }],
        },
      ],
      // security group
      [
        "security/x",
        {
          meta: meta("security/x", "security", 10),
          checks: [{ name: "a", status: "warn", message: "" }],
        },
      ],
      // performance group
      [
        "perf/x",
        {
          meta: meta("perf/x", "perf", 10),
          checks: [{ name: "a", status: "pass", message: "" }],
        },
      ],
      // ai group
      [
        "ax/x",
        {
          meta: meta("ax/x", "ax", 10),
          checks: [{ name: "a", status: "fail", message: "" }],
        },
      ],
    ]);

    const score = calculateHealthScore({ results });
    const groups = score.groups ?? [];

    // Display order is fixed: seo, performance, security, ai (GROUP_CODES).
    expect(groups.map((g) => g.group)).toEqual([
      "seo",
      "performance",
      "security",
      "ai",
    ]);

    const byId = Object.fromEntries(groups.map((g) => [g.group, g]));

    // A group's counts equal the SUM of its categories' counts.
    expect(byId.seo).toMatchObject({
      passed: 1,
      warnings: 1,
      failed: 1,
      total: 3,
    });
    expect(byId.performance).toMatchObject({
      passed: 1,
      warnings: 0,
      failed: 0,
      total: 1,
    });
    expect(byId.security).toMatchObject({
      passed: 0,
      warnings: 1,
      failed: 0,
      total: 1,
    });
    expect(byId.ai).toMatchObject({
      passed: 0,
      warnings: 0,
      failed: 1,
      total: 1,
    });

    // Scores stay in range and use the same pass-ratio + curve as a category:
    // seo base = (10*0.5 + 5*0.5)/15 = 50% → curve 50^1.2 ≈ 44.
    for (const g of groups) {
      expect(g.score).toBeGreaterThanOrEqual(0);
      expect(g.score).toBeLessThanOrEqual(100);
    }
    expect(byId.seo.score).toBe(44);
    // performance: all pass → 100.
    expect(byId.performance.score).toBe(100);

    // Names come from the group display map.
    expect(byId.ai.name).toBe("Agents");
  });

  test("a group's counts equal the sum of its member categories' counts", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/x",
        {
          meta: meta("core/x", "core"),
          checks: [{ name: "a", status: "fail", message: "" }],
        },
      ],
      [
        "a11y/x",
        {
          meta: meta("a11y/x", "a11y"),
          checks: [{ name: "a", status: "warn", message: "" }],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    const seo = (score.groups ?? []).find((g) => g.group === "seo");
    const seoCats = score.categories.filter((c) =>
      ["core", "a11y"].includes(c.category)
    );
    const sum = (k: "passed" | "warnings" | "failed") =>
      seoCats.reduce((n, c) => n + c[k], 0);
    expect(seo?.passed).toBe(sum("passed"));
    expect(seo?.warnings).toBe(sum("warnings"));
    expect(seo?.failed).toBe(sum("failed"));
  });

  test("empty results → no groups (N/A audit)", () => {
    const score = calculateHealthScore({ results: new Map() });
    expect(score.groups).toEqual([]);
  });
});

describe("item-aware group/category density penalty (#683)", () => {
  const meta = (id: string, category: string, weight = 10) => ({
    id,
    name: id,
    description: "d",
    solution: "s",
    category: category as never,
    scope: "page" as const,
    severity: "error" as const,
    weight,
  });

  // n pass checks + fail checks carrying `items` element-level violations each.
  const passChecks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `pass-${i}`,
      status: "pass" as const,
      message: "ok",
    }));
  const failChecks = (count: number, itemsPer: number) =>
    Array.from({ length: count }, (_, i) => ({
      name: `fail-${i}`,
      status: "fail" as const,
      message: "bad",
      items: Array.from({ length: itemsPer }, (_, j) => ({
        id: `p${i}-e${j}`,
      })),
    }));
  const warnChecks = (count: number, itemsPer: number) =>
    Array.from({ length: count }, (_, i) => ({
      name: `warn-${i}`,
      status: "warn" as const,
      message: "meh",
      items: Array.from({ length: itemsPer }, (_, j) => ({
        id: `p${i}-w${j}`,
      })),
    }));

  const seoGroup = (score: ReturnType<typeof calculateHealthScore>) =>
    (score.groups ?? []).find((g) => g.group === "seo");
  const cat = (score: ReturnType<typeof calculateHealthScore>, c: string) =>
    score.categories.find((x) => x.category === c);

  test("~100 element-level errors over ~2600 passing checks → amber (70s), not green", () => {
    // a11y rolls into the seo group. 25 failed checks × 4 element violations
    // = 100 exploded errors, the shape from report 01KWNJ18KR5N4MWH8016QB2V3F
    // (SEO circle read 95 next to "100 errors").
    const results = new Map<string, RuleRunResult>([
      [
        "a11y/x",
        {
          meta: meta("a11y/x", "a11y", 10),
          checks: [...passChecks(2600), ...failChecks(25, 4)],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    const seo = seoGroup(score)!;
    // Pre-#683 this scored ~95 (green). Now item-aware → ~77 (amber).
    expect(seo.score).toBeLessThan(90);
    expect(seo.score).toBeGreaterThanOrEqual(70);
    expect(seo.score).toBeLessThan(85);
    expect(seo.failed).toBe(25); // display count stays check-level
    // Category score stays consistent with the group (same local counts).
    expect(cat(score, "a11y")!.score).toBe(seo.score);
  });

  test("16 errors on a 10-page site → below 90", () => {
    // ~250 passing checks (25/page × 10) + 16 single-item fails.
    const results = new Map<string, RuleRunResult>([
      [
        "core/x",
        {
          meta: meta("core/x", "core", 10),
          checks: [...passChecks(250), ...failChecks(16, 1)],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    const seo = seoGroup(score)!;
    expect(seo.score).toBeLessThan(90);
    expect(seo.score).toBeGreaterThan(0);
  });

  test("a clean bucket still scores 100", () => {
    const results = new Map<string, RuleRunResult>([
      ["core/x", { meta: meta("core/x", "core", 10), checks: passChecks(500) }],
    ]);
    const score = calculateHealthScore({ results });
    expect(seoGroup(score)!.score).toBe(100);
    expect(cat(score, "core")!.score).toBe(100);
  });

  test("1-2 trivial warnings stay green", () => {
    const results = new Map<string, RuleRunResult>([
      [
        "core/x",
        {
          meta: meta("core/x", "core", 10),
          checks: [...passChecks(200), ...warnChecks(2, 1)],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    // 2 issue units < threshold → no density penalty.
    expect(seoGroup(score)!.score).toBeGreaterThanOrEqual(90);
  });

  test("threshold/scale tuning is pinned: 12 item-less fails trip the penalty (old threshold 20 would not)", () => {
    // Guards the #683 constants re-tune (ISSUE_PENALTY_THRESHOLD 20→10,
    // SCALE 2→3) against accidental revert, independent of item-awareness.
    const results = new Map<string, RuleRunResult>([
      [
        "core/x",
        {
          meta: meta("core/x", "core", 10),
          checks: [...passChecks(288), ...failChecks(12, 1)],
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    // 12 units ≥ threshold 10 → penalized: density 24/300 × 3 = 24% off the
    // curved ~95 → ~72 amber. Under the old 20/2.0 tuning this stayed ~95 green.
    expect(seoGroup(score)!.score).toBeLessThan(80);
    expect(seoGroup(score)!.score).toBeGreaterThanOrEqual(65);
    expect(score.overall!).toBeLessThan(80);
  });

  test("warnings are check-level: a zero-error bucket with many-item warnings doesn't go red", () => {
    // Real-world shape: 4 CSP-style warnings each carrying ~20 items across
    // pages. Item-aware warns made this bucket read 43% red; warns must count
    // 1 unit per distinct (check, page) so item volume only matters for FAILS.
    const build = (itemsPer: number) =>
      seoGroup(
        calculateHealthScore({
          results: new Map<string, RuleRunResult>([
            [
              "core/x",
              {
                meta: meta("core/x", "core", 10),
                checks: [...passChecks(200), ...warnChecks(4, itemsPer)],
              },
            ],
          ]),
        })
      )!.score;
    // 4 warn units either way — below threshold, identical score, no penalty.
    expect(build(20)).toBe(build(1));
    expect(build(20)).toBeGreaterThanOrEqual(90);
  });

  test("item volume moves the score: 1 fail w/ 50 items hurts far more than 1 fail w/ 1 item", () => {
    const build = (itemsPer: number) =>
      calculateHealthScore({
        results: new Map<string, RuleRunResult>([
          [
            "core/x",
            {
              meta: meta("core/x", "core", 10),
              checks: [...passChecks(200), ...failChecks(1, itemsPer)],
            },
          ],
        ]),
      });
    const trivial = seoGroup(build(1))!.score; // 1 unit < threshold → no penalty
    const heavy = seoGroup(build(50))!.score; // 50 items (capped 20) → penalized
    expect(trivial).toBeGreaterThanOrEqual(90);
    expect(heavy).toBeLessThan(trivial);
    expect(heavy).toBeLessThan(90);
    // Both checks are a single fail — pre-#683 they scored identically.
  });

  test("per-check item cap: 50 items and 500 items on one check score the same", () => {
    const build = (itemsPer: number) =>
      seoGroup(
        calculateHealthScore({
          results: new Map<string, RuleRunResult>([
            [
              "core/x",
              {
                meta: meta("core/x", "core", 10),
                checks: [...passChecks(200), ...failChecks(1, itemsPer)],
              },
            ],
          ]),
        })
      )!.score;
    // Both saturate the ISSUE_PENALTY_ITEM_CAP — one page can't zero the group.
    expect(build(50)).toBe(build(500));
  });

  test("item cap is per (check, page): a smart-audit carried explosion caps like a fresh multi-item check", () => {
    // 25 element violations of one check on one page. `flattenChecks` stores
    // these as 25 finding rows; `buildScoringResultsFromMerged` replays them as
    // 25 single-item checks sharing (name, pageUrl). The cap must apply to that
    // GROUP, so its density contribution matches the fresh multi-item form and a
    // partial re-audit doesn't tank the score. Base pass-ratio is held equal
    // (same 25 fail checks, 300 pass) to isolate the density component.
    const sameName = (pageUrl: string) =>
      Array.from({ length: 25 }, (_, i) => ({
        name: "img-alt",
        status: "fail" as const,
        message: "missing alt",
        pageUrl,
        items: [{ id: `${pageUrl}-e${i}` }],
      }));
    // Concentrated: 25 carried single-item fails, all on page "p" → capped at 20.
    const concentrated = seoGroup(
      calculateHealthScore({
        results: new Map<string, RuleRunResult>([
          [
            "core/x",
            {
              meta: meta("core/x", "core", 10),
              checks: [...passChecks(300), ...sameName("https://x/p")],
            },
          ],
        ]),
      })
    )!.score;
    // Spread: 25 fails across 25 distinct pages → 25 keys, no per-group cap.
    const spread = seoGroup(
      calculateHealthScore({
        results: new Map<string, RuleRunResult>([
          [
            "core/x",
            {
              meta: meta("core/x", "core", 10),
              checks: [
                ...passChecks(300),
                ...Array.from({ length: 25 }, (_, i) => ({
                  name: "img-alt",
                  status: "fail" as const,
                  message: "missing alt",
                  pageUrl: `https://x/p${i}`,
                  items: [{ id: `p${i}-e` }],
                })),
              ],
            },
          ],
        ]),
      })
    )!.score;
    // Same base (25 fails / 300 pass); the concentrated page's cap makes its
    // density penalty lighter, so it scores strictly higher.
    expect(concentrated).toBeGreaterThan(spread);
  });

  test("details.additional counts toward fail units (rules truncate items to ~10)", () => {
    // button-name-style truncation: 50 unnamed buttons → 10 items + additional: 40.
    // Must weigh like the untruncated 50-item form (both saturate the 20 cap),
    // not like a 10-item check.
    const build = (checks: RuleRunResult["checks"]) =>
      seoGroup(
        calculateHealthScore({
          results: new Map<string, RuleRunResult>([
            [
              "core/x",
              {
                meta: meta("core/x", "core", 10),
                checks: [...passChecks(200), ...checks],
              },
            ],
          ]),
        })
      )!.score;
    const truncated = build([
      {
        name: "button-name",
        status: "fail" as const,
        message: "bad",
        items: Array.from({ length: 10 }, (_, i) => ({ id: `e${i}` })),
        details: { additional: 40 },
      },
    ]);
    const full = build([
      {
        name: "button-name",
        status: "fail" as const,
        message: "bad",
        items: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}` })),
      },
    ]);
    const tenOnly = build([
      {
        name: "button-name",
        status: "fail" as const,
        message: "bad",
        items: Array.from({ length: 10 }, (_, i) => ({ id: `e${i}` })),
      },
    ]);
    expect(truncated).toBe(full);
    expect(truncated).toBeLessThan(tenOnly);
  });

  test("additional is a per-key MAX, not a per-check sum (carried rows copy the original details)", () => {
    // Carried form: flattenChecks replays one row per item, EACH copying the
    // original check's details.additional. Summing would count the remainder
    // once per row; the max makes 10 carried rows ≡ the fresh truncated check.
    const rows = (additionalOn: (i: number) => number | undefined) =>
      Array.from({ length: 10 }, (_, i) => ({
        name: "img-alt",
        status: "fail" as const,
        message: "missing alt",
        pageUrl: "https://x/p",
        items: [{ id: `e${i}` }],
        ...(additionalOn(i) !== undefined
          ? { details: { additional: additionalOn(i) } }
          : {}),
      }));
    const build = (checks: RuleRunResult["checks"]) =>
      seoGroup(
        calculateHealthScore({
          results: new Map<string, RuleRunResult>([
            [
              "core/x",
              {
                meta: meta("core/x", "core", 10),
                checks: [...passChecks(200), ...checks],
              },
            ],
          ]),
        })
      )!.score;
    const everyRow = build(rows(() => 40)); // carried replay: all 10 rows carry additional 40
    const oneRow = build(rows((i) => (i === 0 ? 40 : undefined)));
    const smallExtra = build(rows(() => 4)); // max 4 → 14 units, under the cap
    expect(everyRow).toBe(oneRow); // max, not sum — same 50-unit key either way
    expect(smallExtra).toBeGreaterThan(everyRow); // lighter remainder → lighter penalty
  });

  test("overall stays consistent: a group full of errors is not green while overall is low", () => {
    const results = new Map<string, RuleRunResult>([
      // seo group: heavy element-level errors
      [
        "a11y/x",
        {
          meta: meta("a11y/x", "a11y", 10),
          checks: [...passChecks(2600), ...failChecks(25, 4)],
        },
      ],
      // security group: clean
      [
        "security/x",
        {
          meta: meta("security/x", "security", 10),
          checks: passChecks(300),
        },
      ],
    ]);
    const score = calculateHealthScore({ results });
    const seo = seoGroup(score)!;
    const security = (score.groups ?? []).find((g) => g.group === "security")!;
    expect(seo.score).toBeLessThan(90); // no longer green
    expect(security.score).toBe(100); // clean group unaffected
    // Overall (item-aware density) tracks the errors — not green either.
    expect(score.overall!).toBeLessThan(90);
  });
});

describe("deriveAuditStatus (#489)", () => {
  test("0 pages crawled → failed", () => {
    const r = deriveAuditStatus({
      pagesCrawled: 0,
      contentPages: 0,
      blockedPages: 0,
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBeTruthy();
  });

  test("all pages blocked (403/bot-wall), no content → blocked", () => {
    const r = deriveAuditStatus({
      pagesCrawled: 3,
      contentPages: 0,
      blockedPages: 3,
    });
    expect(r.status).toBe("blocked");
  });

  test("walled root: 0 pages but a blocked fetch (403/429) → blocked, not failed (#792)", () => {
    const r = deriveAuditStatus({
      pagesCrawled: 0,
      contentPages: 0,
      blockedPages: 0,
      blockedErrors: 1,
    });
    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("blocked the crawler");
  });

  test("0 pages with no blocks (unreachable/DNS/timeout) → still failed (#792)", () => {
    const r = deriveAuditStatus({
      pagesCrawled: 0,
      contentPages: 0,
      blockedPages: 0,
      blockedErrors: 0,
    });
    expect(r.status).toBe("failed");
  });

  test("pages crawled but none returned content (errors, not blocks) → failed", () => {
    const r = deriveAuditStatus({
      pagesCrawled: 2,
      contentPages: 0,
      blockedPages: 0,
    });
    expect(r.status).toBe("failed");
  });

  test("normal crawl with content → completed (no reason)", () => {
    const r = deriveAuditStatus({
      pagesCrawled: 10,
      contentPages: 10,
      blockedPages: 0,
    });
    expect(r.status).toBe("completed");
    expect(r.reason).toBeUndefined();
  });

  test("a few blocked pages but content present → still completed (no false failure)", () => {
    // A healthy site with one 403 path (e.g. /admin) must not be marked failed.
    const r = deriveAuditStatus({
      pagesCrawled: 12,
      contentPages: 11,
      blockedPages: 1,
    });
    expect(r.status).toBe("completed");
  });
});
