// Re-exports from @squirrelscan/audit-engine
export {
  calculateHealthScore,
  deriveAuditStatus,
  deriveAuditStatusFromPages,
  withoutUnobservedScores,
  getScoreGrade,
  getScoreColor,
  formatHealthScore,
} from "@squirrelscan/audit-engine";
export type { ScoringContext } from "@squirrelscan/audit-engine";
