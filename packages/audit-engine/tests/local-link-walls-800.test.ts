// pub#800: a link checked from the user's own machine that a bot or sign-in
// wall answers, or that runs out of time, is unverifiable, never broken. The
// local checker used to call a bare 403, a 401/405/406, LinkedIn's 999, a 503
// challenge page and a timeout broken, which is most of what made local link
// checks cry wolf. A real 404/410, a plain 503 and a refused connection stay
// broken. Checked against a real local server.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  checkExternalLinks,
  filterBrokenLinks,
  type ExternalCheckResult,
  cacheableVerdict,
  type LinkCache,
  type LinkCacheEntry,
} from "../src/external-checker";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/**
 * pub#775: the link cache is read and written only under a public-only policy.
 * Every name resolves to a private address here, so a local request is refused
 * and nothing leaves the machine; the tests that need the cache use the bulk
 * checker or a cached answer instead.
 */
const PUBLIC_ONLY = { allowPrivateNetwork: false, resolve: async () => ["10.0.0.7"] };
const PUBLIC = "https://example.com/page";

const CHALLENGE_PAGE =
  '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-form">Checking your browser before accessing the site.</div></body></html>';

/** Every path answers with the status in its name; a few carry wall markers. */
function serve(): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      switch (path) {
        case "/403-cloudflare":
          return new Response("Forbidden", {
            status: 403,
            headers: { server: "cloudflare", "cf-ray": "8a1b2c3d4e5f-SYD" },
          });
        case "/503-challenge":
          return new Response(CHALLENGE_PAGE, {
            status: 503,
            headers: {
              "content-type": "text/html",
              server: "cloudflare",
              "cf-ray": "8a1b2c3d4e5f-SYD",
            },
          });
        case "/503-mitigated":
          return new Response("", { status: 503, headers: { "cf-mitigated": "challenge" } });
        case "/503-retry":
          return new Response("busy", { status: 503, headers: { "retry-after": "120" } });
        case "/403-s3":
          return new Response("<Error><Code>AccessDenied</Code></Error>", {
            status: 403,
            headers: { server: "AmazonS3", "x-amz-request-id": "TESTREQUESTID" },
          });
        case "/403-s3-behind-cdn":
          // CloudFront in front of S3 with a response-headers policy that strips
          // S3's own headers: only the XML error body says what it is.
          return new Response('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>', {
            status: 403,
            headers: { "content-type": "application/xml", "x-amz-cf-id": "TESTCFID" },
          });
        case "/403-cdn-waf":
          return new Response("<html><body>Request blocked.</body></html>", {
            status: 403,
            headers: { "content-type": "text/html", "x-amz-cf-id": "TESTCFID" },
          });
        case "/401-ntlm":
          return new Response("auth", {
            status: 401,
            headers: { "www-authenticate": "Bearer, NTLM" },
          });
        case "/401-basic":
          return new Response("auth", {
            status: 401,
            headers: { "www-authenticate": 'Basic realm="staff"' },
          });
        case "/405-post-only":
          return new Response("method", { status: 405, headers: { allow: "POST, OPTIONS" } });
        case "/head-405-get-404":
          return new Response("gone", { status: req.method === "HEAD" ? 405 : 404 });
        case "/stall":
          await Bun.sleep(3_000);
          return new Response("late");
        default: {
          const status = Number(path.slice(1));
          return new Response(`status ${status}`, {
            status: Number.isInteger(status) ? status : 200,
          });
        }
      }
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

/**
 * LinkedIn's 999, which `Response` refuses to build: a raw socket that answers
 * every request with it.
 */
function serve999(): string {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.write(
          "HTTP/1.1 999 Request denied\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        );
        socket.end();
      },
    },
  });
  servers.push({ stop: () => listener.stop(true) });
  return `http://127.0.0.1:${listener.port}/in/someone`;
}

function check(
  urls: string[],
  cache: LinkCache | null = null,
  extra: {
    timeoutMs?: number;
    bulkChecker?: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>;
  } = {},
): Promise<Map<string, ExternalCheckResult>> {
  return Effect.runPromise(
    checkExternalLinks(urls, cache, {
      concurrency: 4,
      // Generous, so a loaded machine never turns a prompt answer into a
      // timeout; the stall test passes its own.
      timeoutMs: extra.timeoutMs ?? 2_000,
      userAgent: "squirrel-test",
      egress: { allowPrivateNetwork: true },
      ...(extra.bulkChecker ? { bulkChecker: extra.bulkChecker } : {}),
    }),
  ).then((results) => new Map(results.map((r) => [r.href, r])));
}

/** A cache that remembers what was written and answers with `entries`. */
function memoryCache(entries: LinkCacheEntry[] = []): LinkCache & { written: LinkCacheEntry[] } {
  const written: LinkCacheEntry[] = [];
  return {
    written,
    getCachedBulk: (urls) =>
      new Map(entries.filter((e) => urls.includes(e.href)).map((e) => [e.href, e])),
    setCachedBulk: (more) => written.push(...more),
  };
}

describe("local link checks: walls and timeouts are unverifiable (pub#800)", () => {
  test("401, a bare 403, 405, 406 and 999 are unverifiable, with their status", async () => {
    const base = serve();
    const linkedin = serve999();
    const expected = new Map<string, number>([
      ...[401, 403, 405, 406].map((s) => [`${base}/${s}`, s] as [string, number]),
      [linkedin, 999],
    ]);
    const results = await check([...expected.keys()]);
    for (const [url, status] of expected) {
      const r = results.get(url)!;
      expect(r.wafBlocked).toBe(true);
      expect(r.wafProvider).toBe("unknown");
      expect(r.error).toBeNull();
      expect(r.status).toBe(status);
    }
    expect(filterBrokenLinks([...results.values()])).toEqual([]);
  });

  test("a 403 from a named vendor keeps the vendor", async () => {
    const base = serve();
    const r = (await check([`${base}/403-cloudflare`])).get(`${base}/403-cloudflare`)!;
    expect(r).toMatchObject({ status: 403, wafBlocked: true, wafProvider: "cloudflare" });
  });

  test("a 503 challenge page is unverifiable; a plain 503 is still broken", async () => {
    const base = serve();
    const results = await check([`${base}/503-challenge`, `${base}/503-mitigated`, `${base}/503`]);
    expect(results.get(`${base}/503-challenge`)).toMatchObject({ status: 503, wafBlocked: true });
    expect(results.get(`${base}/503-mitigated`)).toMatchObject({ status: 503, wafBlocked: true });
    const plain = results.get(`${base}/503`)!;
    expect(plain.wafBlocked).toBeUndefined();
    expect(filterBrokenLinks([...results.values()]).map((r) => r.href)).toEqual([`${base}/503`]);
  });

  test("a timeout is unverifiable, not broken", async () => {
    const base = serve();
    const r = (await check([`${base}/stall`], null, { timeoutMs: 500 })).get(`${base}/stall`)!;
    expect(r).toMatchObject({
      status: null,
      error: null,
      wafBlocked: true,
      wafProvider: "unknown",
    });
    expect(filterBrokenLinks([r])).toEqual([]);
  });

  test("a non-challenge 503 with Retry-After is still rate limited", async () => {
    const base = serve();
    const r = (await check([`${base}/503-retry`])).get(`${base}/503-retry`)!;
    expect(r).toMatchObject({ status: 503, rateLimited: true });
    expect(r.wafBlocked).toBeUndefined();
  });

  test("the site's own refusals stay broken: an object store's 403, HTTP auth, a 405 that allows no GET", async () => {
    const base = serve();
    const urls = [
      `${base}/403-s3`,
      `${base}/403-s3-behind-cdn`,
      `${base}/401-basic`,
      `${base}/401-ntlm`,
      `${base}/405-post-only`,
    ];
    const results = await check(urls);
    for (const url of urls) expect(results.get(url)!.wafBlocked).toBeUndefined();
    expect(filterBrokenLinks([...results.values()]).length).toBe(5);
    // The same CDN's own block page is still a wall.
    const waf = (await check([`${base}/403-cdn-waf`])).get(`${base}/403-cdn-waf`)!;
    expect(waf.wafBlocked).toBe(true);
  });

  test("a HEAD refused with 405 and a GET answering 404 is a 404", async () => {
    const base = serve();
    const r = (await check([`${base}/head-405-get-404`])).get(`${base}/head-405-get-404`)!;
    expect(r.status).toBe(404);
    expect(filterBrokenLinks([r])).toHaveLength(1);
  });

  test("walls and timeouts are not cached, so a signed-in run asks the cloud next time", () => {
    expect(cacheableVerdict({ status: 403, wafBlocked: true })).toBe(false);
    expect(cacheableVerdict({ status: null, wafBlocked: true })).toBe(false);
    expect(cacheableVerdict({ status: 429, rateLimited: true })).toBe(false);
    expect(cacheableVerdict({ status: null, refused: true })).toBe(false);
    expect(cacheableVerdict({ status: 404 })).toBe(true);
    expect(cacheableVerdict({ status: 200 })).toBe(true);
  });

  test("an unverifiable answer from the cloud bulk checker is not cached either", async () => {
    // pub#775: the cache is only used under a public-only policy.
    const written = memoryCache();
    await Effect.runPromise(
      checkExternalLinks([PUBLIC], written, {
        concurrency: 1,
        timeoutMs: 2_000,
        userAgent: "squirrel-test",
        egress: PUBLIC_ONLY,
        bulkChecker: async (urls) =>
          new Map(
            urls.map((url) => [
              url,
              {
                href: url,
                status: null,
                error: null,
                redirectTarget: null,
                fromCache: false,
                wafBlocked: true,
              },
            ]),
          ),
      }),
    );
    expect(written.written).toEqual([]);
  });

  test("404, 410, a plain 500 and a refused connection stay broken", async () => {
    const base = serve();
    const closed = "http://127.0.0.1:9/gone";
    const results = await check([`${base}/404`, `${base}/410`, `${base}/500`, closed]);
    expect(
      filterBrokenLinks([...results.values()])
        .map((r) => r.href)
        .sort(),
    ).toEqual([`${base}/404`, `${base}/410`, `${base}/500`, closed].sort());
  });

  test("a cached wall or timeout counted broken before is asked again", async () => {
    const before = Date.parse("2026-10-15T00:00:00Z");
    const wall = "https://walled.example.com/x";
    const stalled = "https://stalls.example.com/y";
    const gone = "https://gone.example.com/z";
    const stale: LinkCacheEntry[] = [
      { href: wall, status: 405, error: null, redirectTarget: null, checkedAt: before },
      { href: stalled, status: null, error: "timeout", redirectTarget: null, checkedAt: before },
      { href: gone, status: 404, error: null, redirectTarget: null, checkedAt: before },
    ];
    // Asked again means sent to the checker rather than served from the cache.
    const asked: string[][] = [];
    const results = new Map(
      (
        await Effect.runPromise(
          checkExternalLinks([wall, stalled, gone], memoryCache(stale), {
            concurrency: 1,
            timeoutMs: 2_000,
            userAgent: "squirrel-test",
            egress: PUBLIC_ONLY,
            bulkChecker: async (urls) => {
              asked.push(urls);
              return new Map(
                urls.map((url) => [
                  url,
                  { href: url, status: 200, error: null, redirectTarget: null, fromCache: false },
                ]),
              );
            },
          }),
        )
      ).map((r) => [r.href, r]),
    );
    expect(asked).toEqual([[wall, stalled]]);
    expect(results.get(wall)).toMatchObject({ fromCache: false, status: 200 });
    // A real answer from the cache is still used as-is.
    expect(results.get(gone)).toMatchObject({ fromCache: true, status: 404 });
  });

  test("a wall status cached after the change is a real answer, used as-is", async () => {
    const later: LinkCacheEntry = {
      href: "https://walled.example.com/after",
      status: 403,
      error: null,
      redirectTarget: null,
      checkedAt: Date.parse("2026-12-01T00:00:00Z"),
    };
    const [r] = await Effect.runPromise(
      checkExternalLinks([later.href], memoryCache([later]), {
        concurrency: 1,
        timeoutMs: 2_000,
        userAgent: "squirrel-test",
        egress: PUBLIC_ONLY,
      }),
    );
    expect(r).toMatchObject({ fromCache: true, status: 403 });
    expect(r.wafBlocked).toBeUndefined();
  });
});
