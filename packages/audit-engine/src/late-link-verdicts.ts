// Late-binding external-link verdicts (repo#2144).
//
// In the default (blocking) mode the pre-rules pass checks every external link,
// persists the verdict rows, and only then lets the rules start, because the
// link rules read those rows. A link that takes a minute to answer holds every
// rule for that minute.
//
// In the late-binding mode the check starts in the background as soon as the
// pre-rules walk has collected the links, and nothing writes its verdicts yet.
// The rules that do not read link verdicts run at once. The rules that do
// (`LINK_VERDICT_RULE_IDS` in @squirrelscan/rules) run LAST, through
// {@link LateLinkVerdicts.settle}: it waits for the verdicts up to ONE deadline,
// fixed when the check starts ({@link linkVerdictDeadlineAt}), persists the
// verdicts that arrived by then through the same code the blocking mode uses,
// and seals the handle.
//
// - A link with no verdict by the deadline is unverifiable for this run: it gets
//   no row and is counted as `outOfTime` in the coverage stat, exactly as a link
//   the blocking check's own budget ran out on (repo#2613). The link rules
//   report it as not checked, never as broken, and a caller that refunds the
//   links it was charged for without a stored answer refunds it.
// - A verdict that arrives after the seal is discarded for this run. The check
//   itself is told the same deadline, so it sends nothing after it; an answer
//   already in flight may still reach the shared link cache for the next run.
// - The report is built once, after the seal. There is no path to amend it.
// - The local fallback is unchanged: a bulk (cloud) checker that fails or goes
//   quiet mid-check hands its remaining links to the local checker, inside the
//   same deadline.

import { Effect } from "effect";

import type { CrawlStorage } from "@squirrelscan/core-contracts/storage";

import {
  externalLinkBudgetDeadline,
  externalLinkCheckerOptions,
  persistExternalLinkResults,
  planExternalLinkCheck,
  recordExternalLinkCoverage,
  type ExternalLinkCheckLimits,
  type ExternalLinkCheckPlan,
  type ExternalLinkCheckProgress,
  type ExternalLinkOccurrences,
} from "./adapter";
import { checkExternalLinks, type ExternalCheckResult, type LinkCache } from "./external-checker";

/**
 * Time kept back, before the run's own deadline, for the link rules and the
 * report after the verdict deadline. The link rules are the site rules in
 * `LINK_VERDICT_RULE_IDS`, over at most `max_links` verdicts, and the report
 * build after them is the same as in the blocking mode, so this is a margin, not
 * a measured cost.
 */
export const LINK_RULES_RESERVE_MS = 30_000;

/**
 * THE verdict deadline of a late-binding run, in epoch ms (repo#2144). The
 * earliest of:
 *
 * 1. `checkStartedAt + linkBudgetMs`: the external link check's own budget
 *    (`ExternalLinkCheckLimits.budgetMs`, the cloud's per-run link-check
 *    deadline), the same bound the blocking mode stops its check at;
 * 2. `runDeadlineAt - LINK_RULES_RESERVE_MS`: the latest the link rules can
 *    start and still finish, with the report, before the run's own deadline.
 *
 * A bound that is unset, not finite, or (for the budget) zero or less is no
 * bound. With neither, there is no deadline: the link rules wait for every
 * verdict, which is the blocking mode's answer, only without holding the other
 * rules. A deadline already past (a run with less than the reserve left) means
 * every link without a cached or early verdict is unverifiable.
 */
export function linkVerdictDeadlineAt(input: {
  checkStartedAt: number;
  linkBudgetMs?: number;
  runDeadlineAt?: number;
}): number | undefined {
  const bounds: number[] = [];
  const budgetDeadline = externalLinkBudgetDeadline({ budgetMs: input.linkBudgetMs }, input.checkStartedAt);
  if (budgetDeadline !== undefined) bounds.push(budgetDeadline);
  if (input.runDeadlineAt !== undefined && Number.isFinite(input.runDeadlineAt)) {
    bounds.push(input.runDeadlineAt - LINK_RULES_RESERVE_MS);
  }
  return bounds.length > 0 ? Math.min(...bounds) : undefined;
}

/** What {@link LateLinkVerdicts.settle} bound for this run. */
export interface LinkVerdictSettlement {
  /** The verdicts this run uses: every one the check returned when it finished in time, else the ones that arrived by the deadline. */
  results: ExternalCheckResult[];
  /** Links selected for checking with no verdict by the deadline: unverifiable this run, counted as `outOfTime`. */
  unverifiable: number;
  /** The deadline left at least one selected link without a verdict. */
  expired: boolean;
  /** The deadline this run had, if any. */
  deadlineAt: number | undefined;
  /** When the verdicts were bound (epoch ms). */
  settledAt: number;
}

/** A started external link check whose verdicts the link rules bind late. */
export interface LateLinkVerdicts {
  /** When the check started (epoch ms). */
  readonly startedAt: number;
  /** The one verdict deadline ({@link linkVerdictDeadlineAt}); undefined is none. */
  readonly deadlineAt: number | undefined;
  /**
   * Wait for the verdicts up to the deadline, persist the ones in hand, and
   * seal. Idempotent: every call returns the first call's settlement. Never
   * rejects; a check that fails outright binds the verdicts it had.
   */
  settle(): Promise<LinkVerdictSettlement>;
  /** True once {@link settle} has bound the verdicts; nothing is written after. */
  readonly sealed: boolean;
  /** Settles when the background check itself ends, sealed or not (tests; nothing to wait on in a run). */
  readonly checkDone: Promise<void>;
}

export interface StartLateLinkVerdictsOptions {
  occurrences: ExternalLinkOccurrences;
  /** `config.external_links`, with `max_links` already resolved by the caller. */
  config: Parameters<typeof planExternalLinkCheck>[3];
  linkCache?: LinkCache | null;
  bulkChecker?: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>;
  priorityHrefs?: readonly string[];
  egressPinnedByTransport?: boolean;
  limits?: ExternalLinkCheckLimits;
  /** The run's own deadline (epoch ms); see {@link linkVerdictDeadlineAt}. */
  runDeadlineAt?: number;
  onProgress?: (progress: ExternalLinkCheckProgress) => void;
  /** The resolver behind the links' egress checks; the system's when unset (a test seam). */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** The clock; `Date.now` when unset. */
  now?: () => number;
}

/** A handle for a run with nothing to check: settles at once, with no verdicts. */
function nothingToCheck(startedAt: number): LateLinkVerdicts {
  const settlement: LinkVerdictSettlement = {
    results: [],
    unverifiable: 0,
    expired: false,
    deadlineAt: undefined,
    settledAt: startedAt,
  };
  return {
    startedAt,
    deadlineAt: undefined,
    settle: () => Promise.resolve(settlement),
    sealed: true,
    checkDone: Promise.resolve(),
  };
}

/**
 * Plan the external link check and start it in the background; return at once.
 * See the module header for the guarantees.
 */
export function startLateLinkVerdicts(
  storage: CrawlStorage,
  crawlId: string,
  options: StartLateLinkVerdictsOptions,
): Effect.Effect<LateLinkVerdicts, never, never> {
  return Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const startedAt = now();
    const plan = yield* planExternalLinkCheck(storage, crawlId, options.occurrences, options.config, {
      linkCache: options.linkCache,
      priorityHrefs: options.priorityHrefs,
      egressPinnedByTransport: options.egressPinnedByTransport,
      resolveHost: options.resolveHost,
    });
    if (!plan) return nothingToCheck(startedAt);

    const deadlineAt = linkVerdictDeadlineAt({
      checkStartedAt: startedAt,
      linkBudgetMs: options.limits?.budgetMs,
      runDeadlineAt: options.runDeadlineAt,
    });
    return startPlannedCheck(storage, crawlId, options, plan, startedAt, deadlineAt, now);
  });
}

function startPlannedCheck(
  storage: CrawlStorage,
  crawlId: string,
  options: StartLateLinkVerdictsOptions,
  plan: ExternalLinkCheckPlan,
  startedAt: number,
  deadlineAt: number | undefined,
  now: () => number,
): LateLinkVerdicts {
  // Verdicts in arrival order, kept only until the seal.
  const arrived = new Map<string, ExternalCheckResult>();
  let sealed = false;
  let finished: ExternalCheckResult[] | null = null;

  const check = Effect.runPromise(
    checkExternalLinks(
      plan.hrefs,
      plan.cache,
      externalLinkCheckerOptions(plan, {
        bulkChecker: options.bulkChecker,
        // The check stops at the same deadline, so it sends nothing whose answer
        // this run would discard (a paid call among them).
        deadlineAt,
        maxWaitMs: options.limits?.maxWaitMs,
        onProgress: (progress) => {
          if (!sealed) options.onProgress?.(progress);
        },
        onVerdict: (result) => {
          if (!sealed) arrived.set(result.href, result);
        },
      }),
    ),
  ).then(
    (results) => {
      if (!sealed) finished = results;
    },
    // Never rejects in practice (its error channel is `never`); a defect binds what arrived.
    () => undefined,
  );

  let settlement: Promise<LinkVerdictSettlement> | null = null;

  const bind = async (): Promise<LinkVerdictSettlement> => {
    const remaining = deadlineAt === undefined ? Number.POSITIVE_INFINITY : deadlineAt - now();
    if (remaining > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        check,
        ...(Number.isFinite(remaining)
          ? [new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining)))]
          : []),
      ]);
      if (timer) clearTimeout(timer);
    }
    sealed = true;
    // The whole answer when the check ended in time: byte-for-byte what the
    // blocking mode persists. Otherwise the verdicts that arrived by the deadline.
    const results = finished ?? [...arrived.values()];
    const expired = finished === null || results.length < plan.hrefs.length;
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordExternalLinkCoverage(storage, crawlId, plan.externalLinkCheck);
        yield* persistExternalLinkResults(storage, crawlId, options.occurrences, plan, results);
      }),
    );
    const fromCache = results.filter((r) => r.fromCache).length;
    options.onProgress?.({ checked: results.length, total: plan.hrefs.length, fromCache });
    return {
      results,
      unverifiable: plan.hrefs.length - results.length,
      expired,
      deadlineAt,
      settledAt: now(),
    };
  };

  return {
    startedAt,
    deadlineAt,
    settle: () => (settlement ??= bind()),
    get sealed() {
      return sealed;
    },
    checkDone: check,
  };
}
