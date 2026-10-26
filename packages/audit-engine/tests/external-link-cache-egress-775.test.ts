// pub#775: what a private site's audit checks stays out of what other audits
// read, and the cloud bulk checker only ever gets public links.
//
//   - The shared link cache is read and written only under a public-only egress
//     policy. A private site's audit (private addresses allowed) may reach the
//     auditor's network through a public name or a redirect; a public site's
//     audit must never be handed that verdict.
//   - The bulk checker (the cloud dead-links service) is never sent a link
//     whose URL names a non-public host, whatever the policy. Those take the
//     local check.
//   - The service's refusal of a non-public address is not a verdict: the link
//     takes the local check, so it is never recorded as broken.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { EgressPolicy } from "@squirrelscan/utils/public-egress";

import {
  checkExternalLinks,
  filterBrokenLinks,
  isPublicOnlyEgress,
  type ExternalCheckResult,
  type LinkCacheEntry,
} from "../src/external-checker";

let server: ReturnType<typeof Bun.serve>;
let port = 0;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok", { headers: { "content-type": "text/plain" } }),
  });
  port = server.port!;
});

afterAll(() => {
  server.stop(true);
});

const PUBLIC = "https://example.com/page";

/** Every name resolves to `address`, so no lookup leaves the machine. */
function policy(allowPrivateNetwork: boolean, address = "127.0.0.1"): EgressPolicy {
  return { allowPrivateNetwork, resolve: async () => [address] };
}

function spyCache() {
  const asked: string[][] = [];
  const written: LinkCacheEntry[] = [];
  return {
    asked,
    written,
    cache: {
      getCachedBulk: (urls: string[]) => {
        asked.push(urls);
        return new Map<string, LinkCacheEntry>();
      },
      setCachedBulk: (entries: LinkCacheEntry[]) => {
        written.push(...entries);
      },
    },
  };
}

/** A bulk checker that answers `answers` and records what it was sent. */
function spyBulk(answers: Record<string, Partial<ExternalCheckResult>>) {
  const sent: string[][] = [];
  return {
    sent,
    bulkChecker: async (urls: string[]) => {
      sent.push(urls);
      return new Map<string, ExternalCheckResult>(
        urls
          .filter((url) => answers[url])
          .map((url) => [
            url,
            {
              href: url,
              status: null,
              error: null,
              redirectTarget: null,
              fromCache: false,
              ...answers[url],
            },
          ]),
      );
    },
  };
}

const run = (
  urls: string[],
  options: Parameters<typeof checkExternalLinks>[2],
  cache = spyCache(),
) =>
  Effect.runPromise(
    checkExternalLinks(urls, cache.cache, {
      concurrency: 2,
      timeoutMs: 5_000,
      userAgent: "squirrel-test",
      ...options,
    }),
  );

describe("a private site's audit and the shared link cache", () => {
  test("its checks neither read nor write the cache", async () => {
    const cache = spyCache();
    const bulk = spyBulk({ [PUBLIC]: { status: 404 } });
    const local = `http://127.0.0.1:${port}/status`;
    const results = await run(
      [PUBLIC, local],
      { egress: policy(true), bulkChecker: bulk.bulkChecker },
      cache,
    );
    expect(cache.asked).toEqual([]);
    expect(cache.written).toEqual([]);
    expect(results.map((r) => [r.href, r.status, r.fromCache])).toEqual([
      [PUBLIC, 404, false],
      [local, 200, false],
    ]);
  });

  test("a public site's checks still use it", async () => {
    const cache = spyCache();
    const bulk = spyBulk({ [PUBLIC]: { status: 404 } });
    await run([PUBLIC], { egress: policy(false), bulkChecker: bulk.bulkChecker }, cache);
    expect(cache.asked).toEqual([[PUBLIC]]);
    expect(cache.written.map((e) => [e.href, e.status])).toEqual([[PUBLIC, 404]]);
  });
});

describe("which policies may share the cache", () => {
  test("only one held to public addresses on any host", () => {
    expect(isPublicOnlyEgress({ allowPrivateNetwork: false })).toBe(true);
    expect(isPublicOnlyEgress({ allowPrivateNetwork: true })).toBe(false);
    expect(isPublicOnlyEgress({ allowPrivateNetwork: false, allowPrivateTarget: () => true })).toBe(
      false,
    );
    expect(isPublicOnlyEgress({ allowPrivateNetwork: false, trustTarget: () => true })).toBe(false);
    expect(isPublicOnlyEgress({ allowPrivateNetwork: false, allowHost: () => true })).toBe(false);
  });
});

describe("the bulk checker only ever gets public links", () => {
  test("a private site's non-public links are checked locally, never sent", async () => {
    const bulk = spyBulk({ [PUBLIC]: { status: 200 } });
    const nonPublic = [
      `http://127.0.0.1:${port}/a`,
      `http://localhost:${port}/b`,
      `http://nas:${port}/c`,
      `http://printer.local:${port}/d`,
      // pub#805: a Valet or Herd site's own `.test` links stay local too.
      `http://other.test:${port}/e`,
    ];
    const results = await run([PUBLIC, ...nonPublic], {
      egress: policy(true),
      bulkChecker: bulk.bulkChecker,
    });
    expect(bulk.sent).toEqual([[PUBLIC]]);
    // Each answered by the local check (the fixture server, by address).
    expect(results.map((r) => [r.href, r.status])).toEqual([
      [PUBLIC, 200],
      ...nonPublic.map((url) => [url, 200]),
    ]);

    // Only non-public links: the bulk checker is not called at all.
    const none = spyBulk({});
    await run(nonPublic, { egress: policy(true), bulkChecker: none.bulkChecker });
    expect(none.sent).toEqual([]);
  });
});

describe("the bulk checker's refusal of a non-public address is not a verdict", () => {
  const intranet = () => `http://intranet.example.com:${port}/`;

  test("a public site's audit: checked locally, refused, never broken and never cached", async () => {
    const url = intranet();
    const cache = spyCache();
    const bulk = spyBulk({ [url]: { error: "blocked_non_public_host:private" } });
    // The name resolves to a private address, which the public policy refuses.
    const results = await run(
      [url],
      { egress: policy(false, "10.0.0.7"), bulkChecker: bulk.bulkChecker },
      cache,
    );
    expect(bulk.sent).toEqual([[url]]);
    expect(results.map((r) => [r.href, r.status, r.error, r.refused])).toEqual([
      [url, null, null, true],
    ]);
    expect(filterBrokenLinks(results)).toEqual([]);
    expect(cache.written).toEqual([]);
  });

  test("a private site's audit: checked locally and answered", async () => {
    const url = intranet();
    const bulk = spyBulk({ [url]: { error: "blocked_non_public_host:private" } });
    const results = await run([url], { egress: policy(true), bulkChecker: bulk.bulkChecker });
    expect(results.map((r) => [r.href, r.status, r.error])).toEqual([[url, 200, null]]);
    expect(filterBrokenLinks(results)).toEqual([]);
  });

  test("any other bulk error is still the link's answer", async () => {
    const bulk = spyBulk({ [PUBLIC]: { error: "timeout" } });
    const results = await run([PUBLIC], { egress: policy(false), bulkChecker: bulk.bulkChecker });
    expect(results.map((r) => [r.href, r.error])).toEqual([[PUBLIC, "timeout"]]);
  });
});
