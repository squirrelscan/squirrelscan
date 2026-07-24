// Commands barrel export

// Types
export {
  type Result,
  type CommandError,
  type ErrorCode,
  ErrorCodes,
  ok,
  err,
  commandError,
} from "./types";

// Audit
export {
  runAudit,
  type RunAuditOptions,
  type AuditProgress,
  type ProgressCallback,
} from "./audit";

// Init
export { initConfig, type InitOptions, type InitResult } from "./init";

// Config
export {
  showConfig,
  setConfigValue,
  getConfigPath,
  type ShowConfigResult,
  type SetConfigResult,
} from "./config";

// Report
export { loadReport, validateFormat, type OutputFormat } from "./report";
