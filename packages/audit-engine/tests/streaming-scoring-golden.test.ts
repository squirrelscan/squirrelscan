// GOLDEN INVARIANT (#1021, PR-E §3): folding per-page rule results into per-rule
// tallies during a stream, then scoring via calculateHealthScoreFromTallies, is
// byte-identical to accumulating every check into a ruleResultsMap and scoring
// via calculateHealthScore. Property-style: many randomized runs (seeded PRNG)
// exercising multi-category/multi-rule/multi-page checks, items[],
// details.additional, warn/fail/pass/skipped/info, advisory (info-severity)
// rules, and the robots/sitemap critical penalty.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { RuleMeta, RuleRunResult } from "@squirrelscan/rules/types";
import {
  RULE_ID_ROBOTS_TXT,
  RULE_ID_SITEMAP_EXISTS,
  CHECK_NAME_ROBOTS_DISALLOW,
  CHECK_NAME_ROBOTS_EXISTS,
  CHECK_NAME_SITEMAP_EXISTS,
} from "@squirrelscan/utils/constants";

import { mergeRuleRunResult } from "@squirrelscan/rules";
import {
  calculateHealthScore,
  calculateHealthScoreFromTallies,
  foldRuleResultIntoTallies,
  type RuleTally,
} from "../src/scoring";

// Tiny deterministic PRNG (mulberry32) so failures are reproducible.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES = ["core", "content", "crawl", "links", "perf", "security", "schema", "eeat"];
const STATUSES: CheckResult["status"][] = ["pass", "warn", "fail", "skipped", "info"];

function meta(rand: () => number, id: string, scope: "page" | "site"): RuleMeta {
  const category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)]!;
  const severity = rand() < 0.2 ? "info" : rand() < 0.5 ? "warning" : "error";
  return {
    id,
    name: id,
    description: "",
    solution: "",
    category,
    scope,
    severity,
    weight: 1 + Math.floor(rand() * 9),
  } as RuleMeta;
}

function randomChecks(rand: () => number, name: string, pageUrl: string): CheckResult[] {
  const out: CheckResult[] = [];
  const n = Math.floor(rand() * 3); // 0..2 checks per (rule,page)
  for (let i = 0; i < n; i++) {
    const status = STATUSES[Math.floor(rand() * STATUSES.length)]!;
    const check: CheckResult = { name, status, message: "m", pageUrl };
    if ((status === "warn" || status === "fail") && rand() < 0.6) {
      const items = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, k) => ({ id: `${k}` }));
      check.items = items;
    }
    if (status === "fail" && rand() < 0.4) {
      check.details = { additional: Math.floor(rand() * 20) };
    }
    out.push(check);
  }
  return out;
}

// Build one randomized run BOTH ways: (a) a ruleResultsMap of concatenated
// checks (v1 scoring input), (b) a folded per-rule tally map (streaming input).
function buildRun(seed: number) {
  const rand = prng(seed);
  const numPageRules = 3 + Math.floor(rand() * 6);
  const numSiteRules = 2 + Math.floor(rand() * 4);
  const numPages = 1 + Math.floor(rand() * 40);

  const pageRuleMetas = Array.from({ length: numPageRules }, (_, i) =>
    meta(rand, `cat/page-rule-${i}`, "page")
  );
  const siteRuleMetas = Array.from({ length: numSiteRules }, (_, i) =>
    meta(rand, `cat/site-rule-${i}`, "site")
  );

  const ruleResultsMap = new Map<string, RuleRunResult>();
  const tallies = new Map<string, RuleTally>();
  const penaltyResults = new Map<string, RuleRunResult>();

  const foldBoth = (ruleId: string, result: RuleRunResult) => {
    // v1 accumulation (mirror runRulesOnStorage): stamp pageUrl already done.
    mergeRuleRunResult(ruleResultsMap, ruleId, result);
    // streaming fold.
    foldRuleResultIntoTallies(tallies, ruleId, result);
  };

  // Page rules across pages (checks carry the page URL).
  for (let p = 0; p < numPages; p++) {
    const pageUrl = `https://example.com/p${p}`;
    for (const m of pageRuleMetas) {
      const checks = randomChecks(rand, m.id, pageUrl);
      if (checks.length === 0) continue;
      foldBoth(m.id, { meta: m, checks });
    }
  }

  // Site rules run once (checks with empty pageUrl).
  for (const m of siteRuleMetas) {
    const checks = randomChecks(rand, m.id, "");
    foldBoth(m.id, { meta: m, checks });
  }

  // Randomly inject the robots/sitemap critical-penalty rules with real checks.
  if (rand() < 0.7) {
    const robotsChecks: CheckResult[] = [
      { name: CHECK_NAME_ROBOTS_EXISTS, status: rand() < 0.5 ? "warn" : "pass", message: "m" },
    ];
    if (rand() < 0.5)
      robotsChecks.push({ name: CHECK_NAME_ROBOTS_DISALLOW, status: rand() < 0.5 ? "fail" : "pass", message: "m" });
    const robotsMeta = meta(rand, RULE_ID_ROBOTS_TXT, "site");
    const rr: RuleRunResult = { meta: robotsMeta, checks: robotsChecks };
    foldBoth(RULE_ID_ROBOTS_TXT, rr);
    penaltyResults.set(RULE_ID_ROBOTS_TXT, ruleResultsMap.get(RULE_ID_ROBOTS_TXT)!);
  }
  if (rand() < 0.7) {
    const sitemapChecks: CheckResult[] = [
      { name: CHECK_NAME_SITEMAP_EXISTS, status: rand() < 0.5 ? "fail" : "pass", message: "m" },
    ];
    const rr: RuleRunResult = { meta: meta(rand, RULE_ID_SITEMAP_EXISTS, "site"), checks: sitemapChecks };
    foldBoth(RULE_ID_SITEMAP_EXISTS, rr);
    penaltyResults.set(RULE_ID_SITEMAP_EXISTS, ruleResultsMap.get(RULE_ID_SITEMAP_EXISTS)!);
  }

  return { ruleResultsMap, tallies, penaltyResults };
}

describe("streaming fold-to-tallies scoring — GOLDEN INVARIANT", () => {
  test("calculateHealthScoreFromTallies ≡ calculateHealthScore across 200 random runs", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { ruleResultsMap, tallies, penaltyResults } = buildRun(seed);
      const v1 = calculateHealthScore({ results: ruleResultsMap });
      const streamed = calculateHealthScoreFromTallies(tallies, penaltyResults);
      expect(streamed).toEqual(v1);
    }
  });

  test("empty run → both produce the null/N-A score", () => {
    const v1 = calculateHealthScore({ results: new Map() });
    const streamed = calculateHealthScoreFromTallies(new Map(), new Map());
    expect(streamed).toEqual(v1);
    expect(streamed.overall).toBeNull();
  });
});
