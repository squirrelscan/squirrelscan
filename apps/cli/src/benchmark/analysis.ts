/**
 * Gap and correlation analysis for benchmark
 */

import type {
  AuditComparison,
  BenchmarkReport,
  CategoryComparison,
  LighthouseResult,
  SiteBenchmark,
  SquirrelScanResult,
} from "./types";

import { LH_CATEGORIES, LIGHTHOUSE_TO_SQUIRRELSCAN } from "./mapping";

/**
 * Get issue count from Lighthouse audit
 *
 * IMPORTANT: Check score FIRST before counting items.
 * Some audits (like total-byte-weight) include informational items
 * even when passing (score=1). Only count items as issues when
 * the audit is actually failing (score < 1).
 */
function getLhIssueCount(audit: {
  score: number | null;
  details?: { items?: unknown[] };
}): number {
  // If score is 1 (passing), there are no issues regardless of items
  if (audit.score === 1) return 0;

  // If score is null or < 1, count items if available
  if (audit.details?.items && audit.details.items.length > 0) {
    return audit.details.items.length;
  }

  // No items but failing score
  if (audit.score === 0) return 1;
  if (audit.score !== null && audit.score < 1) return 1;

  return 0;
}

/**
 * Get issue count from SquirrelScan for specific rules
 *
 * Counts issues by:
 * - affectedPages.length for page-scope rules
 * - items.length for site-scope rules with items
 * - 1 for site-scope rules with warn/fail status but no items (e.g., missing CSP header)
 */
function getSsIssueCount(ss: SquirrelScanResult, ruleIds: string[]): number {
  let count = 0;
  for (const ruleId of ruleIds) {
    const issue = ss.issues.find((i) => i.ruleId === ruleId);
    if (issue) {
      for (const check of issue.checks) {
        // Count affectedPages for page-scope rules
        const pageCount = check.affectedPages?.length ?? 0;
        if (pageCount > 0) {
          count += pageCount;
          continue;
        }

        // For site-scope rules, count items if available
        const itemCount = check.items?.length ?? 0;
        if (itemCount > 0) {
          count += itemCount;
          continue;
        }

        // For site-scope rules with no items (e.g., missing CSP header),
        // count as 1 issue if status is warn or fail
        if (check.status === "warn" || check.status === "fail") {
          count += 1;
        }
      }
    }
  }
  return count;
}

/**
 * Determine concordance between LH and SS findings
 */
function getConcordance(
  lhIssueCount: number,
  ssIssueCount: number,
  covered: boolean
): AuditComparison["concordance"] {
  if (!covered) return "na";

  const lhFails = lhIssueCount > 0;
  const ssFails = ssIssueCount > 0;

  if (!lhFails && !ssFails) return "both_pass";
  if (lhFails && ssFails) return "both_fail";
  if (lhFails && !ssFails) return "lh_only";
  return "ss_only";
}

/**
 * Compare a single site's LH and SS results
 */
export function compareSite(
  domain: string,
  url: string,
  lh: LighthouseResult,
  ss: SquirrelScanResult,
  strategy: "mobile" | "desktop"
): SiteBenchmark {
  const categories: CategoryComparison[] = [];

  for (const [catName, auditIds] of Object.entries(LH_CATEGORIES)) {
    const audits: AuditComparison[] = [];
    let covered = 0;
    let browserRequired = 0;
    let concordantCount = 0;
    let comparableCount = 0;

    for (const auditId of auditIds) {
      const lhAudit = lh.audits[auditId];
      if (!lhAudit) continue;

      const ssRuleIds = LIGHTHOUSE_TO_SQUIRRELSCAN[auditId];
      const isBrowserRequired = ssRuleIds === null;
      const isCovered =
        !isBrowserRequired && ssRuleIds !== undefined && ssRuleIds.length > 0;

      if (isBrowserRequired) browserRequired++;
      if (isCovered) covered++;

      const lhIssueCount = getLhIssueCount(lhAudit);
      const ssIssueCount = isCovered ? getSsIssueCount(ss, ssRuleIds!) : 0;
      const concordance = getConcordance(lhIssueCount, ssIssueCount, isCovered);

      if (concordance !== "na") {
        comparableCount++;
        if (concordance === "both_pass" || concordance === "both_fail") {
          concordantCount++;
        }
      }

      audits.push({
        lhAuditId: auditId,
        lhTitle: lhAudit.title,
        ssRuleIds,
        lhScore: lhAudit.score,
        lhIssueCount,
        ssIssueCount,
        covered: isCovered,
        browserRequired: isBrowserRequired,
        concordance,
      });
    }

    const lhCategory = Object.values(lh.categories).find((c) =>
      c.id.toLowerCase().includes(catName.toLowerCase().replace(" ", "-"))
    );

    categories.push({
      name: catName,
      lhScore: lhCategory?.score ?? null,
      covered,
      total: audits.length,
      browserRequired,
      audits,
      concordanceRate:
        comparableCount > 0 ? concordantCount / comparableCount : 0,
    });
  }

  // Extract LH scores
  const cats = lh.categories;
  const lhScores = {
    accessibility: cats.accessibility?.score ?? null,
    bestPractices: cats["best-practices"]?.score ?? null,
    seo: cats.seo?.score ?? null,
    performance: cats.performance?.score ?? null,
  };

  return {
    domain,
    url,
    strategy,
    timestamp: new Date().toISOString(),
    psi: {
      lighthouseResult: lh,
      analysisUTCTimestamp: new Date().toISOString(),
    },
    ss,
    categories,
    lhScores,
    ssScore: ss.score.overall,
  };
}

/**
 * Calculate Pearson correlation coefficient
 */
function pearsonR(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;

  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);
  const sumY2 = y.reduce((acc, yi) => acc + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Generate full benchmark report from site results
 */
export function generateReport(sites: SiteBenchmark[]): BenchmarkReport {
  // Count mapping coverage
  const allAudits = Object.keys(LIGHTHOUSE_TO_SQUIRRELSCAN);
  const coveredAudits = allAudits.filter((a) => {
    const v = LIGHTHOUSE_TO_SQUIRRELSCAN[a];
    return v !== null && v.length > 0;
  });
  const browserRequiredAudits = allAudits.filter(
    (a) => LIGHTHOUSE_TO_SQUIRRELSCAN[a] === null
  );
  const notCoveredAudits = allAudits.filter((a) => {
    const v = LIGHTHOUSE_TO_SQUIRRELSCAN[a];
    return v !== null && v.length === 0;
  });

  // Aggregate category correlations
  const categoryData: Record<
    string,
    { lhScores: number[]; ssScores: number[]; concordances: number[] }
  > = {};

  for (const site of sites) {
    for (const cat of site.categories) {
      if (!categoryData[cat.name]) {
        categoryData[cat.name] = {
          lhScores: [],
          ssScores: [],
          concordances: [],
        };
      }

      if (cat.lhScore !== null) {
        categoryData[cat.name].lhScores.push(cat.lhScore * 100);
        categoryData[cat.name].ssScores.push(site.ssScore);
      }

      if (cat.concordanceRate > 0) {
        categoryData[cat.name].concordances.push(cat.concordanceRate);
      }
    }
  }

  const categoryCorrelations: BenchmarkReport["categoryCorrelations"] = {};
  for (const [name, data] of Object.entries(categoryData)) {
    const avgConcordance =
      data.concordances.length > 0
        ? data.concordances.reduce((a, b) => a + b, 0) /
          data.concordances.length
        : 0;

    categoryCorrelations[name] = {
      pearsonR: pearsonR(data.lhScores, data.ssScores),
      concordanceRate: avgConcordance,
      sampleSize: data.lhScores.length,
    };
  }

  // Gap analysis - find audits where only one tool finds issues
  const lhOnlyFinds: Map<string, string[]> = new Map();
  const ssOnlyFinds: Map<string, string[]> = new Map();

  for (const site of sites) {
    for (const cat of site.categories) {
      for (const audit of cat.audits) {
        if (audit.concordance === "lh_only") {
          const existing = lhOnlyFinds.get(audit.lhAuditId) || [];
          existing.push(site.domain);
          lhOnlyFinds.set(audit.lhAuditId, existing);
        } else if (audit.concordance === "ss_only") {
          const existing = ssOnlyFinds.get(audit.lhAuditId) || [];
          existing.push(site.domain);
          ssOnlyFinds.set(audit.lhAuditId, existing);
        }
      }
    }
  }

  return {
    generated: new Date().toISOString(),
    strategy: sites[0]?.strategy ?? "mobile",
    sites,
    summary: {
      totalSites: sites.length,
      totalAudits: allAudits.length,
      coveredAudits: coveredAudits.length,
      browserRequiredAudits: browserRequiredAudits.length,
      notCoveredAudits: notCoveredAudits.length,
    },
    categoryCorrelations,
    gaps: {
      lhOnlyFinds: Array.from(lhOnlyFinds.entries()).map(
        ([auditId, siteDomains]) => ({
          auditId,
          sites: siteDomains,
        })
      ),
      ssOnlyFinds: Array.from(ssOnlyFinds.entries()).map(
        ([auditId, siteDomains]) => ({
          auditId,
          sites: siteDomains,
        })
      ),
    },
  };
}
