/**
 * Benchmark types for Lighthouse vs SquirrelScan comparison
 */

// Lighthouse audit from PSI API
export interface LighthouseAudit {
  id: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string;
  numericValue?: number;
  details?: {
    type: string;
    items?: unknown[];
  };
}

// Lighthouse result structure
export interface LighthouseResult {
  audits: Record<string, LighthouseAudit>;
  categories: Record<
    string,
    {
      id: string;
      title: string;
      score: number | null;
      auditRefs: Array<{ id: string; weight: number }>;
    }
  >;
}

// PageSpeed Insights API response
export interface PageSpeedInsightsResponse {
  lighthouseResult: LighthouseResult;
  loadingExperience?: {
    metrics: Record<string, { percentile: number; category: string }>;
  };
  analysisUTCTimestamp: string;
}

// SquirrelScan JSON output
export interface SquirrelScanResult {
  meta: { totalPages: number };
  score: { overall: number; grade: string };
  summary: { passed: number; warnings: number; failed: number };
  issues: Array<{
    ruleId: string;
    severity: "error" | "warning" | "info";
    checks: Array<{
      status: string;
      affectedPages?: string[];
      items?: Array<{ id: string }>;
    }>;
  }>;
}

// Per-audit comparison
export interface AuditComparison {
  lhAuditId: string;
  lhTitle: string;
  ssRuleIds: string[] | null;
  lhScore: number | null;
  lhIssueCount: number;
  ssIssueCount: number;
  covered: boolean;
  browserRequired: boolean;
  // Detection accuracy metrics
  concordance: "both_pass" | "both_fail" | "lh_only" | "ss_only" | "na";
}

// Per-category comparison
export interface CategoryComparison {
  name: string;
  lhScore: number | null;
  covered: number;
  total: number;
  browserRequired: number;
  audits: AuditComparison[];
  // Correlation stats
  concordanceRate: number;
}

// Single site benchmark result
export interface SiteBenchmark {
  domain: string;
  url: string;
  strategy: "mobile" | "desktop";
  timestamp: string;
  psi: PageSpeedInsightsResponse;
  ss: SquirrelScanResult;
  categories: CategoryComparison[];
  // Overall scores
  lhScores: {
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
    performance: number | null;
  };
  ssScore: number;
}

// Full benchmark report
export interface BenchmarkReport {
  generated: string;
  strategy: "mobile" | "desktop";
  sites: SiteBenchmark[];
  // Aggregate stats
  summary: {
    totalSites: number;
    totalAudits: number;
    coveredAudits: number;
    browserRequiredAudits: number;
    notCoveredAudits: number;
  };
  // Per-category correlation
  categoryCorrelations: Record<
    string,
    {
      pearsonR: number;
      concordanceRate: number;
      sampleSize: number;
    }
  >;
  // Gap analysis
  gaps: {
    lhOnlyFinds: Array<{ auditId: string; sites: string[] }>;
    ssOnlyFinds: Array<{ auditId: string; sites: string[] }>;
  };
}

// Test site definition
export interface TestSite {
  domain: string;
  url: string;
}

// CLI options
export interface BenchmarkOptions {
  sites?: string[];
  refresh?: boolean;
  strategy?: "mobile" | "desktop";
}
