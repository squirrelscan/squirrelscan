// Shared probing budget. One object per audit run, handed to every rule as
// `ctx.probe`, so all probing rules together stay inside one wall-clock cap
// (`--probe-budget`, `[security] budget`) and one intensity level (`--probe`).
//
// A probing rule asks before each request it would send:
//
//   if (!ctx.probe?.allows("quiet")) return [];   // or "loud"
//   const signal = ctx.probe.signal();            // aborts at the deadline
//   ... fetch(url, { signal }) ...
//   ctx.probe.record();
//
// `quiet` probes are a handful of requests that look like normal traffic and
// need `active`; `loud` probes (many requests, many 404s, robots-disallowed
// paths) need `aggressive`. Passive allows nothing, and an absent `ctx.probe`
// must be read the same way: no probe sends a request.
//
// The clock starts at the first allowed probe, not at construction: the budget
// is created before the crawl, and the crawl's own time is not probing time.
// Like the fetch budget it is a gate, not a canceller: once the deadline
// passes no new probe starts, and `signal()` bounds the ones in flight.
//
// Probing rules belong in the site pass. The per-page rule-result cache
// (audit-engine rule-cache.ts) replays a page rule's verdict when the page is
// unchanged, and live probe responses are not part of its key.
//
// Framework-free and clock-injectable for deterministic tests.

/** Mirrors `PROBE_LEVELS` in @squirrelscan/config, which this package does not depend on. */
export type ProbeLevel = "passive" | "active" | "aggressive";

/** `quiet` needs active; `loud` needs aggressive. */
export type ProbeKind = "quiet" | "loud";

export interface ProbeBudgetOptions {
  level: ProbeLevel;
  /** Wall-clock cap (ms) across every probe sharing this budget. `<= 0` or non-finite → nothing is allowed. */
  budgetMs: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface ProbeBudgetSummary {
  level: ProbeLevel;
  budgetMs: number;
  /** Probes admitted by {@link ProbeBudget.allows}. */
  allowed: number;
  /** Requests reported through {@link ProbeBudget.record}. */
  requests: number;
  /** Probes refused because the deadline had passed. */
  skippedForBudget: number;
  /** Wall time (ms) since the first allowed probe; 0 if none ran. */
  elapsedMs: number;
  /** True once a probe was refused for budget. */
  exhausted: boolean;
}

export interface ProbeBudget {
  readonly level: ProbeLevel;
  readonly budgetMs: number;
  /**
   * Call BEFORE sending a probe. True when the level permits this kind of
   * probe and the shared deadline has not passed. Starts the clock on the
   * first allowed probe.
   */
  allows(kind: ProbeKind): boolean;
  /** Milliseconds left before the deadline (the full budget before the first probe). */
  remainingMs(): number;
  /** An AbortSignal that fires at the shared deadline, for in-flight requests. */
  signal(): AbortSignal;
  /** Count requests a probe actually sent (default 1). */
  record(requests?: number): void;
  summary(): ProbeBudgetSummary;
}

const KIND_MIN_LEVEL: Record<ProbeKind, ProbeLevel> = { quiet: "active", loud: "aggressive" };
const LEVEL_RANK: Record<ProbeLevel, number> = { passive: 0, active: 1, aggressive: 2 };

export function createProbeBudget(options: ProbeBudgetOptions): ProbeBudget {
  const now = options.now ?? Date.now;
  const { level } = options;
  const budgetMs =
    Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : 0;
  let startedAt: number | undefined;
  let allowed = 0;
  let requests = 0;
  let skippedForBudget = 0;

  const elapsed = () => (startedAt === undefined ? 0 : now() - startedAt);
  const remainingMs = () => Math.max(0, budgetMs - elapsed());

  return {
    level,
    budgetMs,
    allows(kind) {
      if (LEVEL_RANK[level] < LEVEL_RANK[KIND_MIN_LEVEL[kind]]) return false;
      if (budgetMs === 0) return false;
      if (startedAt === undefined) startedAt = now();
      if (remainingMs() <= 0) {
        skippedForBudget++;
        return false;
      }
      allowed++;
      return true;
    },
    remainingMs,
    signal() {
      const left = remainingMs();
      if (left <= 0) {
        const controller = new AbortController();
        controller.abort(new Error("probe budget exhausted"));
        return controller.signal;
      }
      return AbortSignal.timeout(left);
    },
    record(count = 1) {
      requests += count;
    },
    summary() {
      return {
        level,
        budgetMs,
        allowed,
        requests,
        skippedForBudget,
        elapsedMs: elapsed(),
        exhausted: skippedForBudget > 0,
      };
    },
  };
}
