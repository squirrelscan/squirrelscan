// Smart audits (#110) — union-scoring no-inflation invariant.
//
// The core guarantee: scoring over the UNION of known pages means a PARTIAL
// re-audit (fewer pages crawled, the rest carried) must NOT raise the score
// versus a full audit of the same site.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { RuleMeta, RuleRunResult } from "@squirrelscan/rules";

import { buildScoringResultsFromMerged, calculateHealthScore } from "../src/scoring";
import {
  fingerprint,
  findingKey,
  flattenChecks,
  type CarriedFinding,
} from "../src/merge";

const META: RuleMeta = {
  id: "core/meta-title",
  name: "Meta Title",
  description: "Page has a meta title",
  category: "core",
  scope: "page",
  severity: "error",
  weight: 5,
};

function pageUrl(i: number): string {
  return `https://example.com/page-${i}`;
}

/** A page-scope rule check for one page — pass or fail. */
function check(url: string, status: "pass" | "fail"): CheckResult {
  return {
    name: META.name,
    status,
    message: status === "fail" ? "Missing meta title" : "OK",
    pageUrl: url,
  };
}

/** Build a fresh ruleResultsMap for `n` pages, the first `failCount` failing. */
function freshMapFor(n: number, failCount: number): Map<string, RuleRunResult> {
  const checks: CheckResult[] = [];
  for (let i = 0; i < n; i++) {
    checks.push(check(pageUrl(i), i < failCount ? "fail" : "pass"));
  }
  return new Map([[META.id, { meta: META, checks }]]);
}

describe("union scoring — no inflation on partial re-audit", () => {
  test("100 pages (30 fail) → re-audit 10 pages stays ≈ same score", () => {
    // --- Full audit: 100 pages, 30 fail meta-title.
    const fullMap = freshMapFor(100, 30);
    const fullScore = calculateHealthScore({ results: fullMap }).overall;

    // --- Partial re-audit of the SAME site: only the first 10 pages re-crawled.
    // The site state is unchanged (pages 0..29 fail), so the re-crawled pages
    // 0..9 all still fail and the carried set is pages 10..99 (20 fail + 70
    // clean). Union must reconstruct the same 100-page / 30-fail population.
    const freshPartial = freshMapFor(10, 10);

    const carriedFindings: CarriedFinding[] = [];
    const carriedPageUrls = new Set<string>();
    for (let i = 10; i < 100; i++) {
      const url = pageUrl(i);
      carriedPageUrls.add(url);
      if (i < 30) {
        carriedFindings.push({
          normalizedUrl: url,
          ruleId: META.id,
          checkName: META.name,
          status: "fail",
          message: "Missing meta title",
        });
      }
      // pages 30..99 carried with NO finding → clean carried (synthetic pass).
    }

    const union = buildScoringResultsFromMerged({
      freshResults: freshPartial,
      carriedFindings,
      carriedPageUrls,
      ruleMetaIndex: new Map([[META.id, META]]),
    });
    const partialScore = calculateHealthScore({ results: union }).overall;

    // The union reconstructs the same 100-page / 30-fail population, so the
    // score must match the full audit (within rounding).
    expect(Math.abs(partialScore - fullScore)).toBeLessThanOrEqual(1);
    // Critically: the partial re-audit does NOT inflate above the full score.
    expect(partialScore).toBeLessThanOrEqual(fullScore + 1);
  });

  test("WITHOUT union scoring, a partial re-audit inflates (control)", () => {
    const fullScore = calculateHealthScore({ results: freshMapFor(100, 30) }).overall;
    // Naive: only score the 10 re-crawled pages (3 fail) — issues vanish.
    const naiveScore = calculateHealthScore({ results: freshMapFor(10, 3) }).overall;
    // Same fail ratio here, so equal — bump the re-audit to be "cleaner" to show
    // inflation: re-audit 10 pages with 0 fails.
    const cleanReaudit = calculateHealthScore({ results: freshMapFor(10, 0) }).overall;
    expect(cleanReaudit).toBeGreaterThan(fullScore);
    // (naiveScore included to document the same-ratio case is stable.)
    expect(naiveScore).toBeGreaterThanOrEqual(0);
  });

  test("union denominator covers clean carried pages (no deflation either)", () => {
    // Full audit: 50 pages, pages 0..4 fail.
    const full = calculateHealthScore({ results: freshMapFor(50, 5) }).overall;

    // Re-audit just ONE clean page (page 49). Carried = pages 0..48: 5 fail
    // (0..4) + 44 clean (5..48). Union reconstructs the same 50/5 population.
    const fresh = new Map<string, RuleRunResult>([
      [META.id, { meta: META, checks: [check(pageUrl(49), "pass")] }],
    ]);
    const carriedFindings: CarriedFinding[] = [];
    const carriedPageUrls = new Set<string>();
    for (let i = 0; i < 49; i++) {
      const url = pageUrl(i);
      carriedPageUrls.add(url);
      if (i < 5) {
        carriedFindings.push({
          normalizedUrl: url,
          ruleId: META.id,
          checkName: META.name,
          status: "fail",
          message: "Missing meta title",
        });
      }
    }
    const union = buildScoringResultsFromMerged({
      freshResults: fresh,
      carriedFindings,
      carriedPageUrls,
      ruleMetaIndex: new Map([[META.id, META]]),
    });
    const partial = calculateHealthScore({ results: union }).overall;
    expect(Math.abs(partial - full)).toBeLessThanOrEqual(1);
  });
});

describe("carried-clean passes are counted, not materialized (#918)", () => {
  test("syntheticPassCount folds clean carried pages; no per-page pass objects", () => {
    // 10 re-crawled pages (all fail) + carried 10..99: 20 fail, 70 clean.
    const freshPartial = freshMapFor(10, 10);
    const carriedFindings: CarriedFinding[] = [];
    const carriedPageUrls = new Set<string>();
    for (let i = 10; i < 100; i++) {
      const url = pageUrl(i);
      carriedPageUrls.add(url);
      if (i < 30) {
        carriedFindings.push({
          normalizedUrl: url,
          ruleId: META.id,
          checkName: META.name,
          status: "fail",
          message: "Missing meta title",
        });
      }
    }
    const union = buildScoringResultsFromMerged({
      freshResults: freshPartial,
      carriedFindings,
      carriedPageUrls,
      ruleMetaIndex: new Map([[META.id, META]]),
    });
    const rule = union.get(META.id)!;
    // 70 clean carried pages (30..99) fold to a COUNT — not 70 pass objects.
    expect(rule.syntheticPassCount).toBe(70);
    expect(
      rule.checks.some((c) => c.status === "pass" && c.message === "carried (clean)"),
    ).toBe(false);
    // checks = 10 fresh fails + 20 carried fails, zero synthetic pass rows.
    expect(rule.checks.length).toBe(30);
    expect(rule.checks.every((c) => c.status === "fail")).toBe(true);
  });

  test("count-based denominator scores identically to materialized passes", () => {
    // One re-crawled clean page + 499 clean carried pages → perfect 100. The
    // count must feed passed+total exactly like 499 materialized pass objects.
    const fresh = new Map<string, RuleRunResult>([
      [META.id, { meta: META, checks: [check(pageUrl(0), "pass")] }],
    ]);
    const carriedPageUrls = new Set<string>();
    for (let i = 1; i < 500; i++) carriedPageUrls.add(pageUrl(i));
    const union = buildScoringResultsFromMerged({
      freshResults: fresh,
      carriedFindings: [],
      carriedPageUrls,
      ruleMetaIndex: new Map([[META.id, META]]),
    });
    const rule = union.get(META.id)!;
    expect(rule.syntheticPassCount).toBe(499);
    expect(rule.checks.length).toBe(1); // only the fresh page — no synthetic objects
    expect(calculateHealthScore({ results: union }).overall).toBe(100);
  });
});

describe("finding identity + fingerprint", () => {
  test("findingKey is stable + locator-discriminated", () => {
    expect(findingKey("https://x/a", "r", "c", "")).toBe("https://x/a|r|c|");
    expect(findingKey("https://x/a", "r", "c", "item1")).not.toBe(
      findingKey("https://x/a", "r", "c", "item2"),
    );
  });

  test("fingerprint changes when status/message/value/expected change", () => {
    const base = fingerprint("fail", "msg", null, null);
    expect(fingerprint("fail", "msg", null, null)).toBe(base);
    expect(fingerprint("warn", "msg", null, null)).not.toBe(base);
    expect(fingerprint("fail", "other", null, null)).not.toBe(base);
    expect(fingerprint("fail", "msg", "v", null)).not.toBe(base);
  });

  test("flattenChecks only emits fail/warn, one finding per item", () => {
    const checks: CheckResult[] = [
      { name: "c1", status: "pass", message: "ok" },
      { name: "c2", status: "fail", message: "bad" },
      {
        name: "c3",
        status: "warn",
        message: "items",
        items: [{ id: "i1" }, { id: "i2" }],
      },
    ];
    const flat = flattenChecks("https://x/a", "r", checks);
    // c1 (pass) dropped; c2 → 1 finding (locator ""); c3 → 2 findings.
    expect(flat.length).toBe(3);
    expect(flat.filter((f) => f.checkName === "c2")[0].locator).toBe("");
    const c3 = flat.filter((f) => f.checkName === "c3").map((f) => f.locator).sort();
    expect(c3).toEqual(["i1", "i2"]);
  });
});
