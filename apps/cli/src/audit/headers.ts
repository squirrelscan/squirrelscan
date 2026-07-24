// Custom HTTP request headers for the crawler.
//
// `squirrel audit <url> -H 'Authorization: Bearer xyz' -H 'X-Foo: bar'`
// attaches the given headers to EVERY crawl request (pages, assets, robots,
// sitemap). Repeatable; format is `Name: Value` (split on the FIRST colon, so
// values may contain colons). Quoting is preserved verbatim so authorized-
// crawler schemes survive — e.g. `Signature-Agent: "https://shopify.com"` keeps
// its quotes. Values are SECRETS: never echo them; use redactHeaders() for any
// log/preamble output.

import {
  isValidHeaderName,
  isValidHeaderValue,
} from "@squirrelscan/utils/headers";

export interface ParsedHeadersResult {
  headers: Record<string, string>;
  errors: string[];
}

/**
 * Normalize a repeatable `--header` flag into a list of raw specs. citty
 * accumulates repeated string flags into an array; a single use is a string.
 * Unlike --fail-on we do NOT split on commas — header values legitimately
 * contain commas (e.g. structured-field Signature-Input lists).
 */
export function normalizeHeaderArgs(
  value: string | string[] | undefined
): string[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parse `Name: Value` specs into a header map. Splits on the first colon only;
 * trims surrounding whitespace from name and value but preserves the value's
 * inner content (including quotes). Later duplicates of a name win. Invalid
 * specs (no colon, empty/invalid name) are collected as errors.
 */
export function parseHeaders(specs: string[]): ParsedHeadersResult {
  const headers: Record<string, string> = {};
  const errors: string[] = [];

  for (const spec of specs) {
    const colon = spec.indexOf(":");
    if (colon === -1) {
      errors.push(
        `Invalid --header "${spec}": expected "Name: Value" (missing colon)`
      );
      continue;
    }
    const name = spec.slice(0, colon).trim();
    const value = spec.slice(colon + 1).trim();
    if (!name) {
      errors.push(`Invalid --header "${spec}": empty header name`);
      continue;
    }
    if (!isValidHeaderName(name)) {
      errors.push(
        `Invalid --header "${spec}": "${name}" is not a valid header name`
      );
      continue;
    }
    if (!isValidHeaderValue(value)) {
      errors.push(
        `Invalid --header "${name}": value contains control characters (CR/LF/NUL)`
      );
      continue;
    }
    headers[name] = value;
  }

  return { headers, errors };
}

/**
 * Redact header VALUES for any user-facing/logged output — header values may
 * carry signed credentials. Shows the name only. Use everywhere headers would
 * otherwise be printed.
 */
export function redactHeaders(
  headers: Record<string, string> | undefined
): string {
  const names = Object.keys(headers ?? {});
  if (names.length === 0) return "";
  return names.map((n) => `${n}: <redacted>`).join(", ");
}
