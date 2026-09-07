// Measuring "does this still hold the page it came from" without flaking (#1860).
//
// The detach tests assert a memory property, and the values are identical
// whether or not the retention is there, so nothing else can see it. A first
// version of this compared an attached arm against a detached arm on ~900 KB
// pages and went red on a shared CI runner at 541,604 against 531,770 bytes —
// the two arms landed on top of each other, which is what runner noise looks
// like, not a regression.
//
// Four things make the measurement survive that.
//
// EXTERNAL, NOT heapUsed. A JS string's characters live in a backing store off
// the JS heap, and a slice pins the BUFFER rather than a heap object. `heapUsed`
// therefore moves by almost nothing for the case being caught: measured on a
// 150-page fixture, the attached arm's `external` was 287 MB against a control's
// 100 MB while the two heaps were 143 and 131 MB. Reading heapUsed makes the
// signal a rounding error on the noise.
//
// A RETAIN-NOTHING CONTROL, SUBTRACTED. Every arm parses the same pages and runs
// the same extraction; only what it keeps differs. The control's cost — the
// parser's structures, the transient DOMs, the arena's growth — is present in
// all three and is worth hundreds of MB on a fixture this size. Subtracting it
// is what turns three large numbers into one small difference and one large one.
//
// A FIXTURE BIG ENOUGH TO BEAT THE RUNNER. The retention is proportional to the
// source buffer, so the fixture is sized to put the attached arm hundreds of MB
// above the control rather than tens. A shared runner moves by ±50 MB for
// reasons that have nothing to do with the code.
//
// AND A LOUD FAILURE WHEN THE MEASUREMENT DID NOT WORK. If the attached arm is
// not clear of the control by the margin, this reports that and fails, rather
// than returning early and passing. An inconclusive run that reports success is
// worse than a red one: the earlier version of these tests did exactly that, on
// every run, for a week.

import { expect } from "bun:test";

export const MB = 1024 * 1024;

/** One arm's retained bytes, and enough context to explain a bad run. */
export interface RetentionMeasurement {
  /** `external` growth across the arm, after a synchronous collect at each end. */
  readonly externalBytes: number;
  /** Kept alive until the sample is taken; exported so a caller can assert on it. */
  readonly kept: number;
}

/**
 * Run one arm: `build` is called `iterations` times and whatever it returns is
 * retained until after the sample.
 *
 * The collect at both ends is synchronous (`Bun.gc(true)`): JSC grows the heap
 * in preference to collecting, so an opportunistic collect leaves the arm's
 * garbage in the number and makes every arm look like a leak.
 */
export function measureArm(iterations: number, build: (i: number) => unknown): RetentionMeasurement {
  Bun.gc(true);
  const before = process.memoryUsage().external;
  const kept: unknown[] = [];
  for (let i = 0; i < iterations; i++) kept.push(build(i));
  Bun.gc(true);
  const after = process.memoryUsage().external;
  // Touched AFTER the sample so nothing here can be collected early.
  expect(kept.length).toBe(iterations);
  return { externalBytes: after - before, kept: kept.length };
}

export interface RetentionComparison {
  /** Attached minus control — the retention the test exists to catch. */
  readonly attachedBytes: number;
  /** Detached minus control — what is left after the fix. */
  readonly detachedBytes: number;
  readonly controlBytes: number;
}

/**
 * The three arms, warmed, in a fixed order, with the control subtracted.
 *
 * Order matters and is why the warm-up is not optional: whichever arm runs
 * first pays for the parser's one-time structures, which on a page-sized
 * fixture is enough to make it look like the leaker. Both real arms are run
 * once and discarded before anything is recorded.
 */
export function compareRetention(opts: {
  iterations: number;
  control: (i: number) => unknown;
  attached: (i: number) => unknown;
  detached: (i: number) => unknown;
}): RetentionComparison {
  measureArm(Math.max(1, Math.floor(opts.iterations / 4)), opts.attached);
  measureArm(Math.max(1, Math.floor(opts.iterations / 4)), opts.detached);

  const control = measureArm(opts.iterations, opts.control);
  const attached = measureArm(opts.iterations, opts.attached);
  const detached = measureArm(opts.iterations, opts.detached);

  return {
    controlBytes: control.externalBytes,
    attachedBytes: attached.externalBytes - control.externalBytes,
    detachedBytes: detached.externalBytes - control.externalBytes,
  };
}

/**
 * Assert the detached arm holds a small fraction of what the attached arm does.
 *
 * `marginBytes` is how far clear of the control the attached arm must be for
 * the run to count. Below that the comparison is measuring the runner, so this
 * FAILS and says so — the alternative is a green run that asserted nothing,
 * which is how the retention this catches survived three rounds of looking.
 */
export function expectDetached(
  result: RetentionComparison,
  opts: { marginBytes: number; ratio: number; label: string },
): void {
  const mb = (bytes: number) => `${(bytes / MB).toFixed(0)} MB`;
  // Signed, because a control-subtracted arm can legitimately come out slightly
  // negative and "+-1 MB" reads like a formatting bug rather than a number.
  const signed = (bytes: number) => `${bytes < 0 ? "-" : "+"}${mb(Math.abs(bytes))}`;
  const summary =
    `${opts.label}: control ${mb(result.controlBytes)}, ` +
    `attached ${signed(result.attachedBytes)}, detached ${signed(result.detachedBytes)}`;

  // Printed on every run, pass or fail. When this does flake, the three numbers
  // are the whole diagnosis, and a green CI log that recorded nothing leaves
  // the next person re-deriving them.
  console.log(`[retention] ${summary} (margin ${mb(opts.marginBytes)}, ratio ${opts.ratio}x)`);

  if (result.attachedBytes < opts.marginBytes) {
    throw new Error(
      `${summary} — the attached arm is not clear of the control by the ${mb(opts.marginBytes)} ` +
        `margin, so this run did not reproduce the retention and cannot judge the fix. ` +
        `That is a measurement failure, not a regression: check whether the fixture still ` +
        `produces slices of a flat source string, and whether the runner has memory to spare.`,
    );
  }

  expect(result.detachedBytes).toBeLessThan(result.attachedBytes / opts.ratio);
}
