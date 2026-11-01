// URLs the crawl requested but stored no page for (#1396): the rows `--include-pages` adds after the crawled pages.

import type { UnstoredPage } from "@squirrelscan/core-contracts";

/** The frontier's own skip reasons, as short codes a consumer can match on. */
const SKIP_REASONS: Readonly<Record<string, string>> = {
  robots_disallowed: "robots-disallowed",
  excluded: "excluded",
  not_included: "not-included",
  cross_domain: "other-site",
  url_too_long: "url-too-long",
  invalid_url: "invalid-url",
};

/**
 * Failure messages, as short codes. A crawl's error text can carry a URL (an off-site redirect target with its query),
 * a host, an address or the start of a response body, none of which belongs in a report that is shared: the reason a
 * failed request is listed is one of these codes, never the message.
 */
const FAILURE_CODES: ReadonlyArray<[RegExp, string]> = [
  [/^rate limited/i, "rate-limited"],
  [/^off-site redirect/i, "off-site-redirect"],
  [/too many redirects|redirect loop|maximum redirect/i, "too-many-redirects"],
  [/timed? ?out|timeout|aborted/i, "timeout"],
  [/ECONNREFUSED|connection refused/i, "connection-refused"],
  [/ECONNRESET|connection reset|socket|closed|ended|EPIPE/i, "connection-reset"],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo|\bdns\b/i, "dns"],
  [/certificate|\bssl\b|\btls\b|CERT_/i, "tls"],
  [/decode|encoding|body/i, "unreadable-body"],
];

/**
 * The listing row of one frontier entry that has no stored page. `skipped` entries are URLs the crawl chose not to
 * request (the crawl's own reason becomes a code); `failed` ones are requests that did not produce a stored response:
 * `http-<status>` for an HTTP error, otherwise one of {@link FAILURE_CODES} or `request-failed`. The reason is always
 * from a fixed vocabulary: it never carries a URL, a query string, a token or response text.
 */
export function unstoredPageRow(entry: { url: string; status: "failed" | "skipped"; reason: string | null }): UnstoredPage {
  const raw = entry.reason ?? "";
  if (entry.status === "skipped") {
    return { url: entry.url, outcome: "skipped", reason: SKIP_REASONS[raw] ?? "skipped" };
  }
  const http = /^HTTP (\d{3})\b/.exec(raw);
  if (http) return { url: entry.url, outcome: "error", reason: `http-${http[1]}` };
  for (const [pattern, code] of FAILURE_CODES) if (pattern.test(raw)) return { url: entry.url, outcome: "error", reason: code };
  return { url: entry.url, outcome: "error", reason: "request-failed" };
}
