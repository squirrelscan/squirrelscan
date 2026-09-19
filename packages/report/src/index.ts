// @squirrelscan/report - shared report types, grouping, and formatters

// Types
export type {
  CheckItem,
  CheckResult,
  ComponentOccurrence,
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
  severityLabel,
  normalizeCategoryCode,
  deriveBlockingSubcategory,
} from "./categories";
export type { CategoryInfo, GroupInfo, RuleGroup } from "./categories";

// Occurrence counting for folded aggregate checks (#910)
export { checkOccurrences } from "./occurrences";

// Grouping
export { groupIssuesByCategory, groupCategoriesByGroup, flattenIssuesBySeverity } from "./grouping";
// Merged check messages (#2231). Exported so the cloud API groups the same
// findings from its own store and reaches the same text.
export { mergeCheckMessages, messageMergeKey } from "./message-merge";
export type { GroupedCheck, GroupedRule, GroupedCategory, GroupedGroup, FlatIssue } from "./grouping";
export {
  componentFixGroupDigest,
  componentFixGroups,
  componentOccurrenceIdentity,
  componentOccurrenceKey,
} from "./component-fix-groups";
export type { ComponentFixGroup } from "./component-fix-groups";

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
// + scan scope disclosure (#1180) + refused off-site seed redirect (#1418)
export {
  coverageLine,
  carriedTag,
  timeAgo,
  scanScopeLine,
  seedRedirect,
  seedRedirectLine,
  WITHHELD_SEED_REDIRECT_TARGET,
  type SeedRedirect,
  fullScanHint,
  checkCarriedLabel,
  checkUnrenderedLabel,
  ruleCarriedRollupLine,
  ruleMixedProvenanceNote,
  type MixedProvenanceCheck,
} from "./coverage";

// Editor's summary helpers (report-only / non-scoring; shared across formats + CLI console)
export {
  EDITOR_SUMMARY_NOTE,
  buildEditorSummaryRequest,
  editorSummaryView,
  toEditorSummary,
  type BuildEditorSummaryRequestOptions,
  type EditorSummaryView,
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

// Entity map (#2091) — report-only / non-scoring, shared by all six formats and
// by the engine's standalone entity-map document.
export {
  ENTITY_CONSOLE_LIMIT,
  ENTITY_EMPTY_MESSAGE,
  ENTITY_FINDING_LIMIT,
  ENTITY_TABLE_LIMIT,
  conflictedEntities,
  danglingEdges,
  danglingTargetId,
  entitiesByReach,
  entitiesWithoutId,
  entityCell,
  entityLabel,
  entityMarkdownSection,
  entityPageTotal,
  entitySummaryLine,
  hasEntityMap,
  primaryEntities,
  stableIdPercent,
  typeCounts,
} from "./entities";
export {
  ENTITY_DIFF_PAGE_LIMIT,
  ENTITY_DIFF_ROW_LIMIT,
  entityDiffIsEmpty,
  renderEntityDiffMarkdown,
} from "./entities-diff";
export {
  MERMAID_NODE_CAP,
  renderEntitiesCsv,
  renderEntitiesDot,
  renderEntitiesGraphml,
  renderEntitiesMermaid,
} from "./entities-export";
export {
  ENTITY_GRAPH_NODE_CAP,
  ENTITY_VIEWER_STYLES,
  escapeEntityJsonForScript,
  entityViewerData,
  entityViewerMarkup,
  entityViewerScript,
} from "./entities-viewer";
export type {
  EntityMap,
  EntityMapConflict,
  EntityMapDiff,
  EntityMapEdge,
  EntityMapNode,
  EntityMapSummary,
} from "./types";

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
export {
  getAuditFailureNotice,
  reportFailureReasonCode,
  type AuditFailureNotice,
} from "./failure-notice";

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
