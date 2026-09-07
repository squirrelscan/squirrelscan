// @squirrelscan/audit-engine/smart-audits — Worker-clean entry (#195).
//
// The package's main barrel (`./index`) re-exports `cloud-runner` (node:fs/os/
// path) + `adapter` (the linkedom-heavy rules barrel), so the API Worker must
// NOT import it. This entry re-exports ONLY the smart-audits merge core, the
// Promise store/orchestrator, the portable fingerprint, and the union scorer —
// whose import closure is verified node:/linkedom-free. The API imports merge +
// rescore from here; CI build-verify should grep the api bundle for leaks.

export {
  computeMerge,
  fingerprint,
  findingKey,
  flattenChecks,
} from "./merge-core";
export type {
  ComputeMergeInput,
  FlatFinding,
  MergedFinding,
  MergedState,
} from "./merge-core";

export { findingFingerprint } from "./fingerprint";

export {
  mergeFindingsPromise,
  runCloudSmartAudits,
} from "./merge-promise";
export type {
  CloudSmartAuditsInput,
  CloudSmartAuditsResult,
  MergeFindingsPromiseInput,
  SmartAuditStore,
} from "./merge-promise";

export {
  addChecksToTally,
  buildScoringResultsFromMerged,
  calculateHealthScore,
  // (#1873) The tally scorer is the bounded twin of calculateHealthScore — the
  // complete-store finalize scores from folded tallies so a 43k-finding audit
  // never has to be resident in the API isolate.
  calculateHealthScoreFromTallies,
  carriedFindingToCheck,
  emptyTally,
  getScoreColor,
  getScoreGrade,
} from "./scoring";
export type {
  CarriedFinding,
  IssueTally,
  MergedScoringInput,
  RuleTally,
  ScoringContext,
} from "./scoring";

export { reconstructCompleteResults, reconstructPageRuleChecks } from "./reconstruct";
export type { ReconstructCompleteInput } from "./reconstruct";

export { foldCompleteStoreTallies } from "./complete-store-fold";
export type { CompleteStoreTallyInput, FindingPageSource } from "./complete-store-fold";

export { buildStreamFindings, buildSkippedPassCounts } from "./stream-findings";
export type { StreamFindingLine, SkippedPassCounts } from "./stream-findings";
