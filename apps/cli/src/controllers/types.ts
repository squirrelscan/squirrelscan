// Command result types for interface-agnostic command execution

/**
 * Result type for command execution
 * Commands return success with data or failure with error
 */
export type Result<T, E = CommandError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

/**
 * Standard error structure for commands
 */
export interface CommandError {
  code: string;
  message: string;
  details?: unknown;
}

// Helper functions for creating results
export function ok<T>(data: T): Result<T, never> {
  return { ok: true, data };
}

export function err<E = CommandError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function commandError(
  code: string,
  message: string,
  details?: unknown
): CommandError {
  return { code, message, details };
}

/**
 * Extract a human message from an API error body's `error` field. The API uses
 * the typed envelope `{ error: { code, message } }`; older deploys returned a
 * bare `{ error: "..." }` string. Returns undefined when neither is present, so
 * callers can fall back to a status-based default.
 */
export function apiErrorMessage(
  error: string | { code?: string; message?: string } | null | undefined
): string | undefined {
  if (typeof error === "string") return error;
  return error?.message;
}

// Common error codes
export const ErrorCodes = {
  // Validation
  INVALID_URL: "INVALID_URL",
  INVALID_FORMAT: "INVALID_FORMAT",
  INVALID_CONFIG: "INVALID_CONFIG",
  INVALID_VALUE: "INVALID_VALUE",

  // File operations
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  FILE_EXISTS: "FILE_EXISTS",
  FILE_READ_ERROR: "FILE_READ_ERROR",
  FILE_WRITE_ERROR: "FILE_WRITE_ERROR",

  // Config
  CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",

  // Network
  NETWORK_ERROR: "NETWORK_ERROR",
  CRAWL_ERROR: "CRAWL_ERROR",
  UNREACHABLE: "UNREACHABLE",

  // Crawl/Analyze
  CRAWL_NOT_FOUND: "CRAWL_NOT_FOUND",
  CRAWL_NOT_READY: "CRAWL_NOT_READY",

  // General
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
