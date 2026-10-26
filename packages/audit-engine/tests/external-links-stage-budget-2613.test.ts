// repo#2613: a cloud audit failed with "stopped making progress during external
// links for 10 minutes" while its link check was healthy. The check reported
// nothing until it ended, so the container's watchdog could not tell dozens of
// slow dead-links calls from a hang, and nothing but that watchdog bounded the
// stage. The check now reports as each call settles, stops at its budget, and
// waits on no single call, bulk or local, longer than its allowance. The links
// it did not reach are left unanswered, counted as `outOfTime`, and reported as
// not checked.

import { afterEach, describe, expect, jest, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";

import { checkCollectedExternalLinks, type ExternalLinkOccurrences } from "../src/adapter";
import {
  checkExternalLinks,
  runBulkChecker,
  type ExternalCheckResult,
} from "../src/external-checker";

const URLS = ["a", "b", "c", "d", "e", "f"].map((p) => `https://example.com/${p}`);

const live = (url: string): ExternalCheckResult => ({
  href: url,
  status: 200,
  error: null,
  redirectTarget: null,
  fromCache: false,
});

/** A dead-links service that answers every url it is sent, as live. */
const answersAll = async (urls: string[]) => new Map(urls.map((u) => [u, live(u)] as const));

/** One that is sent the chunk and never answers. */
const neverAnswers = () => new Promise<Map<string, ExternalCheckResult>>(() => {});

afterEach(() => {
  jest.useRealTimers();
});

describe("runBulkChecker under a budget", () => {
  test("a call that never answers is abandoned at its allowance (fake timers)", async () => {
    jest.useFakeTimers();
    let calls = 0;
    const pass = runBulkChecker(
      () => {
        calls++;
        return neverAnswers();
      },
      URLS,
      2,
      { maxWaitMs: 90_000 },
    );
    jest.advanceTimersByTime(90_000);
    const resolved = await pass;
    // Abandoned like a failed call: the pass ends, nothing is resolved, and the
    // urls are left for the local path.
    expect(calls).toBe(1);
    expect(resolved.size).toBe(0);
  });

  test("a hung call cannot hold the pass past the deadline either (fake timers)", async () => {
    jest.useFakeTimers();
    const start = Date.now();
    const pass = runBulkChecker(neverAnswers, URLS, 2, {
      deadlineAt: start + 60_000,
      maxWaitMs: 600_000,
    });
    jest.advanceTimersByTime(60_000);
    expect((await pass).size).toBe(0);
  });

  /** A service whose every call takes `ms` on the injected clock. */
  function takes(ms: number, clock: { now: number }, sent: string[][]) {
    return async (urls: string[]) => {
      sent.push(urls);
      clock.now += ms;
      return answersAll(urls);
    };
  }

  test("no chunk is sent once the deadline has passed", async () => {
    const clock = { now: 0 };
    const sent: string[][] = [];
    const resolved = await runBulkChecker(takes(30, clock, sent), URLS, 2, {
      deadlineAt: 100,
      now: () => clock.now,
    });
    // Sent at 0, 30 and 60: all inside the budget.
    expect(sent).toHaveLength(3);
    expect(resolved.size).toBe(6);

    const late = { now: 150 };
    sent.length = 0;
    await runBulkChecker(takes(30, late, sent), URLS, 2, { deadlineAt: 100, now: () => late.now });
    expect(sent).toEqual([]);
  });

  test("no chunk is sent with less time left than the slowest chunk so far", async () => {
    // The service may charge for a chunk whose answer the deadline would throw away.
    const clock = { now: 0 };
    const sent: string[][] = [];
    const cut = await runBulkChecker(takes(40, clock, sent), URLS, 2, {
      deadlineAt: 100,
      now: () => clock.now,
    });
    // Sent at 0 and 40; at 80 only 20 are left for a 40 chunk.
    expect(sent).toHaveLength(2);
    expect([...cut.keys()]).toEqual(URLS.slice(0, 4));
  });

  test("a zero, negative or non-numeric limit is no limit", async () => {
    for (const maxWaitMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 40]) {
      const resolved = await runBulkChecker(answersAll, URLS, 2, { maxWaitMs });
      expect(resolved.size).toBe(6);
    }
  });

  test("a progress callback that throws does not end the pass", async () => {
    const resolved = await runBulkChecker(answersAll, URLS, 2, {
      onChunk: () => {
        throw new Error("caller bug");
      },
    });
    expect(resolved.size).toBe(6);
  });

  test("reports after every chunk, with the running count", async () => {
    const seen: number[] = [];
    await runBulkChecker(answersAll, URLS, 2, { onChunk: (n) => seen.push(n) });
    expect(seen).toEqual([2, 4, 6]);
  });
});

/** A host that accepts every request and never answers it. */
function serveSilence(): string {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  servers.push(server);
  return `http://silent.example.com:${server.port}`;
}
const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const LOCAL = {
  concurrency: 2,
  // Far longer than the allowance: the request's own timeout is not what ends it.
  timeoutMs: 600_000,
  userAgent: "squirrel-test",
  egress: { allowPrivateNetwork: true, resolve: async () => ["127.0.0.1"] },
};

describe("checkExternalLinks under a budget", () => {
  test("a silent host is not waited on past the allowance, and is left unanswered", async () => {
    const origin = serveSilence();
    const urls = [`${origin}/x`, `${origin}/y`, `${origin}/z`];
    const progress: number[] = [];
    const results = await Effect.runPromise(
      checkExternalLinks(urls, null, {
        ...LOCAL,
        maxWaitMs: 50,
        onProgress: ({ done }) => progress.push(done),
      }),
    );
    // Never answered, so never a verdict: not broken, not live, just absent.
    expect(results).toEqual([]);
    // Every settle is reported, answered or not.
    expect(progress).toEqual([0, 0, 0]);
  });

  test("links a slow bulk service left unanswered get no local check after the deadline", async () => {
    let clock = 0;
    const results = await Effect.runPromise(
      checkExternalLinks(URLS, null, {
        ...LOCAL,
        bulkChecker: async (urls) => {
          clock = 1_000; // the service took the whole budget, then answered two
          return answersAll(urls.slice(0, 2));
        },
        deadlineAt: 500,
        now: () => clock,
      }),
    );
    // The two the service answered before the deadline; nothing is requested after it.
    expect(results.map((r) => r.href)).toEqual(URLS.slice(0, 2));
  });

  test("progress counts cache hits and bulk answers", async () => {
    const cached = URLS[0]!;
    const progress: Array<{ done: number; total: number; fromCache: number }> = [];
    await Effect.runPromise(
      // The default, public-only egress: the shared cache is read only under it.
      checkExternalLinks(
        URLS,
        {
          getCachedBulk: () => new Map([[cached, { ...live(cached), checkedAt: Date.now() }]]),
          setCachedBulk: () => {},
        },
        {
          concurrency: 2,
          timeoutMs: 2_000,
          userAgent: "squirrel-test",
          bulkChecker: answersAll,
          onProgress: (p) => progress.push(p),
        },
      ),
    );
    expect(progress).toEqual([{ done: 6, total: 6, fromCache: 1 }]);
  });
});

/** A host that answers every request with an empty 200. */
function serveOk(): string {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function crawlOn(baseUrl: string) {
  const storage = new SQLiteStorage(":memory:");
  await Effect.runPromise(Effect.orDie(storage.init()));
  const crawlId = await Effect.runPromise(
    Effect.orDie(
      storage.createCrawl({
        baseUrl,
        seedUrl: baseUrl,
        originalUrl: baseUrl,
        startedAt: Date.now(),
        status: "running",
        config: {},
        stats: {},
      } as never),
    ),
  );
  return { storage, crawlId };
}

function linkedFrom(page: string, hrefs: string[]): ExternalLinkOccurrences {
  return new Map(
    hrefs.map((href) => [
      href,
      [{ pageUrl: page, text: "x", position: "content" as const, isNofollow: false }],
    ]),
  );
}

const CONFIG = { enabled: true, concurrency: 2, timeout_ms: 600_000, cache_ttl_days: 1 } as never;

describe("the external link phase records the links it ran out of time on", () => {
  test("a silent host's links are counted as outOfTime and never stored as a verdict", async () => {
    // A site on a private network, so its loopback links are requested locally.
    const site = serveOk();
    const answered = `${serveOk()}/live`;
    const silent = serveSilence().replace("silent.example.com", "127.0.0.1");
    const { storage, crawlId } = await crawlOn(site);
    const progress: number[] = [];

    await Effect.runPromise(
      checkCollectedExternalLinks(
        storage,
        crawlId,
        linkedFrom(`${site}/`, [answered, `${silent}/a`, `${silent}/b`]),
        CONFIG,
        (p) => progress.push(p.checked),
        null,
        undefined,
        undefined,
        undefined,
        // Room for the live host to answer on a loaded runner.
        { maxWaitMs: 1_000 },
      ),
    );

    const stats = await Effect.runPromise(Effect.orDie(storage.getStats(crawlId)));
    expect(stats?.externalLinkCheck).toMatchObject({ found: 3, checked: 3, outOfTime: 2 });
    const rows = await Effect.runPromise(Effect.orDie(storage.getLinks(crawlId)));
    expect(rows.filter((l) => !l.isInternal).map((l) => [l.href, l.status])).toEqual([
      [answered, 200],
    ]);
    // A report per settled check, then the final one.
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(1);
  });

  test("a bulk call that outlives the budget ends the stage: nothing after it is requested", async () => {
    const site = serveOk();
    const { storage, crawlId } = await crawlOn(site);
    let bulkCalls = 0;

    await Effect.runPromise(
      checkCollectedExternalLinks(
        storage,
        crawlId,
        linkedFrom(`${site}/`, URLS),
        CONFIG,
        undefined,
        null,
        () => {
          bulkCalls++;
          return neverAnswers();
        },
        undefined,
        undefined,
        { budgetMs: 30 },
      ),
    );

    // One call, abandoned at the budget; no local check of the six after it.
    expect(bulkCalls).toBe(1);
    const stats = await Effect.runPromise(Effect.orDie(storage.getStats(crawlId)));
    expect(stats?.externalLinkCheck).toMatchObject({ found: 6, checked: 6, outOfTime: 6 });
  });

  test("no limits: the stats carry no outOfTime", async () => {
    const site = serveOk();
    const { storage, crawlId } = await crawlOn(site);
    await Effect.runPromise(
      checkCollectedExternalLinks(
        storage,
        crawlId,
        linkedFrom(`${site}/`, [`${serveOk()}/live`]),
        CONFIG,
      ),
    );
    const stats = await Effect.runPromise(Effect.orDie(storage.getStats(crawlId)));
    expect(stats?.externalLinkCheck).not.toHaveProperty("outOfTime");
  });
});
