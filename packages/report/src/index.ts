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
export { collectSkippedChecks, parseSkippedChecks, restoreSkippedChecks } from "./skipped";
export type { SkippedCheck } from "./skipped";
export { checkOccurrences } from "./occurrences";

// Grouping
export {
  groupIssuesByCategory,
  groupCategoriesByGroup,
  flattenIssuesBySeverity,
  listPassedRules,
  passedRuleScope,
  reportPassedRules,
} from "./grouping";
// Merged check messages (#2231). Exported so the cloud API groups the same
// findings from its own store and reaches the same text.
export { mergeCheckMessages, messageMergeKey } from "./message-merge";
export type {
  GroupedCheck,
  GroupedRule,
  GroupedCategory,
  GroupedGroup,
  FlatIssue,
  PassedRule,
} from "./grouping";
export {
  componentFixGroupDigest,
  componentFixGroups,
  componentOccurrenceIdentity,
  componentOccurrenceKey,
} from "./component-fix-groups";
export type { ComponentFixGroup, ComponentFixAttribution } from "./component-fix-groups";
// Human-facing presentation of those groups. Renderers share these so llm,
// markdown, text and console cannot drift in wording or in what they suppress.
export {
  ROOT_LABEL_MAX,
  describeDefect,
  describeRoot,
  describeRegion,
  describeSlot,
  fixGroupLine,
  fixGroupPages,
  fixRollupLine,
  fixUnits,
  formatPageSample,
  ruleFixCoverage,
  uncoveredItems,
} from "./component-presentation";
export type { FixCoverage, FixCoverageMode, PageSample } from "./component-presentation";
// One block, one line: roll up groups that are demonstrably the same repair.
export {
  ROLLUP_MAX_DISTINCT_VALUES,
  componentFamilyRollups,
  componentFixRollups,
  describeRollupDefect,
} from "./component-fix-rollup";
export type { ComponentFixRollup, ComponentFixRollupLevel } from "./component-fix-rollup";
// One build, one line: shared SITE RESOURCES (source maps today) grouped by the
// page set that references them, so a template site's shared bundle is one
// finding rather than one per page (#2341).
export { siteResourceFixGroups } from "./site-resource-fix-groups";
export type { SiteResourceFixGroup } from "./site-resource-fix-groups";
export {
  SITE_RESOURCE_MAX_KEYS,
  describeSiteResourceDefect,
  isRenderableSiteResourceGroup,
  resourceName,
  ruleSiteResourceCoverage,
  siteResourceFixLine,
  withSiteResourceCoverage,
} from "./site-resource-presentation";
export type { SiteResourceCoverage } from "./site-resource-presentation";
// Site-wide item collapse: one shared resource on nearly every page.
export {
  SITE_WIDE_MAX_EXCEPTIONS,
  SITE_WIDE_MIN_PAGES,
  SITE_WIDE_MIN_PAGE_RATIO,
  auditedPageTotal,
  formatSiteWideItem,
  siteWideContext,
  siteWideItem,
} from "./site-wide-items";
export type { SiteWideItem } from "./site-wide-items";

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

// Rule text from the catalog (capped published reports carry none, #2656)
export { ruleCatalogLookup, withCatalogRuleText } from "./rule-catalog";
export type { RuleCatalogLookup, RuleCatalogText } from "./rule-catalog";

// Output formatters
export { renderHtml, reportInlineScripts, type HtmlRenderOptions } from "./output/html";
export { renderMarkdown } from "./output/markdown";
export { renderText } from "./output/text";
export { renderXml } from "./output/xml";
export { renderLlm } from "./output/llm";
export { pageOutcome, renderJson } from "./output/json";
export type { JsonPageOutcome, JsonPageRow } from "./output/json";

// Technologies section helpers (shared across formats + CLI console)
export {
  TECH_ICON_BASE_URL,
  techIconUrl,
  groupTechnologies,
  techChangeSummary,
  type TechGroup,
} from "./technologies";

// Page structure block helpers (#2307; report-only / non-scoring, shared across formats + CLI console)
export {
  CHROME_SECTIONS,
  MIN_RULES_CONFIDENCE,
  createStructureBuilder,
  extractPageStructure,
  pageTypePhrase,
  structureAttr,
  structureChromeLine,
  structureDegradedLine,
  structureNumber,
  structurePageTypesLine,
  structureRowDetail,
  structureRows,
  structureSectionName,
  structureTotalsLine,
  type StructureBuilder,
  type StructureSource,
} from "./structure";

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

// Transport and delivery rules skipped for a local or private-network host (pub#629)
export {
  privateTargetLine,
  privateTargetSkippedRules,
  type PrivateTargetRule,
  type PrivateTargetReportShape,
} from "./private-target";

// Checks that did not run for this audit: link checks off, links not followed (repo#2729)
export {
  notCheckedDetailLine,
  notCheckedDetailLines,
  notCheckedLine,
  notCheckedLines,
  notCheckedRules,
  timedOutMessage,
  timedOutRules,
  type TimedOutRule,
  type NotCheckedReportShape,
  type NotCheckedRule,
} from "./not-checked";

// Smart audits coverage + carried-finding provenance helpers (#110)
// + scan scope disclosure (#1180) + refused off-site seed redirect (#1418)
export {
  auditLevelLine,
  coverageLine,
  carriedTag,
  timeAgo,
  scanScopeLine,
  scanScopeUnfetched,
  publishedReportNote,
  seedRedirect,
  seedRedirectFollowUp,
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

// `[[ignore]]` waivers in a report (#1262).
export {
  ignoredEntryLines,
  ignoredLine,
  safeIgnored,
  summarizeIgnored,
  unusedIgnoreEntries,
} from "./ignored";

// Start URL redirects (#1281): the followed-redirect disclosure and the
// no-audit outcome a redirect that was not followed prints.
export { followedStartRedirect, startRedirectLine, type FollowedStartRedirect } from "./coverage";
export { renderRedirectedOutcome, type RedirectedOutcomeFormat } from "./start-redirect";

// Editor's summary helpers (report-only / non-scoring; shared across formats + CLI console)
export {
  EDITOR_SUMMARY_NOTE,
  buildEditorSummaryRequest,
  editorSummaryView,
  priorityEffortLabel,
  toEditorSummary,
  type BuildEditorSummaryRequestOptions,
  type EditorSummaryView,
} from "./editor-summary";

// Re-export the persisted editor-summary report type for renderers + consumers.
export type { EditorSummary, EditorSummaryPriority } from "@squirrelscan/core-contracts";

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
  itemsNotListed,
  itemsNotListedLine,
} from "./affected-pages";
export type { AffectedPages, RuleAffectedRollup } from "./affected-pages";

// pub#837: an item's source pages as rows, each page once with its links and sections, and the
// summary suffix that keeps links and pages apart. Shared by every renderer and the CLI console.
export {
  affectedPagesSuffix,
  hasItemSources,
  itemSourceList,
  itemSourceView,
  moreSourcePages,
  sourceRowText,
} from "./item-sources";
export type { ItemSourceList, ItemSourceRow, ItemSourceView } from "./item-sources";

// pub#846: a finding in a shared page region names the region instead of listing its pages.
export {
  REGION_SCOPE_MIN_PAGES,
  REGION_SCOPE_MIN_SHARE,
  TEMPLATE_REGIONS,
  checkPagesScopedAway,
  checkRegionScope,
  checkScopeLine,
  itemLabel,
  itemRegionScope,
  regionScopeData,
  regionScopeLine,
} from "./region-scope";
export type { RegionScope, TemplateRegion } from "./region-scope";

// pub#857: a finding on every page of one page type names the type instead of listing its pages.
export {
  PAGE_TYPE_SCOPE_MIN_PAGES,
  PAGE_TYPE_SCOPE_MIN_SHARE,
  PAGE_TYPE_SCOPE_SOURCE,
  checkPageTypeScope,
  pageTypeScopeData,
  pageTypeScopeLine,
} from "./page-type-scope";
export type { PageTypeScope, PageTypeScopeCheck } from "./page-type-scope";

// Failed/blocked audit notice copy (#792, #935) — single source of truth for
// the static HTML report's FailureNotice and the dashboard's report-detail notice.
export {
  getAuditFailureNotice,
  refusedFetchLines,
  reportFailureReasonCode,
  type AuditFailureNotice,
} from "./failure-notice";

// Pages a WAF or bot manager blocked (#1253): the copy every renderer shares.
export {
  safeBlockedPage,
  safeWafBlocked,
  safeWafSuspect,
  wafBlockedPagesLines,
  wafSuspectLines,
  wafBlockedSeedCopy,
  type WafBlockedSeedCopy,
} from "./waf-blocked";

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

export {
  PAGE_MAP_COLUMNS,
  PAGE_MAP_DUPLICATE,
  PAGE_MAP_FLAG_RULES,
  PAGE_MAP_MISSING,
  PAGE_MAP_RULE_IDS,
  PAGE_MAP_TOO_LONG,
  filterPageMap,
  hasPageMapFilters,
  pageMapMeta,
  renderPageMapCsv,
  renderPageMapJson,
  renderPageMapMarkdown,
} from "./page-map";
export type {
  PageMapDuplicate,
  PageMapFilters,
  PageMapMeta,
  PageMapMissing,
  PageMapRow,
} from "./page-map";
