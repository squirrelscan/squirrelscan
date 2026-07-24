// Audit domain module exports

export {
  calculateHealthScore,
  getScoreGrade,
  getScoreColor,
  formatHealthScore,
  type ScoringContext,
} from "./scoring";

export {
  generateConsoleReport,
  generateJsonReport,
  generateHtmlReport,
} from "./report";

export {
  runRulesOnStorage,
  generateReportFromStorage,
  parsePageRecord,
  getParsedPages,
  type RuleExecutionResult,
  type ProgressCallback,
} from "./adapter";
