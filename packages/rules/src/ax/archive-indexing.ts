// ax/archive-indexing - is the site in the web archives that feed AI training
// corpora? (cloud-backed, site-scope, #789)
//
// Two independent lookups: the Wayback Machine and the Common Crawl index.
// Common Crawl is NOT a subset of Wayback — CC runs its own crawler (CCBot)
// and the Internet Archive ingests CC's crawls, so a Wayback snapshot does not
// imply CC inclusion. CC is the one that matters most for AI: it is a primary
// training/discovery corpus for the major labs.

import type { ArchiveIndexingResponse, ArchivePresence } from "@squirrelscan/core-contracts";

import { humanizeCloudSkip, readCloudResult } from "../cloud";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** A capture older than this is reported as stale. */
const STALE_CAPTURE_MS = 365 * 24 * 60 * 60 * 1000;

function captureAge(p: ArchivePresence, now: number): number | null {
  if (!p.latestCapture) return null;
  const t = Date.parse(p.latestCapture);
  return Number.isFinite(t) ? now - t : null;
}

export const archiveIndexingRule: Rule = {
  meta: {
    id: "ax/archive-indexing",
    name: "Archive Indexing",
    description:
      "Checks whether the site is present in the Wayback Machine and the Common Crawl index — the archives that feed AI training corpora and agent discovery pipelines",
    solution:
      "Make sure robots.txt does not block CCBot (Common Crawl) or ia_archiver (Internet Archive), then request a Wayback snapshot at web.archive.org/save. Common Crawl inclusion follows from being crawlable and linked; there is no manual submission, so fix crawlability and wait for the next monthly crawl.",
    category: "ax",
    scope: "site",
    severity: "warning",
    weight: 1,
    cloud: { service: "archive-indexing", unit: "site", creditFeature: "archive_indexing" },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const envelope = readCloudResult<ArchiveIndexingResponse>(ctx.cloudResults, "archive-indexing");
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason =
        envelope?.status === "skipped" ? (envelope.skipReason ?? "not-prefetched") : "not-prefetched";
      checks.push({
        name: "archive-indexing",
        status: "skipped",
        message: "Archive indexing check skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    const { domain, wayback, commonCrawl, capturedAt } = envelope.data;
    const now = Date.parse(capturedAt) || Date.now();

    // Common Crawl is the check with teeth: CC is a primary AI training corpus,
    // so absence means the site is invisible to CC-derived training sets.
    if (commonCrawl.indexed) {
      const age = captureAge(commonCrawl, now);
      const stale = age !== null && age > STALE_CAPTURE_MS;
      checks.push({
        name: "common-crawl-indexed",
        status: stale ? "warn" : "pass",
        message: stale
          ? `Site is in the Common Crawl index but the latest capture is over a year old — recent content is missing from CC-derived AI training data`
          : `Site is in the Common Crawl index${commonCrawl.source ? ` (${commonCrawl.source})` : ""}`,
        value: commonCrawl.latestCapture ?? "indexed",
        details: { domain, source: commonCrawl.source, latestCapture: commonCrawl.latestCapture },
      });
    } else {
      checks.push({
        name: "common-crawl-indexed",
        status: "warn",
        message:
          "Site is not in the Common Crawl index — Common Crawl feeds the training corpora of the major AI labs, so the site is invisible to models trained on it",
        value: "absent",
        details: { domain, source: commonCrawl.source },
      });
    }

    if (wayback.indexed) {
      const age = captureAge(wayback, now);
      const stale = age !== null && age > STALE_CAPTURE_MS;
      checks.push({
        name: "wayback-archived",
        status: stale ? "warn" : "pass",
        message: stale
          ? "Site is in the Wayback Machine but the latest snapshot is over a year old"
          : "Site is archived in the Wayback Machine",
        value: wayback.latestCapture ?? "indexed",
        details: { domain, latestCapture: wayback.latestCapture },
      });
    } else {
      checks.push({
        name: "wayback-archived",
        status: "warn",
        message:
          "Site has no Wayback Machine snapshot — the Internet Archive has never captured it, a strong signal the archive crawlers can't reach or discover it",
        value: "absent",
        details: { domain },
      });
    }

    return { checks };
  },
};
