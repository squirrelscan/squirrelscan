// Crawl lease for a CLI command (#946): hold it from the start of the command
// to the end of its `finally`, so it covers the crawl, --resume, and the
// analyzed / report-building window. A resume claims it before crawling.

import {
  startCrawlLease,
  type CrawlLease,
  type CrawlLeaseClaim,
} from "@squirrelscan/crawler";

import type { CrawlStorage } from "@/crawler/storage";

const NOOP: CrawlLease = {
  beat: () => false,
  claim: () => ({ acquired: true }),
  release: () => {},
};
const UNAVAILABLE: CrawlLease = {
  beat: () => false,
  claim: () => ({ acquired: false }),
  release: () => {},
};

/** Explain why a resume candidate could not become this process's crawl. */
export function formatResumeClaimWarning(
  crawlId: string,
  claim: Exclude<CrawlLeaseClaim, { acquired: true }>
): string {
  if (claim.ownerPid !== undefined || claim.ownerHost !== undefined) {
    return `--resume requested but crawl ${crawlId} is active in pid ${claim.ownerPid ?? "unknown"} on ${claim.ownerHost ?? "unknown"}; starting new`;
  }
  return `--resume requested but ownership of crawl ${crawlId} could not be established; starting new`;
}

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
    return UNAVAILABLE;
  }
}
