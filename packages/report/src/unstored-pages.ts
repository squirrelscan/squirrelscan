// URLs the crawl requested but stored no page for (#1396): the rows `--include-pages` adds after the crawled pages.

import type { UnstoredPage, UnstoredPageReason } from "@squirrelscan/core-contracts";

/** A listed URL is cut here: a skipped `url_too_long` entry can be megabytes. */
const MAX_URL_CHARS = 2_048;

/** The frontier's own skip reasons, as codes. Anything else a skip carried is `skipped`. */
const SKIP_REASONS: Readonly<Record<string, UnstoredPageReason>> = {
  robots_disallowed: "robots-disallowed",
  excluded: "excluded",
  not_included: "not-included",
  cross_domain: "other-site",
  url_too_long: "url-too-long",
};

/**
 * Failure messages the crawl writes, as codes. The text of a failure can carry a URL (an off-site redirect target with
 * its query, the page a decode error names), a host, an address or the start of a response body, none of which belongs
 * in a shared report: a failed request's reason is one of these codes, never the message. The crawl's own messages are
 * matched at their start; for a transport error's free text, URLs are removed first so a path such as `/timeout` or
 * `/ssl` cannot name a cause.
 */
const OWN_MESSAGES: ReadonlyArray<[RegExp, UnstoredPageReason]> = [
  [/^rate limited\b/i, "rate-limited"],
  [/^off-site redirect\b/i, "off-site-redirect"],
  [/^request blocked\b/i, "blocked"],
  [/^blocked by\b/i, "blocked"],
  [/^could not decode\b/i, "unreadable-body"],
  [/^tls\/connection error\b/i, "tls"],
  [/^crawl request timed out\b/i, "timeout"],
];
const TRANSPORT_TEXT: ReadonlyArray<[RegExp, UnstoredPageReason]> = [
  [/too many redirects|redirect loop|maximum redirect/i, "too-many-redirects"],
  [/timed out|\btimeout\b|\baborted\b/i, "timeout"],
  [/\bECONNREFUSED\b|connection refused/i, "connection-refused"],
  [/\bECONNRESET\b|\bEPIPE\b|connection reset|socket hang up|unexpectedly closed/i, "connection-reset"],
  [/\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo/i, "dns"],
  [/\bCERT_[A-Z_]+\b|self[- ]signed|unable to verify the (?:first )?certificate/i, "tls"],
];

/**
 * The listing row of one frontier entry that has no stored page. `skipped` entries are URLs the crawl chose not to
 * request; `failed` ones are requests that did not produce a stored response. The reason is always from the fixed
 * vocabulary of {@link UnstoredPageReason}: never a URL, a query string, a token or response text.
 */
export function unstoredPageRow(entry: { url: string; status: "failed" | "skipped"; reason: string | null }): UnstoredPage {
  const url = entry.url.length > MAX_URL_CHARS ? `${entry.url.slice(0, MAX_URL_CHARS)}...` : entry.url;
  const raw = entry.reason ?? "";
  if (entry.status === "skipped") return { url, outcome: "skipped", reason: SKIP_REASONS[raw] ?? "skipped" };
  const http = /^(?:HTTP|Server error:?) (\d{3})\b/i.exec(raw);
  if (http) return { url, outcome: "error", reason: `http-${Number(http[1])}` };
  for (const [pattern, code] of OWN_MESSAGES) if (pattern.test(raw)) return { url, outcome: "error", reason: code };
  const text = raw.replace(/(?:\b[a-z][a-z0-9+.-]*:)?\/\/\S*/gi, " ");
  for (const [pattern, code] of TRANSPORT_TEXT) if (pattern.test(text)) return { url, outcome: "error", reason: code };
  return { url, outcome: "error", reason: "request-failed" };
}
