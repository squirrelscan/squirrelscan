// @squirrelscan/report - shared report types, grouping, and formatters

// Types
export type {
  CheckItem,
  CheckResult,
  ContactPoint,
  RuleMeta,
  ReportRuleResult,
  CategoryScore,
  GroupScore,
  HealthScore,
  AuditReport,
  SiteMetadata,
  SocialAccount,
} from "./types";

// Categories
export {
  CATEGORIES,
  GROUPS,
  GROUP_CODES,
  OTHER_CATEGORY,
  getCategoryName,
  getCategoryPriority,
  getCategoryGroup,
  getGroupName,
  getGroupTitle,
  isValidCategory,
  isValidGroup,
  getSubcategoryName,
  getSubcategoryPriority,
  normalizeCategoryCode,
  deriveBlockingSubcategory,
} from "./categories";
export type { CategoryInfo, GroupInfo, RuleGroup } from "./categories";

// Occurrence counting for folded aggregate checks (#910)
export { checkOccurrences } from "./occurrences";

// Grouping
export { groupIssuesByCategory, groupCategoriesByGroup } from "./grouping";
export type { GroupedCheck, GroupedRule, GroupedCategory, GroupedGroup } from "./grouping";

// Scoring
export { getScoreGrade, getScoreColor, getGroupColor, GROUP_COLORS } from "./scoring";
export type { GroupColor } from "./scoring";

// Constants
export {
  KEY_SEPARATOR,
  REPORT_HTML_VERSION,
  REPORT_COLLAPSE_THRESHOLD,
  REPORT_ITEMS_COLLAPSE_THRESHOLD,
  REPORT_TEXT_WRAP_WIDTH,
  REPORT_SOURCE_PAGES_PREVIEW,
  REPORT_PAGES_INLINE_CAP,
  REPORT_PAGES_HARD_CAP,
} from "./constants";

// Utils
export {
  parseIndentedLines,
  escapeHtml,
  wrapText,
  formatReportDate,
  formatHumanDate,
  sanitizeUrl,
} from "./utils";
export type { GroupedLine } from "./utils";

// URL
export { getPathname } from "./url";

// Docs
export { getDocsUrl } from "./docs";

// Output formatters
export { renderHtml } from "./output/html";
export { renderMarkdown } from "./output/markdown";
export { renderText } from "./output/text";
export { renderXml } from "./output/xml";
export { renderLlm } from "./output/llm";
export { renderJson } from "./output/json";

// Technologies section helpers (shared across formats + CLI console)
export {
  TECH_ICON_BASE_URL,
  techIconUrl,
  groupTechnologies,
  techChangeSummary,
  type TechGroup,
} from "./technologies";

// Site profile section helpers (report-only / non-scoring; shared across formats + CLI console)
export {
  SITE_PROFILE_NOTE,
  formatSiteType,
  formatBusinessCategory,
  formatTypeLine,
  formatAudienceScope,
  formatAudienceLine,
  formatIdentityLine,
  formatContact,
  formatContactsLine,
  formatSocialsLine,
  domainAgeYears,
  formatDomainAgeLine,
  siteProfileRows,
  siteProfileFlags,
  type SiteProfileRow,
} from "./site-metadata";

// Smart audits coverage + carried-finding provenance helpers (#110)
// + scan scope disclosure (#1180)
export {
  coverageLine,
  carriedTag,
  timeAgo,
  scanScopeLine,
  fullScanHint,
  checkCarriedLabel,
  ruleCarriedRollupLine,
  ruleMixedProvenanceNote,
  type MixedProvenanceCheck,
} from "./coverage";

// Editor's summary helpers (report-only / non-scoring; shared across formats + CLI console)
export {
  EDITOR_SUMMARY_NOTE,
  buildEditorSummaryRequest,
  type BuildEditorSummaryRequestOptions,
} from "./editor-summary";

// Re-export the persisted editor-summary report type for renderers + consumers.
export type { EditorSummary } from "@squirrelscan/core-contracts";

// White-label report branding (#810) — threaded through every renderer option.
export type { ReportBranding } from "@squirrelscan/core-contracts";

// Domain-stats helpers (#111, report-only / non-scoring; shared across formats + CLI console)
export {
  DOMAIN_STATS_NOTE,
  buildDomainStatsSummary,
  domainStatRows,
  formatCompact,
  formatUsd,
  positionBands,
  POSITION_BANDS,
  type DomainStatLine,
} from "./domain-stats";
export type { DomainStats, DomainStatsMetrics, DomainStatsPositions } from "./types";

// Cache-stats helpers (report-only / non-scoring; shared across formats) (#108)
export {
  CACHE_STATS_NOTE,
  cacheHitRatePercent,
  cacheReasonRows,
  cacheReasonsLabel,
  cacheStatsSummaryLine,
} from "./cache-stats";
export { formatBytes } from "./utils";
export type { CacheStats, CacheHitReason } from "./types";

// "Pages affected" aggregation: unions check.pages + item-level sourcePages /
// page-URL ids so site-scope rules report real counts (not 0). (#240)
export {
  affectedPages,
  checkAffectedPages,
  checkAffectedPageCount,
  ruleAffectedPages,
  ruleAffectedPageCount,
  ruleAffectedRollup,
  ruleCarriedPageCount,
  isPageUrl,
  isRedundantPageItem,
} from "./affected-pages";
export type { AffectedPages, RuleAffectedRollup } from "./affected-pages";

// Failed/blocked audit notice copy (#792, #935) — single source of truth for
// the static HTML report's FailureNotice and the dashboard's report-detail notice.
export { getAuditFailureNotice, type AuditFailureNotice } from "./failure-notice";

// Locked cloud-rules audience messaging (#368, #747, #792, #780) — single
// source of truth reused by every renderer (html/llm/markdown/text) and the
// CLI footer.
export {
  lockedRulesMessage,
  type LockedRulesAudience,
  type LockedRulesCta,
  type LockedRulesMessage,
  type LockedRulesReportShape,
} from "./locked-rules";
