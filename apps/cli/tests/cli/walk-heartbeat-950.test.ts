// #950, #965: a non-TTY audit prints a stderr line at a steady interval through
// the pre-rules walk. The first version was driven by setInterval, which never
// fired because the walk is synchronous work that gives timers no turn, so the
// last test here runs the real walk with the real clock and no fake timer.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { PageRecord } from "@/crawler/storage/types";

import { runStreamingPreRules } from "@/audit/adapter";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

import {
  createWalkHeartbeat,
  formatWalkLine,
  walkHeartbeatIntervalMs,
} from "../../src/cli/walk-heartbeat";
import { getDefaultConfig } from "../../src/config";

function harness(enabled: boolean, intervalMs = 15_000) {
  const lines: string[] = [];
  let clock = 1_000;
  const heartbeat = createWalkHeartbeat({
    enabled,
    intervalMs,
    write: (line) => lines.push(line),
    now: () => clock,
  });
  return {
    heartbeat,
    lines,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("walk heartbeat (#950)", () => {
  test("prints the latest count once the interval has passed, at a batch boundary", () => {
    const { heartbeat, lines, advance } = harness(true);
    heartbeat.update(0, 104);
    advance(5_000);
    heartbeat.update(30, 104);
    expect(lines).toEqual([]);

    advance(10_000);
    heartbeat.update(60, 104);
    expect(lines).toEqual([formatWalkLine(60, 104)]);

    // Not again until another interval has passed.
    advance(14_999);
    heartbeat.update(80, 104);
    expect(lines).toHaveLength(1);
    advance(1);
    heartbeat.update(90, 104);
    expect(lines).toEqual([formatWalkLine(60, 104), formatWalkLine(90, 104)]);
  });

  test("the finished walk prints nothing and stays finished", () => {
    const { heartbeat, lines, advance } = harness(true);
    heartbeat.update(10, 104);
    advance(20_000);
    heartbeat.update(104, 104);
    advance(20_000);
    heartbeat.update(50, 104);
    expect(lines).toEqual([]);
  });

  test("an empty walk prints nothing", () => {
    const { heartbeat, lines, advance } = harness(true);
    heartbeat.update(0, 0);
    advance(60_000);
    heartbeat.update(0, 0);
    expect(lines).toEqual([]);
  });

  test("disabled (a TTY) never writes", () => {
    const { heartbeat, lines, advance } = harness(false);
    heartbeat.update(0, 104);
    advance(60_000);
    heartbeat.update(10, 104);
    expect(lines).toEqual([]);
  });

  test("stop silences it, before or after the first update", () => {
    const { heartbeat, lines, advance } = harness(true);
    heartbeat.stop();
    heartbeat.update(0, 10);
    advance(60_000);
    heartbeat.update(5, 10);
    expect(lines).toEqual([]);
  });

  test("the default writer goes to stderr, never stdout", () => {
    const err: string[] = [];
    const out: string[] = [];
    const realErr = process.stderr.write.bind(process.stderr);
    const realOut = process.stdout.write.bind(process.stdout);
    let clock = 0;
    const heartbeat = createWalkHeartbeat({
      enabled: true,
      intervalMs: 10,
      now: () => clock,
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
      heartbeat.update(0, 20);
      clock = 20;
      heartbeat.update(5, 20);
    } finally {
      process.stderr.write = realErr;
      process.stdout.write = realOut;
    }
    expect(err).toEqual(["Walking pages: 5/20\n"]);
    expect(out).toEqual([]);
  });

  test("SQUIRREL_WALK_HEARTBEAT_MS sets the interval when it is a positive number", () => {
    expect(walkHeartbeatIntervalMs({ SQUIRREL_WALK_HEARTBEAT_MS: "200" })).toBe(
      200
    );
    expect(walkHeartbeatIntervalMs({})).toBe(15_000);
    for (const bad of ["0", "-5", "abc", ""]) {
      expect(walkHeartbeatIntervalMs({ SQUIRREL_WALK_HEARTBEAT_MS: bad })).toBe(
        15_000
      );
    }
  });
});

describe("the real pre-rules walk drives the heartbeat (#965)", () => {
  test("a synchronous walk gives a timer no turn, and the heartbeat still prints", async () => {
    const storage = new SQLiteStorage(":memory:");
    const body = "<p>filler text for the walk to parse</p>".repeat(2_500);
    const total = 40;
    const crawlId = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const id = yield* storage.createCrawl({
          baseUrl: "https://e.test",
          startedAt: Date.now(),
          status: "crawled",
          config: {} as never,
          stats: {} as never,
        } as never);
        for (let i = 0; i < total; i++) {
          const url = `https://e.test/p${String(i).padStart(3, "0")}`;
          yield* storage.upsertPage(id, {
            url,
            normalizedUrl: url,
            finalUrl: url,
            depth: 0,
            status: 200,
            contentType: "text/html",
            sizeBytes: body.length,
            loadTimeMs: 1,
            fetchedAt: 1,
            etag: null,
            lastModified: null,
            contentHash: `h${i}`,
            html: `<!doctype html><html lang="en"><head><title>P${i}</title></head><body>${body}</body></html>`,
            parsedData: null,
            headers: {},
            securityHeaders: {},
          } as unknown as PageRecord);
        }
        return id;
      })
    );

    // A timer armed before the walk, to prove the premise of #965: the walk
    // is synchronous, so it never fires during it.
    let timerFiredDuringWalk = false;
    let walking = true;
    const timer = setInterval(() => {
      if (walking) timerFiredDuringWalk = true;
    }, 1);

    const lines: string[] = [];
    const heartbeat = createWalkHeartbeat({
      enabled: true,
      // The real clock, and an interval far under the walk's length.
      intervalMs: 5,
      write: (line) => lines.push(line),
    });
    let walked = 0;
    heartbeat.update(0, total);
    try {
      await Effect.runPromise(
        runStreamingPreRules(storage, crawlId, getDefaultConfig(), {
          batchSize: 2,
          onBatchContext: (batch) => {
            walked += batch.length;
            heartbeat.update(walked, total);
          },
        }) as Effect.Effect<unknown, never, never>
      );
    } finally {
      walking = false;
      clearInterval(timer);
      await Effect.runPromise(storage.close());
    }

    expect(walked).toBe(total);
    expect(timerFiredDuringWalk).toBe(false);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) expect(line).toMatch(/^Walking pages: \d+\/40$/);
  }, 60_000);
});
