// Shared validation for user-supplied HTTP request headers (#494, #532).
// These values are replayed onto outbound crawl/render requests, so a CR/LF/NUL
// in a value would enable header injection / request splitting — reject them.

// RFC 7230 token — valid header field-name characters.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// RFC 7230 field-value chars: HTAB (0x09), SP (0x20), VCHAR (0x21-0x7e),
// obs-text (0x80-0xff). Excludes CR, LF, NUL, and all other control chars.
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** True if `name` is a valid RFC 7230 header field-name (token). */
export function isValidHeaderName(name: string): boolean {
  return HEADER_NAME_RE.test(name);
}

/** True if `value` contains only safe RFC 7230 field-value chars (no CR/LF/NUL/CTL). */
export function isValidHeaderValue(value: string): boolean {
  return HEADER_VALUE_RE.test(value);
}

// A DocumentFetcher's `headers["set-cookie"]` is "\n"-joined, one real
// Set-Cookie header per line (packages/fetchers/src/index.ts's headersToRecord,
// squirrelscan/repo#973) — necessary because repeated Set-Cookie headers are
// the one case `Headers` never combines, so they have to be flattened into a
// single record string somehow. Rehydrating that joined string back into a
// Headers object via `headers.set("set-cookie", joined)` — or via the
// `new Headers(record)` constructor, which hits the same code path — THROWS
// (a raw "\n" is not a legal single header value). Split and `append()` each
// cookie instead, which is how `Headers` natively keeps repeated Set-Cookie
// entries distinct. Any other malformed header value is skipped rather than
// throwing, so one bad header can't take down the whole rehydration.
/** Rehydrate a Headers object from a stored header record (e.g. a DocumentFetcher response). */
export function recordToHeaders(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "set-cookie") {
      for (const cookie of value.split("\n")) {
        const trimmed = cookie.trim();
        if (!trimmed) continue;
        try {
          headers.append("set-cookie", trimmed);
        } catch {
          // Ignore invalid header values and continue.
        }
      }
      continue;
    }
    try {
      headers.set(key, value);
    } catch {
      // Ignore invalid header values and continue.
    }
  }
  return headers;
}
