// Non-TTY progress for the pre-rules walk (#950, #965).
//
// The walk over the crawled pages can run for minutes and, with no terminal,
// prints nothing: the spinner is TTY-only. A supervisor with a no-output
// watchdog cannot tell a slow phase from a hang. This writes one line to stderr
// at a steady interval, so stdout (`-f json`, pipes) stays clean. It is a
// no-op on a TTY, where the spinner already shows the phase.
//
// Driven by the walk, not by a timer (#965): the walk parses and absorbs each
// batch synchronously, so the event loop gets no turn between batches and a
// `setInterval` never fires before the walk ends. `update` is called at each
// batch boundary the walk already has, and prints when the interval has passed
// since the last line. A walk's batches are bounded by a byte budget, so a
// boundary comes every few seconds on any site; one longer than the interval
// shows no line until its batch ends.

import { WALK_HEARTBEAT_INTERVAL_MS } from "@/constants";

export interface WalkHeartbeat {
  /**
   * The pages walked so far, out of the total. Prints one line when the
   * interval has passed since the walk started or the last line.
   */
  update(current: number, total: number): void;
  /** No more lines. Safe to call repeatedly, and before `update`. */
  stop(): void;
}

export interface WalkHeartbeatOptions {
  /** Off on a TTY: the spinner is the display there. */
  enabled: boolean;
  intervalMs?: number;
  /** Defaults to stderr. */
  write?: (line: string) => void;
  /** Injected so a test can move time without sleeping. */
  now?: () => number;
}

/**
 * The interval: `SQUIRREL_WALK_HEARTBEAT_MS` when it is a positive number (a
 * hook for tests and for supervisors with a short watchdog), else the default.
 */
export function walkHeartbeatIntervalMs(
  env: Record<string, string | undefined> = process.env
): number {
  const override = Number(env.SQUIRREL_WALK_HEARTBEAT_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : WALK_HEARTBEAT_INTERVAL_MS;
}

export function formatWalkLine(current: number, total: number): string {
  return `Walking pages: ${current}/${total}`;
}

export function createWalkHeartbeat(
  options: WalkHeartbeatOptions
): WalkHeartbeat {
  const write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? walkHeartbeatIntervalMs();

  let done = false;
  // Set by the first update, which the audit sends before the walk starts.
  let lastWriteAt: number | undefined;

  return {
    update(current, total) {
      if (!options.enabled || done) return;
      // The walk finished (or there is nothing to walk): no line for it, the
      // next phase speaks for itself.
      if (current >= total) {
        done = true;
        return;
      }
      const at = now();
      if (lastWriteAt === undefined) {
        lastWriteAt = at;
        return;
      }
      if (at - lastWriteAt < intervalMs) return;
      lastWriteAt = at;
      write(formatWalkLine(current, total));
    },
    stop() {
      done = true;
    },
  };
}
