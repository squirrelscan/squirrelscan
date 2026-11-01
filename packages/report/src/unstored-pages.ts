// URLs the crawl requested but stored no page for (#1396): the rows `--include-pages` adds after the crawled pages.

import { stripUnsafeLineText } from "@squirrelscan/core-contracts/control-chars";
import type { UnstoredPage } from "@squirrelscan/core-contracts";

/** Longest reason kept: an error message is page-controlled text and a report stays bounded. */
const MAX_REASON_CHARS = 200;

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
 * The listing row of one frontier entry that has no stored page. `skipped` entries are URLs the crawl chose not to
 * request (its reason becomes a code); `failed` ones are requests that did not produce a stored response: a throttled
 * host is `rate-limited`, anything else keeps its error message, cleaned and bounded.
 */
export function unstoredPageRow(entry: { url: string; status: "failed" | "skipped"; reason: string | null }): UnstoredPage {
  const raw = entry.reason ?? "";
  if (entry.status === "skipped") {
    return { url: entry.url, outcome: "skipped", reason: SKIP_REASONS[raw] ?? (raw ? clean(raw) : "skipped") };
  }
  if (/^rate limited\b/i.test(raw)) return { url: entry.url, outcome: "error", reason: "rate-limited" };
  return { url: entry.url, outcome: "error", reason: raw ? clean(raw) : "request-failed" };
}

function clean(text: string): string {
  const line = stripUnsafeLineText(text).replace(/ {2,}/g, " ").trim();
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS)}...` : line;
}
