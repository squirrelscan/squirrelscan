// Typed errors for the cloud client. The prefetch layer maps `code` → a
// `CloudSkipReason` so rules surface a consistent, human hint on failure.

export type CloudErrorCode =
  | "not_authenticated" // 401 — token missing/expired/invalid
  | "insufficient_credits" // 402 — balance below the call cost
  | "invalid_request" // 400 (incl. batch caps / validation)
  | "payload_too_large" // 413 — request body over the API's 5MB limit
  | "duplicate_request" // 409 — server already charged this exact payload (replay)
  | "run_inactive" // 409 RUN_NOT_ACTIVE — the cloud run was reaped/failed before this charge landed (#475)
  | "service_unavailable" // 5xx — provider/API failure
  | "network_error"; // transport failure (timeout, DNS, reset)

/** Error thrown by every client method on a non-2xx response or transport failure. */
export class CloudClientError extends Error {
  readonly code: CloudErrorCode;
  /** HTTP status, or 0 for a transport-level failure. */
  readonly status: number;
  /** Credits required, present on `insufficient_credits` (402). */
  readonly required?: number;

  constructor(
    code: CloudErrorCode,
    status: number,
    message: string,
    opts?: { required?: number; cause?: unknown },
  ) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = "CloudClientError";
    this.code = code;
    this.status = status;
    this.required = opts?.required;
  }
}

/** Map an HTTP status to a client error code. */
export function codeForStatus(status: number): CloudErrorCode {
  if (status === 401) return "not_authenticated";
  if (status === 402) return "insufficient_credits";
  if (status === 400) return "invalid_request";
  if (status === 413) return "payload_too_large";
  if (status === 409) return "duplicate_request";
  return "service_unavailable";
}
