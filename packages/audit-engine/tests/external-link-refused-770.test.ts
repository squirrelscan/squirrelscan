// pub#770: the external link check refuses a private, link-local or metadata
// address on a public site's audit (#767). That refusal now happens before the
// link cache and the cloud bulk checker, which would otherwise answer for the
// link (a verdict another audit cached, or a remote service asked), and the
// refused links are counted and sampled so the report can list them.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";

import { checkCollectedExternalLinks, type ExternalLinkOccurrences } from "../src/adapter";
import {
  checkExternalLinks,
  type ExternalCheckResult,
  type LinkCacheEntry,
} from "../src/external-checker";

const PRIVATE = "http://192.168.1.1/admin";
const LOOPBACK = "http://127.0.0.1:9/status";

describe("a refused address is settled before the cache and the bulk checker", () => {
  test("neither answers for it, and it comes back refused", async () => {
    const cacheAsked: string[][] = [];
    const cache = {
      // A verdict a private site's audit cached for the same URL.
      getCachedBulk: (urls: string[]) => {
        cacheAsked.push(urls);
        return new Map<string, LinkCacheEntry>(
          urls.map((href) => [
            href,
            { href, status: 200, error: null, redirectTarget: null, checkedAt: Date.now() },
          ]),
        );
      },
      setCachedBulk: () => {},
    };
    const bulkAsked: string[][] = [];
    const results = await Effect.runPromise(
      checkExternalLinks([PRIVATE, LOOPBACK], cache, {
        concurrency: 2,
        timeoutMs: 2_000,
        userAgent: "squirrel-test",
        egress: { allowPrivateNetwork: false },
        bulkChecker: async (urls) => {
          bulkAsked.push(urls);
          return new Map<string, ExternalCheckResult>();
        },
      }),
    );
    expect(cacheAsked).toEqual([]);
    expect(bulkAsked).toEqual([]);
    expect(results.map((r) => [r.href, r.status, r.error, r.refused, r.fromCache])).toEqual([
      [PRIVATE, null, null, true, false],
      [LOOPBACK, null, null, true, false],
    ]);
  });
});

describe("the external link phase records the refused links", () => {
  test("a public site's page linking private addresses: counted and sampled, masked", async () => {
    const storage = new SQLiteStorage(":memory:");
    await Effect.runPromise(Effect.orDie(storage.init()));
    const crawlId = await Effect.runPromise(
      Effect.orDie(
        storage.createCrawl({
          baseUrl: "https://example.com",
          seedUrl: "https://example.com",
          originalUrl: "https://example.com",
          startedAt: Date.now(),
          status: "running",
          config: {},
          stats: {},
        } as never),
      ),
    );
    const occurrences: ExternalLinkOccurrences = new Map();
    for (const [href, pages] of [
      [`${PRIVATE}?id=7`, ["https://example.com/", "https://example.com/about"]],
      [LOOPBACK, ["https://example.com/"]],
    ] as const) {
      occurrences.set(
        href,
        pages.map((pageUrl) => ({
          pageUrl,
          text: "link",
          position: "content" as const,
          isNofollow: false,
        })),
      );
    }
    await Effect.runPromise(
      checkCollectedExternalLinks(
        storage,
        crawlId,
        occurrences,
        { enabled: true, concurrency: 2, timeout_ms: 2_000, cache_ttl_days: 1 } as never,
        undefined,
        null,
      ),
    );
    const stats = await Effect.runPromise(Effect.orDie(storage.getStats(crawlId)));
    expect(stats?.externalLinkCheck).toMatchObject({
      found: 2,
      checked: 2,
      refused: 2,
      refusedLinks: [
        {
          href: "http://192.168.1.1/admin?id=…",
          sourcePages: ["https://example.com/", "https://example.com/about"],
          pageCount: 2,
        },
        { href: "http://127.0.0.1:9/status", sourcePages: ["https://example.com/"], pageCount: 1 },
      ],
    });
  });
});
