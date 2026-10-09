// Pages whose response body the crawler could not decode (repo#2557). The
// crawler's CrawlError.decode (packages/crawler/src/fetcher.ts) names the URL
// and content-encoding; the CLI prints those so the user can see which pages
// the audit lost without opening the crawl database.

const DECODE_FAILURE_PREFIX = "Could not decode response body from ";

export function isDecodeFailure(message: string): boolean {
  return message.startsWith(DECODE_FAILURE_PREFIX);
}

/** Console lines for the undecodable pages: the first `limit`, then a count of the rest. */
export function decodeFailureLines(
  messages: readonly string[],
  limit = 5
): string[] {
  if (messages.length === 0) return [];
  const lines = [
    `${messages.length} page(s) could not be decoded, so their content is missing from this audit:`,
  ];
  for (const message of messages.slice(0, limit)) lines.push(`  ${message}`);
  if (messages.length > limit)
    lines.push(`  ...and ${messages.length - limit} more`);
  return lines;
}
