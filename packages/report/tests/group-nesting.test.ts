// #626 — top-level rule groups. Covers the group-nesting seam
// (groupCategoriesByGroup) shared by every renderer, plus renderer-level
// assertions that group scores + group labels actually surface.

import { describe, expect, test } from "bun:test";
import type { AuditReport, ReportRuleResult } from "../src/types";

import { groupIssuesByCategory, groupCategoriesByGroup } from "../src/grouping";
import { GROUP_CODES } from "../src/categories";
import { GROUP_COLORS } from "../src/scoring";
import { renderJson } from "../src/output/json";
import { renderText } from "../src/output/text";
import { renderHtml } from "../src/output/html";
import { renderMarkdown } from "../src/output/markdown";

function rule(id: string, category: string, checks: ReportRuleResult["checks"]): ReportRuleResult {
  return {
    meta: { id, name: id, description: "", category, scope: "page", severity: "error", weight: 5 },
    checks,
  };
}

const fail = (msg: string) => ({ name: "c", status: "fail" as const, message: msg });
const warn = (msg: string) => ({ name: "c", status: "warn" as const, message: msg });

// Categories spanning all four groups: core+links -> seo, perf -> performance,
// security -> security, ax -> ai.
function issuesAcrossGroups(): Record<string, ReportRuleResult> {
  return {
    "core/x": rule("core/x", "core", [fail("missing title")]),
    "links/x": rule("links/x", "links", [warn("slow link")]),
    "perf/x": rule("perf/x", "perf", [fail("slow LCP")]),
    "security/x": rule("security/x", "security", [warn("no CSP")]),
    "ax/x": rule("ax/x", "ax", [warn("no llms.txt")]),
  };
}

describe("groupCategoriesByGroup (#626)", () => {
  test("buckets categories under their group, in GROUP_CODES order", () => {
    const categories = groupIssuesByCategory(issuesAcrossGroups());
    const groups = groupCategoriesByGroup(categories);

    // Only groups with ≥1 category, emitted in canonical display order.
    expect(groups.map((g) => g.code)).toEqual(["seo", "performance", "security", "ai"]);
    expect(groups.map((g) => g.code)).toEqual(
      GROUP_CODES.filter((c) => groups.some((g) => g.code === c)),
    );

    const seo = groups.find((g) => g.code === "seo")!;
    expect(seo.categories.map((c) => c.code).sort()).toEqual(["core", "links"]);
    expect(groups.find((g) => g.code === "performance")!.categories.map((c) => c.code)).toEqual([
      "perf",
    ]);
    expect(groups.find((g) => g.code === "ai")!.categories.map((c) => c.code)).toEqual(["ax"]);
  });

  test("places every category exactly once", () => {
    const categories = groupIssuesByCategory(issuesAcrossGroups());
    const groups = groupCategoriesByGroup(categories);
    const placed = groups.flatMap((g) => g.categories.map((c) => c.code)).sort();
    expect(placed).toEqual(categories.map((c) => c.code).sort());
    expect(placed.length).toBe(categories.length); // no category in two groups
  });

  test("aggregates fail/warn counts from member categories", () => {
    const categories = groupIssuesByCategory(issuesAcrossGroups());
    const groups = groupCategoriesByGroup(categories);
    const seo = groups.find((g) => g.code === "seo")!;
    const seoCats = seo.categories;
    expect(seo.failCount).toBe(seoCats.reduce((n, c) => n + c.failCount, 0));
    expect(seo.warnCount).toBe(seoCats.reduce((n, c) => n + c.warnCount, 0));
    // core has 1 fail, links has 1 warn.
    expect(seo.failCount).toBe(1);
    expect(seo.warnCount).toBe(1);
  });

  test("empty input → no groups", () => {
    expect(groupCategoriesByGroup([])).toEqual([]);
  });
});

// A report carrying both the rolled-up group scores (for the score display) and
// the issues (for the group-nested issue sections).
function reportWithGroups(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-07-03T00:00:00.000Z",
    totalPages: 3,
    passed: 0,
    warnings: 3,
    failed: 2,
    ruleResults: issuesAcrossGroups(),
    healthScore: {
      overall: 56,
      categories: [],
      groups: [
        { group: "seo", name: "SEO", score: 49, passed: 0, warnings: 1, failed: 1, total: 2 },
        {
          group: "performance",
          name: "Performance",
          score: 22,
          passed: 0,
          warnings: 0,
          failed: 1,
          total: 1,
        },
        {
          group: "security",
          name: "Security",
          score: 78,
          passed: 0,
          warnings: 1,
          failed: 0,
          total: 1,
        },
        {
          group: "ai",
          name: "AI Readiness",
          score: 67,
          passed: 0,
          warnings: 1,
          failed: 0,
          total: 1,
        },
      ],
      errorCount: 2,
      warningCount: 3,
      passedCount: 0,
    },
  } as unknown as AuditReport;
}

describe("renderers surface groups (#626)", () => {
  test("json: score.groups[] is populated and each issue carries a group code", () => {
    const parsed = JSON.parse(renderJson(reportWithGroups()));
    // Names derive from the group CODE (the fixture stores the pre-rename
    // "AI Readiness"), so renames apply to already-stored reports.
    expect(parsed.score.groups.map((g: { name: string }) => g.name)).toEqual([
      "SEO",
      "Performance",
      "Security",
      "Agents",
    ]);
    expect(parsed.score.groups[0]).toMatchObject({ group: "seo", score: 49 });
    // Every issue is labelled with its group code.
    expect(parsed.issues.length).toBeGreaterThan(0);
    for (const issue of parsed.issues) {
      expect(["seo", "performance", "security", "ai"]).toContain(issue.group);
    }
    expect(parsed.issues.find((i: { ruleId: string }) => i.ruleId === "ax/x").group).toBe("ai");
  });

  test("json: groups is [] when the report has no group scores", () => {
    const r = reportWithGroups();
    delete (r.healthScore as { groups?: unknown }).groups;
    const parsed = JSON.parse(renderJson(r));
    expect(parsed.score.groups).toEqual([]);
  });

  test("text: emits group headings above the category sections", () => {
    const out = renderText(reportWithGroups());
    expect(out).toContain("=== SEO ===");
    expect(out).toContain("=== PERFORMANCE ===");
    expect(out).toContain("Group Breakdown:");
    // Breakdown name derives from the group code, not the stored name.
    expect(out).toContain("Agents");
    expect(out).not.toContain("AI Readiness");
  });

  test("html: renders the 4 group score circles linking to their issues section", () => {
    const html = renderHtml(reportWithGroups());
    expect(html).toContain('class="group-scores"');
    expect((html.match(/class="group-circle"/g) || []).length).toBe(4);
    // Every group has issues in this fixture, so every circle is a link.
    for (const code of ["seo", "performance", "security", "ai"]) {
      expect(html).toContain(`href="#group-${code}"`);
      expect(html).toContain(`id="group-${code}"`);
    }
    // Short name from the group code (stored name says "AI Readiness"),
    // full title on the hover tooltip.
    expect(html).toContain(">Agents</div>");
    expect(html).toContain('title="Agent Experience"');
    expect(html).not.toContain("AI Readiness");
    // Circle names carry the per-group accent from GROUP_COLORS.
    expect(html).toContain(GROUP_COLORS.ai.text);
    // No terminal command strip in the header.
    expect(html).not.toContain("terminal-cmd");
    expect(html).not.toContain("squirrel audit");
    // Footer draws a single rule (border-top) — no extra divider div.
    expect(html).not.toContain('class="divider"');
  });

  test("html: a group with a score but no issues renders a non-link circle", () => {
    const r = reportWithGroups();
    delete (r.ruleResults as Record<string, unknown>)["ax/x"];
    const html = renderHtml(r);
    expect((html.match(/class="group-circle"/g) || []).length).toBe(4);
    expect(html).not.toContain('href="#group-ai"');
    expect(html).not.toContain('id="group-ai"');
    // The other three still link.
    expect(html).toContain('href="#group-seo"');
  });
});

// Fixture: seo has 2 categories (core, links); performance/security/ai have 1
// each — and perf/security display names literally equal their group name.
describe("single-category groups collapse the redundant heading (#626)", () => {
  test("text: keeps the group heading but drops the duplicate category line", () => {
    const out = renderText(reportWithGroups());
    // Group headings present for both single- and multi-category groups.
    expect(out).toContain("=== PERFORMANCE ===");
    expect(out).toContain("=== SEO ===");
    // Single-category groups: no redundant [PERFORMANCE]/[SECURITY] category line.
    expect(out).not.toContain("[PERFORMANCE]");
    expect(out).not.toContain("[SECURITY]");
    // Multi-category seo keeps its category sub-headers.
    expect(out).toContain("[CORE SEO]");
    expect(out).toContain("[LINKS]");
    // Only the 2 multi-category categories emit a header line.
    expect((out.match(/^\[[A-Z]/gm) || []).length).toBe(2);
  });

  test("html: no group/category headings — every rule carries its parent group label", () => {
    const html = renderHtml(reportWithGroups());
    // The redesign drops the heading hierarchy entirely: a single "Issues"
    // section, one anchor div per group, and a group label pill on each rule.
    expect(html).toContain("<h2>Issues</h2>");
    expect(html).not.toContain('class="category-header"');
    expect(html).not.toContain('class="group-heading"');
    // 5 rules → 5 pills; the seo group's two categories both label as "SEO".
    expect((html.match(/class="group-label"/g) || []).length).toBe(5);
    expect((html.match(/class="group-label" title="SEO"[^>]*>SEO<\/span>/g) || []).length).toBe(2);
    // Each pill is tinted with its group's accent (inline from GROUP_COLORS).
    for (const code of ["seo", "performance", "security", "ai"] as const) {
      expect(html).toContain(GROUP_COLORS[code].text);
    }
  });

  test("markdown: drops the #### category heading for single-category groups & keeps levels contiguous", () => {
    const md = renderMarkdown(reportWithGroups());
    expect(md).toContain("### Performance"); // group heading (h3)
    expect(md).not.toContain("#### Performance"); // no duplicate category heading
    // Single-category group: rule promoted to h4 directly under the group (h3 → h4, no skip).
    expect(md).toContain("#### perf/x");
    // Multi-category seo keeps category headings (h4) with rules nested at h5.
    expect(md).toContain("#### Core SEO");
    expect(md).toContain("#### Links");
    expect(md).toContain("##### core/x");
  });

  // A single-category group whose sole category has subcategories (blocking →
  // ad/privacy, in the security group). Collapsing the category header must not
  // orphan the subcategory heading at h4 under the group's h2.
  function reportBlockingOnly(): AuditReport {
    const meta = (id: string, subcategory: string) => ({
      id,
      name: id,
      description: "",
      category: "blocking",
      subcategory,
      scope: "page",
      severity: "error",
      weight: 5,
    });
    return {
      baseUrl: "https://example.com",
      timestamp: "2026-07-03T00:00:00.000Z",
      totalPages: 1,
      passed: 0,
      warnings: 0,
      failed: 2,
      ruleResults: {
        "blocking/tracker": { meta: meta("blocking/tracker", "ad"), checks: [fail("ad tracker")] },
        "blocking/pixel": {
          meta: meta("blocking/pixel", "privacy"),
          checks: [fail("privacy pixel")],
        },
      },
      healthScore: {
        overall: 50,
        categories: [],
        groups: [
          {
            group: "security",
            name: "Security",
            score: 50,
            passed: 0,
            warnings: 0,
            failed: 2,
            total: 2,
          },
        ],
        errorCount: 2,
        warningCount: 0,
        passedCount: 0,
      },
    } as unknown as AuditReport;
  }

  test("html: subcategories render no headers — rules stay flat under the group anchor", () => {
    const html = renderHtml(reportBlockingOnly());
    // The flat redesign has no subcategory headers in HTML (text/md keep them);
    // both blocking rules sit in the security group section with its label.
    expect(html).not.toContain("subcategory-header");
    expect(html).toContain('id="group-security"');
    expect(
      (html.match(/class="group-label" title="Security"[^>]*>Security<\/span>/g) || []).length,
    ).toBe(2);
  });

  test("markdown: single-category group with subcategories promotes levels (### group → #### sub → ##### rule)", () => {
    const md = renderMarkdown(reportBlockingOnly());
    expect(md).toContain("### Security"); // group heading (h3)
    expect(md).not.toContain("#### Blocking"); // collapsed category heading
    // subBase = 4 for a single-category group: subcategory at h4, rule at h5 — contiguous.
    expect(md).toContain("#### Ad blocking");
    expect(md).toContain("##### blocking/tracker");
  });

  test("html: rules from multiple categories share one group section and label", () => {
    // A second security category joins blocking in the same #group-security
    // section; all three rules carry the same "Security" label.
    const r = reportBlockingOnly();
    (r.ruleResults as Record<string, unknown>)["security/https"] = {
      meta: {
        id: "security/https",
        name: "https",
        description: "",
        category: "security",
        scope: "page",
        severity: "error",
        weight: 5,
      },
      checks: [fail("no https")],
    };
    const html = renderHtml(r);
    expect((html.match(/id="group-security"/g) || []).length).toBe(1);
    expect(
      (html.match(/class="group-label" title="Security"[^>]*>Security<\/span>/g) || []).length,
    ).toBe(3);
  });
});
