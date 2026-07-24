// Report-relevant types shared between CLI and API
import type { AuditReport as CoreAuditReport } from "@squirrelscan/core-contracts";

export type {
  AuditStatus,
  CacheHitReason,
  CacheStats,
  CategoryScore,
  CheckItem,
  CheckResult,
  ContactPoint,
  DomainStats,
  DomainStatsMetrics,
  DomainStatsPositions,
  GroupScore,
  HealthScore,
  ReportRuleResult,
  ReportTechnologies,
  ReportTechnology,
  SiteMetadata,
  SocialAccount,
  SoftwareAdvisory,
  TechnologyCategory,
  RuleMetaLite as RuleMeta,
} from "@squirrelscan/core-contracts";

/**
 * The report shape every formatter consumes. `siteMetadata` (the resolved
 * Stage-0 site profile) is now canonical on the core `AuditReport` — a
 * REPORT-ONLY / NON-SCORING section surfaced alongside `technologies` that
 * NEVER contributes to `healthScore`.
 */
export type AuditReport = CoreAuditReport;
