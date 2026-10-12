// Failure containment for the collectors folded into the audit's pre-rules
// walk (pub#401).
//
// `absorb` runs once per page batch inside `runStreamingPreRules`, over pages
// the audited site chose. Nothing catches a throw there, so one bad batch would
// fail the whole audit after the crawl has already been paid for in wall-clock
// time. No input is known to throw today; this is defence in depth against a
// future parser change.
//
// What a failure MEANS matters as much as catching it. A batch that threw left
// the collector holding part of that batch, and a result built from it looks
// complete: an entity map's `summary` would state site-wide totals for a graph
// that skipped pages. So the first failure poisons the collector: later batches
// are not folded in and `build` returns undefined, which every consumer reads
// as "not collected" (the `schema/entity-*` rules emit their "no map was built"
// skip, the cloud prefetch does not run).

export interface GuardedCollector<Batch, BuildArgs extends unknown[], Result> {
  /** Fold one batch in. Never throws. */
  absorb(batch: Batch): void;
  /** The result, or undefined once any absorb or the build itself failed. */
  build(...args: BuildArgs): Result | undefined;
  /** True once any call threw: the collector's result is unusable from then on. */
  readonly failed: boolean;
}

/**
 * Wrap a collector so neither `absorb` nor `build` can fail the audit.
 * `onFailure` runs at most once per collector, on the first failure of either
 * call: the page set is site-controlled, and one line per batch across a large
 * crawl would carry nothing the first one did not. Collectors are synchronous;
 * a promise one returned would reject past this guard.
 */
export function guardCollector<Batch, BuildArgs extends unknown[], Result>(
  collector: {
    absorb(batch: Batch): void;
    build(...args: BuildArgs): Result;
  },
  onFailure: (error: unknown, phase: "absorb" | "build") => void
): GuardedCollector<Batch, BuildArgs, Result> {
  let failed = false;

  const fail = (error: unknown, phase: "absorb" | "build"): void => {
    if (failed) return;
    failed = true;
    // The callback is the caller's logging on a never-fail path: its own
    // throw must not become the exception this guard exists to stop.
    try {
      onFailure(error, phase);
    } catch {
      // Nothing left to report it to.
    }
  };

  return {
    absorb(batch: Batch): void {
      // Poisoned: whatever this batch adds is discarded by build anyway.
      if (failed) return;
      try {
        collector.absorb(batch);
      } catch (error) {
        fail(error, "absorb");
      }
    },
    build(...args: BuildArgs): Result | undefined {
      if (failed) return undefined;
      try {
        return collector.build(...args);
      } catch (error) {
        fail(error, "build");
        return undefined;
      }
    },
    get failed(): boolean {
      return failed;
    },
  };
}
