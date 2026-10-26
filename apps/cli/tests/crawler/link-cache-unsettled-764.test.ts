// pub#764: the local link cache keeps only settled answers.
//
// A signed-in CLI checks its external links through the cloud dead-links
// service (the engine's bulk checker) and writes the answers into the global
// link cache, which serves them for `cache_ttl_days` (7 by default). Two kinds
// of answer must not sit there for a week:
//
// - A rate-limited answer. The cache row has no `rateLimited` column (#1829:
//   throttled results are never cached), so a 503 the service flagged as
//   rate limited would be read back as a bare 503, a broken link.
// - An answer the service could not verify (`wafBlocked`, status null): a
//   timeout, a bot wall, a 404 waiting for its confirming check. Cached, the
//   confirming answer would not reach the user for a week.
//
// Fixed in the engine by #755 and pub#800; this pins it through the real
// SQLite cache: the next run asks again instead of reading the old answer.

import {
  checkExternalLinks,
  filterBrokenLinks,
  filterRateLimitedLinks,
  type ExternalCheckResult,
} from "@squirrelscan/audit-engine/external-checker";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LinkCacheStorage } from "../../src/crawler/storage/link-cache";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratchCache(): LinkCacheStorage {
  const dir = mkdtempSync(join(tmpdir(), "squirrel-link-cache-764-"));
  dirs.push(dir);
  return new LinkCacheStorage(join(dir, "link-cache.db"));
}

const TTL = 7 * 24 * 60 * 60;

// pub#775: the cache is read and written only under a public-only policy.
// Every name resolves to a private address here, so a link the bulk checker
// leaves unanswered is refused locally and nothing leaves the machine.
const PUBLIC_ONLY = {
  allowPrivateNetwork: false,
  resolve: async () => ["10.0.0.7"],
};

const THROTTLED_503 = "https://throttled.example.com/a";
const THROTTLED_429 = "https://throttled.example.com/b";
const THROTTLED_430 = "https://shop.example.com/c";
const UNVERIFIED = "https://walled.example.com/d";
const GONE = "https://example.com/gone";
const FINE = "https://example.com/fine";

const answer = (
  href: string,
  over: Partial<ExternalCheckResult>
): ExternalCheckResult => ({
  href,
  status: 200,
  error: null,
  redirectTarget: null,
  fromCache: false,
  ...over,
});

/** The dead-links service's answers, as the CLI's bulk checker returns them. */
const FIRST_ANSWERS = new Map<string, ExternalCheckResult>([
  [THROTTLED_503, answer(THROTTLED_503, { status: 503, rateLimited: true })],
  [THROTTLED_429, answer(THROTTLED_429, { status: 429 })],
  [THROTTLED_430, answer(THROTTLED_430, { status: 430 })],
  [UNVERIFIED, answer(UNVERIFIED, { status: null, wafBlocked: true })],
  [GONE, answer(GONE, { status: 404 })],
  [FINE, answer(FINE, { status: 200 })],
]);

const URLS = [...FIRST_ANSWERS.keys()];

function run(
  cache: LinkCacheStorage,
  answers: Map<string, ExternalCheckResult>,
  asked: string[][]
): Promise<Map<string, ExternalCheckResult>> {
  return Effect.runPromise(
    checkExternalLinks(URLS, cache, {
      concurrency: 2,
      timeoutMs: 2_000,
      userAgent: "squirrel-test",
      ttlSeconds: TTL,
      egress: PUBLIC_ONLY,
      bulkChecker: async (urls) => {
        asked.push([...urls].sort());
        return new Map(
          urls.flatMap((u) => (answers.has(u) ? [[u, answers.get(u)!]] : []))
        );
      },
    })
  ).then((results) => new Map(results.map((r) => [r.href, r])));
}

describe("the local link cache keeps only settled answers (pub#764)", () => {
  test("rate-limited and unverifiable bulk answers are never written; real answers are", async () => {
    const cache = scratchCache();
    try {
      const results = await run(cache, FIRST_ANSWERS, []);

      // This run's own verdicts: throttled and unverified are neither broken
      // nor cached, and the 503 keeps the service's rate-limited flag.
      expect(results.get(THROTTLED_503)).toMatchObject({
        status: 503,
        rateLimited: true,
      });
      expect(
        filterRateLimitedLinks([...results.values()])
          .map((r) => r.href)
          .sort()
      ).toEqual([THROTTLED_503, THROTTLED_429, THROTTLED_430].sort());
      expect(
        filterBrokenLinks([...results.values()]).map((r) => r.href)
      ).toEqual([GONE]);

      const stored = cache.getCachedBulk(URLS, TTL);
      expect([...stored.keys()].sort()).toEqual([FINE, GONE].sort());
    } finally {
      cache.close();
    }
  });

  test("the next run asks the service again, and gets its settled answer", async () => {
    const cache = scratchCache();
    try {
      await run(cache, FIRST_ANSWERS, []);

      // Minutes later the service has its confirming answers.
      const settled = new Map(
        URLS.map((u) => [u, answer(u, { status: u === GONE ? 404 : 200 })])
      );
      const asked: string[][] = [];
      const second = await run(cache, settled, asked);

      // Only the unsettled links were asked about; the rest came from the cache.
      expect(asked).toEqual([
        [THROTTLED_503, THROTTLED_429, THROTTLED_430, UNVERIFIED].sort(),
      ]);
      for (const u of [
        THROTTLED_503,
        THROTTLED_429,
        THROTTLED_430,
        UNVERIFIED,
      ]) {
        expect(second.get(u)).toMatchObject({ status: 200, fromCache: false });
      }
      expect(second.get(GONE)).toMatchObject({ status: 404, fromCache: true });
      expect(second.get(FINE)).toMatchObject({ status: 200, fromCache: true });
      expect(
        filterBrokenLinks([...second.values()]).map((r) => r.href)
      ).toEqual([GONE]);
    } finally {
      cache.close();
    }
  });
});
