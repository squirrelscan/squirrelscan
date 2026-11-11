// One resume decision for `squirrel audit --resume` and `squirrel crawl --resume` (#1658).
//
// Both commands used to carry their own copy of this logic (and of `isDirtyConfig`), and every
// "not resuming because..." reason went through `logger.warn`/`logger.debug`, so a run that
// silently started a fresh crawl looked like one that resumed. The decision is a pure function of
// the stored crawl, the flags and the lease claim; the reason is printed on stderr and carried in
// the JSON report.

import type {
  CrawlerConfigSnapshot,
  CrawlMetadata,
  ResumeOutcome,
  ResumeRefusalReason,
} from "@squirrelscan/core-contracts";
import type { CrawlLeaseClaim } from "@squirrelscan/crawler";

import { logger } from "@/utils/logger";

/**
 * Fields of the crawler config that change which pages a crawl covers: a resume under different
 * ones would mix two scopes in one crawl. Type-checked against CrawlerConfigSnapshot so a field
 * rename fails at compile time.
 */
const DIRTY_CONFIG_FIELDS = [
  "include",
  "exclude",
  "allowedDomains",
  "allowQueryParams",
  "dropQueryPrefixes",
  // #1777: a targeted run and a normal one (or two different lists) are different scopes either way.
  "targetUrls",
] as const satisfies ReadonlyArray<keyof CrawlerConfigSnapshot>;

/** Whether config changes require a fresh crawl (a scope-affecting field changed). */
export function isDirtyConfig(
  oldConfig: CrawlerConfigSnapshot,
  newConfig: Partial<CrawlerConfigSnapshot>
): boolean {
  for (const field of DIRTY_CONFIG_FIELDS) {
    const oldVal = JSON.stringify(oldConfig[field]);
    const newVal = JSON.stringify(newConfig[field]);
    if (oldVal !== newVal) {
      logger.debug("dirty config field", field, oldVal, "→", newVal);
      return true;
    }
  }
  return false;
}

/** Why a requested resume started a new crawl instead. */
export type ResumeRefusal = ResumeRefusalReason;

export type ResumeDecision =
  | { resume: true }
  | { resume: false; reason: ResumeRefusal; message: string };

/** Crawl statuses that still have a frontier to continue. `stopped` is a crawl-phase backstop cut (#969). */
const RESUMABLE: ReadonlySet<CrawlMetadata["status"]> = new Set([
  "running",
  "paused",
  "stopped",
]);

export interface ResumeInput {
  /** The latest stored crawl of the origin, or null when there is none. */
  existingCrawl: CrawlMetadata | null;
  /** The crawler config this run would use. */
  crawlerConfig: Partial<CrawlerConfigSnapshot>;
  refresh: boolean;
  /**
   * Takes the crawl's lease. Called only when every other gate passed, so a refused resume never
   * touches the lease; the claim it returns decides the last two refusals.
   */
  claim: (crawlId: string) => CrawlLeaseClaim;
}

function claimRefusal(
  crawlId: string,
  claim: Exclude<CrawlLeaseClaim, { acquired: true }>
): ResumeDecision {
  if (claim.ownerPid !== undefined || claim.ownerHost !== undefined) {
    return {
      resume: false,
      reason: "lease-held",
      message: `crawl ${crawlId} is active in pid ${claim.ownerPid ?? "unknown"} on ${claim.ownerHost ?? "unknown"}`,
    };
  }
  return {
    resume: false,
    reason: "lease-unavailable",
    message: `ownership of crawl ${crawlId} could not be established`,
  };
}

/**
 * The single resume decision, for a run that was asked to resume. The first gate that fails names
 * the reason; the order is the one a user would check by hand.
 */
export function decideResume(input: ResumeInput): ResumeDecision {
  const { existingCrawl, crawlerConfig, refresh } = input;
  if (refresh) {
    return {
      resume: false,
      reason: "refresh-requested",
      message: "--resume and --refresh are mutually exclusive, using --refresh",
    };
  }
  if (!existingCrawl) {
    return {
      resume: false,
      reason: "no-prior-crawl",
      message: "no previous crawl found for this site",
    };
  }
  if (existingCrawl.retiredAt !== undefined) {
    return {
      resume: false,
      reason: "reclaimed",
      message: `crawl ${existingCrawl.id} was reclaimed by \`squirrel self disk --prune\` or retention and cannot continue`,
    };
  }
  if (existingCrawl.status === "failed") {
    return {
      resume: false,
      reason: "crawl-failed",
      message: `previous crawl ${existingCrawl.id} failed`,
    };
  }
  if (!RESUMABLE.has(existingCrawl.status)) {
    return {
      resume: false,
      reason: "crawl-finished",
      message: `previous crawl ${existingCrawl.id} finished (${existingCrawl.status}), nothing left to resume`,
    };
  }
  if (isDirtyConfig(existingCrawl.config, crawlerConfig)) {
    return {
      resume: false,
      reason: "config-changed",
      message:
        "the include, exclude or URL settings changed since the previous crawl",
    };
  }
  const claim = input.claim(existingCrawl.id);
  if (!claim.acquired) return claimRefusal(existingCrawl.id, claim);
  return { resume: true };
}

/** Outcome for a run that passed `--resume`. */
export type { ResumeOutcome };
export function resumeOutcome(decision: ResumeDecision): ResumeOutcome {
  return decision.resume
    ? { requested: true, resumed: true }
    : {
        requested: true,
        resumed: false,
        reason: decision.reason,
        message: decision.message,
      };
}

/** The line printed on stderr when a requested resume did not happen. */
export function formatResumeRefusal(
  decision: Extract<ResumeDecision, { resume: false }>
): string {
  return `--resume requested but not resuming (${decision.reason}): ${decision.message}; starting a new crawl`;
}
