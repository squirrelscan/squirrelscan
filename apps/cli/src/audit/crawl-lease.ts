// Crawl lease for a CLI command (#946): hold it from the start of the command
// to the end of its `finally`, so it covers the crawl, --resume, and the
// analyzed / report-building window. Write-only for now.

import { startCrawlLease, type CrawlLease } from "@squirrelscan/crawler";

import type { CrawlStorage } from "@/crawler/storage";

const NOOP: CrawlLease = { beat: () => false, release: () => {} };

/** Start the lease for the crawl `getCrawlId` names; a no-op on a non-file store. */
export function startLeaseForStorage(
  storage: CrawlStorage,
  getCrawlId: () => string | null
): CrawlLease {
  const dbPath = (storage as { dbPath?: unknown }).dbPath;
  if (typeof dbPath !== "string") return NOOP;
  try {
    return startCrawlLease({ dbPath, getCrawlId });
  } catch {
    return NOOP;
  }
}
