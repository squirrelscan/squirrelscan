/**
 * Sensitive data redaction utilities
 * Used by logger and potentially other modules that handle sensitive data
 */

// Sensitive headers to redact (lowercase for comparison)
export const SENSITIVE_HEADERS = [
  "authorization",
  "x-api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
  "x-access-token",
  "x-secret-key",
] as const;

/**
 * Redact sensitive data from a string (URLs, auth headers, etc.)
 * Uses inline regex to avoid global state issues with shared patterns.
 */
export function redactString(value: string): string {
  let result = value;
  // URL userinfo: https://user:pass@host -> https://[REDACTED]@host
  result = result.replace(
    /(https?:\/\/)([^:@/]+):([^@/]+)@/gi,
    "$1[REDACTED]@"
  );
  // URL query params: ?api_key=xxx or &token=xxx
  result = result.replace(
    /([?&])(api[_-]?key|apikey|key|token|auth|secret|password|pwd|access_token|client_secret)=([^&\s]*)/gi,
    "$1$2=[REDACTED]"
  );
  // Bearer tokens
  result = result.replace(
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    "Bearer [REDACTED]"
  );
  // Basic auth
  result = result.replace(/Basic\s+[A-Za-z0-9+/]+=*/gi, "Basic [REDACTED]");
  return result;
}

/**
 * Recursively redact sensitive data from an object
 */
export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Redact sensitive header values
      if (
        SENSITIVE_HEADERS.includes(
          key.toLowerCase() as (typeof SENSITIVE_HEADERS)[number]
        )
      ) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactValue(val);
      }
    }
    return result;
  }

  return value;
}

/**
 * Check if a header key is sensitive and should be redacted
 */
export function isSensitiveHeader(key: string): boolean {
  return SENSITIVE_HEADERS.includes(
    key.toLowerCase() as (typeof SENSITIVE_HEADERS)[number]
  );
}
