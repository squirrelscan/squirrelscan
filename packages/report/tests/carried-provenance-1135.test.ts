// #1135 — carried-forward findings must be surfaced, not just carried
// silently through scoring: per-check "fully carried" labels, per-rule
// carried-pages rollups, per-URL provenance, and the "clean on every page
// checked this run, only carried pages still red" mixed note.

import { describe, expect, test } from "bun:test";
import type { ReportRuleResult } from "@squirrelscan/core-contracts";

import { groupIssuesByCategory } from "../src/grouping";
import { ruleAffectedPageCount, ruleCarriedPageCount } from "../src/affected-pages";
import { checkCarriedLabel, ruleCarriedRollupLine } from "../src/coverage";

function rule(id: string, checks: ReportRuleResult["checks"]): ReportRuleResult {
  return {
    meta: {
      id,
      name: id,
      description: "",
      category: "images",
      scope: "page",
      severity: "warning",
      weight: 5,
    },
    checks,
  };
}

describe("carried-page provenance (#1135)", () => {
  test("carriedPages carries the exact per-URL subset across a merge, not inferred from the ratio", () => {
    const grouped = groupIssuesByCategory({
      "images/alt-text": rule("images/alt-text", [
        {
          name: "alt-text-missing",
          status: "warn",
          message: "1 image(s) missing alt text",
          pageUrl: "https://e.com/a",
          provenance: "carried",
          lastSeenAt: 1_000,
        },
        {
          name: "alt-text-missing",
          status: "warn",
          message: "1 image(s) missing alt text",
          pageUrl: "https://e.com/b",
          provenance: "fresh",
        },
      ]),
    });
    const check = grouped[0].rules[0].checks[0];
    expect(check.pages).toEqual(["https://e.com/a", "https://e.com/b"]);
    expect(check.carriedPages).toEqual(["https://e.com/a"]);
    expect(check.carriedCount).toBe(1);
    expect(check.count).toBe(2);
  });

  test("checkCarriedLabel fires only when every merged instance carried", () => {
    const grouped = groupIssuesByCategory({
      "images/alt-text": rule("images/alt-text", [
        {
          name: "alt-text-missing",
          status: "warn",
          message: "missing alt",
          pageUrl: "https://e.com/a",
          provenance: "carried",
          lastSeenAt: Date.now() - 2 * 86_400_000,
        },
      ]),
    });
    const check = grouped[0].rules[0].checks[0];
    const label = checkCarriedLabel(check);
    expect(label).toContain("Not re-checked this run");
    expect(label).toContain("2 days ago");
  });

  test("checkCarriedLabel is null for a partially-carried check", () => {
    const grouped = groupIssuesByCategory({
      "images/alt-text": rule("images/alt-text", [
        {
          name: "alt-text-missing",
          status: "warn",
          message: "missing alt",
          pageUrl: "https://e.com/a",
          provenance: "carried",
        },
        {
          name: "alt-text-missing",
          status: "warn",
          message: "missing alt",
          pageUrl: "https://e.com/b",
          provenance: "fresh",
        },
      ]),
    });
    const check = grouped[0].rules[0].checks[0];
    expect(checkCarriedLabel(check)).toBeNull();
  });

  test("carriedPages includes item-sourced pages (site-scope rules like blocked-links/duplicate-title)", () => {
    const grouped = groupIssuesByCategory({
      "seo/duplicate-title": rule("seo/duplicate-title", [
        {
          name: "duplicate-title",
          status: "warn",
          message: "duplicate title across pages",
          // Site-scope check: no pageUrl/pages — affected pages live under
          // item.sourcePages (case 2 in affected-pages.ts).
          items: [
            { id: "Duplicate Title", sourcePages: ["https://e.com/a", "https://e.com/b"] },
          ],
          provenance: "carried",
          lastSeenAt: 1,
        },
      ]),
    });
    const check = grouped[0].rules[0].checks[0];
    expect(check.pages).toEqual([]);
    // Without the checkAffectedPages fix these would be empty (undercounting
    // relative to ruleAffectedPageCount, which DOES read item.sourcePages).
    expect(new Set(check.carriedPages)).toEqual(new Set(["https://e.com/a", "https://e.com/b"]));
    expect(ruleCarriedPageCount(grouped[0].rules[0].checks)).toBe(2);
    expect(ruleAffectedPageCount(grouped[0].rules[0].checks)).toBe(2);
  });

  test("ruleCarriedPageCount + ruleCarriedRollupLine report the partial-carry fraction", () => {
    const grouped = groupIssuesByCategory({
      "legal/cookie-consent": rule("legal/cookie-consent", [
        {
          name: "cookie-consent-missing",
          status: "warn",
          message: "no consent banner",
          pages: ["https://e.com/a", "https://e.com/b"],
          provenance: "carried",
          lastSeenAt: 1,
        },
        {
          name: "cookie-consent-missing",
          status: "warn",
          message: "no consent banner (variant)",
          pageUrl: "https://e.com/c",
          provenance: "fresh",
        },
      ]),
    });
    const checks = grouped[0].rules[0].checks;
    const carried = ruleCarriedPageCount(checks);
    const total = ruleAffectedPageCount(checks);
    expect(carried).toBe(2);
    expect(total).toBe(3);
    expect(ruleCarriedRollupLine(carried, total)).toBe(
      "2 of 3 pages carried from previous crawls.",
    );
  });

  test("ruleCarriedRollupLine is null when every affected page is carried (rollup would be redundant)", () => {
    expect(ruleCarriedRollupLine(3, 3)).toBeNull();
    expect(ruleCarriedRollupLine(0, 3)).toBeNull();
  });

  test("mixedProvenanceNote fires: fresh pass everywhere checked + a carried issue + no fresh issue", () => {
    const grouped = groupIssuesByCategory({
      "legal/cookie-consent": rule("legal/cookie-consent", [
        // 75 pages passed fresh this run.
        ...Array.from({ length: 75 }, (_, i) => ({
          name: "cookie-consent-missing",
          status: "pass" as const,
          message: "ok",
          pageUrl: `https://e.com/fresh-${i}`,
        })),
        // 28 pages still warn, but only because they were carried forward.
        ...Array.from({ length: 28 }, (_, i) => ({
          name: "cookie-consent-missing",
          status: "warn" as const,
          message: "no consent banner",
          pageUrl: `https://e.com/carried-${i}`,
          provenance: "carried" as const,
          lastSeenAt: 1,
        })),
      ]),
    });
    expect(grouped[0].rules[0].mixedProvenanceNote).toBe(
      "Fixed on all 75 pages checked this run; 28 pages pending re-check.",
    );
  });

  test("mixedProvenanceNote does NOT fire when a fresh issue exists anywhere (genuinely still broken)", () => {
    const grouped = groupIssuesByCategory({
      "legal/cookie-consent": rule("legal/cookie-consent", [
        {
          name: "cookie-consent-missing",
          status: "pass",
          message: "ok",
          pageUrl: "https://e.com/fresh-pass",
        },
        {
          name: "cookie-consent-missing",
          status: "warn",
          message: "no consent banner",
          pageUrl: "https://e.com/carried",
          provenance: "carried",
          lastSeenAt: 1,
        },
        {
          name: "cookie-consent-missing",
          status: "warn",
          message: "no consent banner",
          pageUrl: "https://e.com/fresh-fail",
          provenance: "fresh",
        },
      ]),
    });
    expect(grouped[0].rules[0].mixedProvenanceNote).toBeUndefined();
  });

  test("mixedProvenanceNote counts stay disjoint when the same page is BOTH a fresh pass (one check) and a carried issue (another check)", () => {
    const grouped = groupIssuesByCategory({
      "legal/cookie-consent": rule("legal/cookie-consent", [
        // Page A: check "cc-banner" passes fresh...
        {
          name: "cc-banner",
          status: "pass",
          message: "banner present",
          pageUrl: "https://e.com/a",
        },
        // ...but a DIFFERENT check under the same rule still has a carried
        // warn on the SAME page — page A isn't actually clean, so it must
        // NOT be double-counted toward "checked clean".
        {
          name: "cc-consent-string",
          status: "warn",
          message: "consent string malformed",
          pageUrl: "https://e.com/a",
          provenance: "carried",
          lastSeenAt: 1,
        },
        // Page B: a genuinely clean fresh pass, nothing else.
        {
          name: "cc-banner",
          status: "pass",
          message: "banner present",
          pageUrl: "https://e.com/b",
        },
      ]),
    });
    // Only page B is truly clean; page A is pending (carried), not double-counted.
    expect(grouped[0].rules[0].mixedProvenanceNote).toBe(
      "Fixed on all 1 page checked this run; 1 page pending re-check.",
    );
  });
});
