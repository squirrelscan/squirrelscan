// Non-TTY progress for the pre-rules walk (#950).
//
// The walk over the crawled pages can run for minutes and, with no terminal,
// prints nothing: the spinner is TTY-only. A supervisor with a no-output
// watchdog cannot tell a slow phase from a hang. This writes one line to stderr
// at a steady interval, so stdout (`-f json`, pipes) stays clean. It is a
// no-op on a TTY, where the spinner already shows the phase.

import { WALK_HEARTBEAT_INTERVAL_MS } from "@/constants";

export interface WalkHeartbeat {
  /** The pages walked so far, out of the total. Starts the timer on first call. */
  update(current: number, total: number): void;
  /** Stop the timer. Safe to call repeatedly, and before `update`. */
  stop(): void;
}

export interface WalkHeartbeatOptions {
  /** Off on a TTY: the spinner is the display there. */
  enabled: boolean;
  intervalMs?: number;
  /** Defaults to stderr. */
  write?: (line: string) => void;
  /** Injected so a test can drive the interval without sleeping. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function formatWalkLine(current: number, total: number): string {
  return `Walking pages: ${current}/${total}`;
}

export function createWalkHeartbeat(
  options: WalkHeartbeatOptions
): WalkHeartbeat {
  const write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
  const setTimer =
    options.setTimer ?? ((callback, ms) => setInterval(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const intervalMs = options.intervalMs ?? WALK_HEARTBEAT_INTERVAL_MS;

  let handle: unknown;
  let done = false;
  let current = 0;
  let total = 0;

  const stop = (): void => {
    done = true;
    if (handle !== undefined) clearTimer(handle);
    handle = undefined;
  };

  return {
    update(nextCurrent, nextTotal) {
      if (!options.enabled || done) return;
      current = nextCurrent;
      total = nextTotal;
      // The walk finished (or there is nothing to walk): no line for it, the
      // next phase speaks for itself.
      if (current >= total) return stop();
      if (handle !== undefined) return;
      handle = setTimer(
        () => write(formatWalkLine(current, total)),
        intervalMs
      );
      // A timer must never keep the process alive past the audit.
      (handle as { unref?: () => void } | undefined)?.unref?.();
    },
    stop,
  };
}
