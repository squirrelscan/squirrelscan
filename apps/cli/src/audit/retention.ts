// Automatic retention: keep the newest N audits per project (#1912).
//
// Before this, a re-audit wrote a whole new crawl and retired nothing, so
// `project.db` grew by about one audit every time — 95 MB per audit of a
// 1,000-page site, 940 MB for a 10,000-page one, forever. Nothing told the user,
// and nothing cleaned up.
//
// This runs at the END of a successful audit, once the report has been built,
// and it retires the audits that fall outside `[storage] keep_audits`. It never
// touches the crawl that just ran, a crawl still being written, or a failed one.
// A failure here is swallowed by the caller: a retention pass must never be the
// reason an audit that otherwise worked reports an error.
//
// KNOWN, and left as it is: a crawl is stamped `analyzed` BEFORE its own report
// is reconstructed, so between those two points another audit of the same
// project could in principle retire it. It needs concurrent audits of one
// project outnumbering the window — four at the default of 3 — and the outcome
// is the refusal #259 built for exactly this, not a wrong report:
// `reconstructReport` re-reads the retirement stamp after every read and fails
// with "Audit data was reclaimed on <date>". Closing the window properly needs a
// lease on the crawl, which is a bigger change than this and not one a deletion
// pass should invent on its own.

import type { AuditStatus } from "@squirrelscan/core-contracts";

import { auditStatusToLifecycle } from "@squirrelscan/core-contracts";
import { Effect } from "effect";

import type { SQLiteStorage } from "@/crawler/storage/sqlite";

import { formatBytes } from "@/self/disk";

/**
 * Rewrite the file only when the freed space is a large share of it.
 *
 * VACUUM returns freed pages to the filesystem, and it does that by rewriting
 * the whole database. That is the right thing to do once, on request
 * (`self disk --prune`), and a serious regression on the audit path.
 */
const VACUUM_MIN_BYTES = 200 * 1024 * 1024;
const VACUUM_MIN_SHARE = 0.25;

export interface RetentionOutcome {
  /** Audits retired by this pass. Never 0 — a no-op returns null instead. */
  readonly retired: number;
  /**
   * Bytes the deletes freed inside the file, measured as the growth of the
   * SQLite freelist rather than estimated from row counts.
   */
  readonly freedBytes: number;
  /** Whether the file was rewritten, so the space went back to the filesystem. */
  readonly vacuumed: boolean;
  /** No audit in this project had ever been retired before this pass. */
  readonly firstRetirement: boolean;
  /** The window that produced this, for the notice. */
  readonly keep: number;
}

export interface RetentionOptions {
  /** `[storage] keep_audits`. 0 or less disables the pass entirely. */
  readonly keep: number;
  /** The audit that just ran. Never retired, whatever the window says. */
  readonly currentCrawlId: string;
}

/**
 * Whether an audit that produced this report is allowed to retire history.
 *
 * A run can reach the end and still not be an audit: a site that answers 403 or
 * is down produces a report whose own status is `blocked` or `failed`, and the
 * command exits nonzero on it. Deleting good history on the strength of one of
 * those is the worst thing this feature could do — a week of a site being down
 * would quietly take the audits you would use to find out when it broke.
 *
 * `auditStatusToLifecycle` is the existing definition of that line, reused
 * rather than restated, so this reads the same as the dashboard's. `partial`
 * counts as a real audit: it has real findings on the pages it did reach.
 */
export function auditMayRetire(status: AuditStatus | undefined): boolean {
  return auditStatusToLifecycle(status) === "completed";
}

/**
 * Decide which audits fall outside the window.
 *
 * Split out from the storage calls so the policy — which is the part that
 * silently deletes someone's reports — can be tested on its own.
 *
 * `candidates` is newest first and holds only the audits that can still be
 * opened: `listRetentionCandidates` excludes running and failed crawls, and
 * already-retired ones. That last exclusion is what makes `keep` mean "reports
 * you can open" — letting a retired audit hold a slot would keep fewer than
 * asked, and re-retiring one would delete nothing at a cost.
 */
export function selectCrawlsToRetire(
  candidates: ReadonlyArray<{ id: string }>,
  options: RetentionOptions
): string[] {
  if (!Number.isFinite(options.keep) || options.keep <= 0) return [];
  return candidates
    .slice(options.keep)
    .filter((crawl) => crawl.id !== options.currentCrawlId)
    .map((crawl) => crawl.id);
}

/**
 * Retire the audits outside the window, and reclaim what that freed.
 *
 * Returns null when there was nothing to do, which is the common case: a
 * project only has something to retire once it has run more audits than the
 * window keeps. Costs one small query over `crawls` when there is not.
 */
export async function retainRecentAudits(
  storage: SQLiteStorage,
  options: RetentionOptions
): Promise<RetentionOutcome | null> {
  if (!Number.isFinite(options.keep) || options.keep <= 0) return null;

  const candidates = await Effect.runPromise(storage.listRetentionCandidates());
  const retiring = selectCrawlsToRetire(candidates, options);
  if (retiring.length === 0) return null;

  // "The first time an audit retires anything" for THIS project, read off the
  // audits themselves rather than off a settings file, so it stays true when
  // the project is copied, and cannot drift from what the database actually
  // holds. Asked only once something is about to go, so the common path — a
  // project inside its window — is the one candidate query and nothing else.
  const firstRetirement = !(await Effect.runPromise(
    storage.hasRetiredCrawls()
  ));

  const before = await Effect.runPromise(storage.databasePageStats());

  // Everything from here is irreversible. `retireCrawls` commits its own
  // transaction, so once it returns those reports are gone whatever happens
  // next — and what happens next (measuring, rebuilding, checkpointing) can
  // fail on a locked or full disk. Reporting that as "nothing was retired"
  // would be the one lie this code must not tell, so the outcome is built
  // BEFORE the reclaim and the reclaim's failure is attached to it.
  await Effect.runPromise(storage.retireCrawls(retiring));

  const outcome: RetentionOutcome = {
    retired: retiring.length,
    freedBytes: 0,
    vacuumed: false,
    firstRetirement,
    keep: options.keep,
  };

  try {
    // Sweep for page rows an EARLIER retirement kept that this audit has just
    // superseded. Retirement keeps whatever was the freshest record of a url at
    // the time, and nothing revisits those, so on a site whose url set moves
    // between audits one dead row per url would stay forever. Scoped to the
    // urls this crawl wrote, which are the only ones whose status can have
    // changed, so the cost is this audit's size rather than the project's
    // history.
    await Effect.runPromise(
      storage.collectSupersededPages(options.currentCrawlId)
    );

    const after = await Effect.runPromise(storage.databasePageStats());

    // What the deletes freed, measured as the growth of the freelist rather
    // than estimated from row counts. Deleting does not move the file, so this
    // is the honest number for the branch that does not rewrite it.
    let freedBytes = Math.max(
      0,
      (after.freelistPages - before.freelistPages) * after.pageSize
    );
    const freeBytes = after.freelistPages * after.pageSize;
    const fileBytes = after.pageCount * after.pageSize;

    // Retiring exactly one audit is the steady state: at `keep = 3` a fourth
    // audit arrives, the oldest goes, and what that frees is about a quarter of
    // the file — every single time. A share-based threshold alone would
    // therefore rewrite the whole database after every audit forever, which is
    // the cost this feature exists to avoid paying. Left alone, those freed
    // pages are simply reused by the next audit and the file plateaus.
    //
    // More than one audit going at once means something else happened:
    // retention was just switched on over a backlog, or the window was lowered.
    // That is when the space is worth handing back to the filesystem.
    const vacuumed =
      retiring.length > 1 &&
      (freeBytes > VACUUM_MIN_BYTES ||
        freeBytes > fileBytes * VACUUM_MIN_SHARE);

    if (vacuumed) {
      // vacuum() checkpoints for itself: without that the rewrite lands in the
      // -wal and the file on disk gets BIGGER (189 MB -> 239 MB, measured).
      await Effect.runPromise(storage.vacuum());
      // A rewrite returns the WHOLE freelist, not only what this pass added to
      // it, so re-measure rather than report the smaller number under a word
      // ("reclaimed") that promises the file actually shrank by it.
      const rebuilt = await Effect.runPromise(storage.databasePageStats());
      freedBytes = Math.max(
        0,
        after.pageCount * after.pageSize - rebuilt.pageCount * rebuilt.pageSize
      );
    } else {
      await Effect.runPromise(storage.checkpointWal());
    }
    return { ...outcome, freedBytes, vacuumed };
  } catch (error) {
    throw new RetentionReclaimError(outcome, error);
  }
}

/**
 * The reclaim failed AFTER the audits were already retired.
 *
 * Carries what was committed, so a caller's error path can still say what went
 * rather than reporting a clean no-op over a completed deletion.
 */
export class RetentionReclaimError extends Error {
  constructor(
    readonly outcome: RetentionOutcome,
    readonly cause: unknown
  ) {
    super(
      `Retired ${outcome.retired} audit(s), but reclaiming the space failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "RetentionReclaimError";
  }
}

/**
 * The one line an audit prints when it retired something.
 *
 * Says where the space went, because the two cases differ in what the user will
 * see next: a rewritten file is smaller on disk now, a freed-but-not-rewritten
 * one is the same size and will absorb the next audit instead of growing.
 */
export function formatRetentionNotice(outcome: RetentionOutcome): string {
  const audits = `${outcome.retired} older audit${outcome.retired === 1 ? "" : "s"}`;
  // A tiny project can free less than one SQLite page, and "freed 0 B" reads as
  // a bug rather than as the truth it is. The audits still went, so say that
  // much and nothing more.
  const space =
    outcome.freedBytes === 0
      ? ""
      : outcome.vacuumed
        ? ` and reclaimed ${formatBytes(outcome.freedBytes)}`
        : ` and freed ${formatBytes(outcome.freedBytes)} inside project.db for the next audit`;
  const hint = outcome.firstRetirement
    ? `; keep more with [storage] keep_audits (now ${outcome.keep})`
    : "";
  return `Retired ${audits}${space}${hint}`;
}
