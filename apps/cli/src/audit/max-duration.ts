// `squirrel audit --max-duration` (#1271): a wall-clock budget for the whole audit.
//
// The contract: at the budget the audit stops launching new work, lets in-flight
// pages finish, evaluates rules on what it has and writes the report with
// status `partial` and reason code `max_duration`. Work that is still going
// after the budget gets a margin of max(10% of the budget, 15 s) and is then cut.
// Unset means no budget, and nothing here runs.

/** Smallest margin past the budget, in ms. */
export const MAX_DURATION_MIN_MARGIN_MS = 15_000;
/** Margin as a share of the budget. */
export const MAX_DURATION_MARGIN_RATIO = 0.1;

/** The share of the budget discovery (robots.txt, sitemaps, the root probes) may use before the first page. */
export const MAX_DURATION_DISCOVERY_SHARE = 0.3;

/** Longest budget accepted, in seconds (7 days): beyond it a timer would overflow and the limit means nothing. */
export const MAX_DURATION_MAX_SECONDS = 7 * 24 * 60 * 60;

/** Where in the margin each post-crawl step must be done, as a share of it. */
const CHECKS_SHARE = 0.2;
const PAGE_RULES_SHARE = 0.4;
const HARD_SHARE = 0.6;

export interface DurationBudget {
  /** The budget, ms. */
  readonly budgetMs: number;
  /** The margin past the budget, ms. */
  readonly marginMs: number;
  /** Epoch ms the budget started counting. */
  readonly startedAt: number;
  /** Epoch ms discovery (robots.txt, sitemaps, root probes) must be done by. */
  readonly discoveryDoneAt: number;
  /** Epoch ms the crawl must stop launching work. */
  readonly crawlStopAt: number;
  /** Epoch ms the resource and external link checks must be done. */
  readonly checksDoneAt: number;
  /** Epoch ms after which no further page starts its rules. */
  readonly pageRulesStopAt: number;
  /** Epoch ms the whole rules phase is cut. */
  readonly hardStopAt: number;
}

/** The margin past `budgetMs` the audit may take to wind down: max(10% of the budget, 15 s). */
export function maxDurationMarginMs(budgetMs: number): number {
  return Math.max(
    Math.ceil(budgetMs * MAX_DURATION_MARGIN_RATIO),
    MAX_DURATION_MIN_MARGIN_MS
  );
}

/** The budget for a run, or undefined when none is set (zero, negative and non-numbers are "no budget"). */
export function createDurationBudget(
  seconds: number | undefined,
  startedAt: number = Date.now()
): DurationBudget | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0)
    return undefined;
  const budgetMs = Math.round(
    Math.min(seconds, MAX_DURATION_MAX_SECONDS) * 1000
  );
  const marginMs = maxDurationMarginMs(budgetMs);
  const end = startedAt + budgetMs;
  return {
    budgetMs,
    marginMs,
    startedAt,
    discoveryDoneAt:
      startedAt + Math.round(budgetMs * MAX_DURATION_DISCOVERY_SHARE),
    crawlStopAt: end,
    checksDoneAt: end + Math.round(marginMs * CHECKS_SHARE),
    pageRulesStopAt: end + Math.round(marginMs * PAGE_RULES_SHARE),
    hardStopAt: end + Math.round(marginMs * HARD_SHARE),
  };
}

/** Ms until `at`, never below 1 (a budget of zero means "no budget" to the engine). */
export function msUntil(at: number, now: number = Date.now()): number {
  return Math.max(1, at - now);
}

/** What the budget cut, for the report. */
export interface DurationCut {
  /** The budget stopped the crawl. It is only a cut when pages were left queued (`unfetched`). */
  crawlStopped: boolean;
  /** Pages discovered and queued but never fetched, when the budget stopped the crawl. */
  unfetched: number;
  /** Pages fetched whose rules never ran. */
  pagesNotEvaluated: number;
  /** The rules phase hit the hard stop; site rules did not finish. */
  rulesCut: boolean;
}

export function wasCut(cut: DurationCut): boolean {
  return cut.unfetched > 0 || cut.pagesNotEvaluated > 0 || cut.rulesCut;
}
