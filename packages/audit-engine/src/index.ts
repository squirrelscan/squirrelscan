// @squirrelscan/audit-engine — audit orchestration, scoring, and composition
// Zero imports from apps/ — all functions sourced from local package files.

export {
  buildSiteContext,
  releaseSiteContextDocuments,
  ensureSiteContextDocuments,
  checkExternalLinksOnStorage,
  fetchResourceAssets,
  runRulesOnStorage,
  runStreamingRules,
  generateReportFromStorage,
  emptyRuleExecutionResult,
  parsePageRecord,
  parseHtmlForRules,
  getParsedPages,
  isRenderedFetch,
  renderedPageUrlsFrom,
  setAdapterLogger,
} from "./adapter";
export type {
  SiteContextPage,
  RuleExecutionResult,
  StreamingRuleExecutionResult,
  PreFetchedAssets,
  ResourceCheckOverrides,
  ExternalLinkCheckProgress,
  FullAuditReport,
  PageAudit,
  AuditSummary,
  AdapterLogger,
} from "./adapter";

export {
  calculateHealthScore,
  deriveAuditStatus,
  deriveAuditStatusFromPages,
  getScoreGrade,
  getScoreColor,
  formatHealthScore,
  buildScoringResultsFromMerged,
  // Streaming fold-to-tallies scoring (#1021)
  calculateHealthScoreFromTallies,
  foldRuleResultIntoTallies,
  addChecksToTally,
  addTally,
  emptyTally,
  ruleScoreFromTally,
} from "./scoring";
export type { AuditStatusSignals } from "./scoring";
export type {
  ScoringContext,
  CarriedFinding,
  MergedScoringInput,
  IssueTally,
  RuleTally,
} from "./scoring";

export {
  buildReportTechnologies,
  detectReportTechnologies,
  detectReportTechnologiesMulti,
  withWafTech,
} from "./technologies";
export type { LocalTechInput, TechScanDiff } from "./technologies";

// Smart audits — finding merge / supplant (#110/#195)
export { mergeFindings, flattenChecks, findingKey, fingerprint, computeMerge } from "./merge";
export type {
  FlatFinding,
  MergedFinding,
  MergedState,
  MergeInput,
  ComputeMergeInput,
} from "./merge";
export { findingFingerprint } from "./fingerprint";
// Cloud (Worker) merge — also available leak-free via the `./smart-audits` entry.
export { mergeFindingsPromise, runCloudSmartAudits } from "./merge-promise";
export type {
  SmartAuditStore,
  MergeFindingsPromiseInput,
  CloudSmartAuditsInput,
  CloudSmartAuditsResult,
} from "./merge-promise";
export { reconstructCompleteResults } from "./reconstruct";
export type { ReconstructCompleteInput } from "./reconstruct";
// Chunked-publish producer: flatten a report to complete streamable findings (#1023).
export { buildStreamFindings, buildSkippedPassCounts } from "./stream-findings";
export type { StreamFindingLine, SkippedPassCounts } from "./stream-findings";

export * from "./cloud-prefetch";
export * from "./cloud-prefetch-run";
// Explicit re-export: bun test can't resolve createCloudDocumentFetcher via `export *` #385
export {
  mapRenderItemToResponse,
  terminalFallbackReason,
  isRenderBlocked,
  createCloudDocumentFetcher,
} from "./cloud-fetcher";
export type { CloudFetcherOptions } from "./cloud-fetcher";
export * from "./composition";
export * from "./runner";

// Threat-intel wiring (#117) — resolves opt-in `[intel]` config into ctx.intel.
export {
  localIntelContext,
  buildFullIntelContext,
  mapIntelConfig,
  collectIntelUrls,
} from "./intel";

// Cloaking differential probe (#118) — opt-in, bounded; both adapters call
// probeSiteForCloaking and thread the result onto SiteData.cloakingProbes.
export {
  resolveCloakingProbes,
  probeSiteForCloaking,
  runCloakingProbe,
  selectSuspiciousPaths,
  classifyDivergence,
  visibleTokens,
  jaccard,
  appendProbeToken,
  parseLastmod,
  UA_SIMILARITY_THRESHOLD,
  TOKEN_SIMILARITY_THRESHOLD,
  PROBE_QUERY_PARAM,
} from "./cloaking-probe";
export type {
  CloakingProbeOptions,
  CloakingProbeToggle,
  CloakingCandidate,
  SelectedProbe,
  ProbeResponse,
  ProbeFetch,
  CloakingProbePage,
  CloakingProbeSiteInput,
} from "./cloaking-probe";

// Page-rule execution seam (#263) — isolates the dominant page-rules phase
// behind a small interface; serial is the only shipped backend.
export {
  type PageRuleExecutor,
  type PageRuleLoopHooks,
  type PageRuleTask,
  type PageRuleTaskResult,
  SerialPageRuleExecutor,
  runAndDispose,
} from "./page-rule-executor";

// #1252: tarpit-aware fetch budget for the resource-asset step.
export {
  createFetchBudget,
  type FetchBudget,
  type FetchBudgetOptions,
  type FetchBudgetSummary,
  type FetchOutcome,
} from "./fetch-budget";

// Re-export tech detection types for consumers
export type { DetectedTechnology, TechCategory } from "@squirrelscan/tech-detect";

// Publish-prep meta shared by the CLI publish controller and runCloudAudit (#656)
export { computeLockedRules, deriveHomepageSummary } from "./publish-meta";

// Re-export checker types + impl for consumers (CLI re-exports checkResourceSizes)
export { checkResourceSizes, varyForbidsReuse } from "./resource-checker";
export type { ResourceCheckResult, ResourceCheckerOptions } from "./resource-checker";
export type { ScriptFetchResult } from "./script-fetcher";
export type { ExternalCheckResult, LinkCache, LinkCacheEntry } from "./external-checker";

// SiteQuery factory (#1022) — streaming-engine aggregate view over a crawl.
export { createSiteQuery } from "./site-query";

// Page-time feature extraction (#1022, PR-D) — the one writer E-E calls per page.
export { extractPageFeatures, isAuditablePage } from "./page-features";
export { isHtmlContentType } from "./adapter";

// Streaming rules engine (#1021, PR-E) — batched page-rule pass with DOM-drop.
export { streamPageRules, STREAM_PAGE_BATCH } from "./streaming";
export type { PageSignalCollector, StreamPageRulesHooks, StreamPageRulesResult } from "./streaming";
