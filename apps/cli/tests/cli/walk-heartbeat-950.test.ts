// #950: a non-TTY audit prints a stderr line at a steady interval through the
// pre-rules walk. The interval is driven by an injected timer, so no test sleeps.

import { describe, expect, test } from "bun:test";

import {
  createWalkHeartbeat,
  formatWalkLine,
} from "../../src/cli/walk-heartbeat";

function harness(enabled: boolean, intervalMs = 15_000) {
  const lines: string[] = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> =
    [];
  const heartbeat = createWalkHeartbeat({
    enabled,
    intervalMs,
    write: (line) => lines.push(line),
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  /** One interval elapsing, unless the timer was stopped. */
  const tick = () => {
    for (const timer of timers) if (!timer.cleared) timer.callback();
  };
  return { heartbeat, lines, timers, tick };
}

describe("walk heartbeat (#950)", () => {
  test("prints the latest count each interval, however many batches landed", () => {
    const { heartbeat, lines, timers, tick } = harness(true);
    heartbeat.update(0, 104);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(15_000);
    // Nothing is printed until an interval passes.
    expect(lines).toEqual([]);

    heartbeat.update(30, 104);
    heartbeat.update(60, 104);
    tick();
    expect(lines).toEqual([formatWalkLine(60, 104)]);

    // A slow batch: the next beat still fires, with the same count.
    tick();
    expect(lines).toEqual([formatWalkLine(60, 104), formatWalkLine(60, 104)]);
    expect(timers).toHaveLength(1);
  });

  test("one timer for the whole walk", () => {
    const { heartbeat, timers } = harness(true);
    for (let i = 0; i < 5; i++) heartbeat.update(i * 10, 104);
    expect(timers).toHaveLength(1);
  });

  test("the finished walk stops it and prints nothing more", () => {
    const { heartbeat, lines, timers, tick } = harness(true);
    heartbeat.update(10, 104);
    heartbeat.update(104, 104);
    expect(timers[0]!.cleared).toBe(true);
    tick();
    expect(lines).toEqual([]);
    // A late update never restarts it.
    heartbeat.update(50, 104);
    expect(timers).toHaveLength(1);
  });

  test("an empty walk never starts a timer", () => {
    const { heartbeat, timers } = harness(true);
    heartbeat.update(0, 0);
    expect(timers).toHaveLength(0);
  });

  test("disabled (a TTY) never starts a timer or writes", () => {
    const { heartbeat, lines, timers, tick } = harness(false);
    heartbeat.update(10, 104);
    tick();
    expect(timers).toHaveLength(0);
    expect(lines).toEqual([]);
  });

  test("stop is safe before update and when repeated", () => {
    const { heartbeat, timers } = harness(true);
    heartbeat.stop();
    heartbeat.stop();
    heartbeat.update(1, 10);
    expect(timers).toHaveLength(0);
  });

  test("the default writer goes to stderr, never stdout", () => {
    const err: string[] = [];
    const out: string[] = [];
    const realErr = process.stderr.write.bind(process.stderr);
    const realOut = process.stdout.write.bind(process.stdout);
    let fire: (() => void) | undefined;
    const heartbeat = createWalkHeartbeat({
      enabled: true,
      setTimer: (callback) => {
        fire = callback;
        return {};
      },
      clearTimer: () => {},
    });
    process.stderr.write = ((chunk: string) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      heartbeat.update(5, 20);
      fire?.();
    } finally {
      process.stderr.write = realErr;
      process.stdout.write = realOut;
    }
    expect(err).toEqual(["Walking pages: 5/20\n"]);
    expect(out).toEqual([]);
  });
});
