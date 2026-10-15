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
  type LinkCache,
  type LinkCacheEntry,
} from "../src/external-checker";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

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
            headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "8a1b2c3d4e5f-SYD" },
          });
        case "/503-mitigated":
          return new Response("", { status: 503, headers: { "cf-mitigated": "challenge" } });
        case "/stall":
          await Bun.sleep(3_000);
          return new Response("late");
        default: {
          const status = Number(path.slice(1));
          return new Response(`status ${status}`, { status: Number.isInteger(status) ? status : 200 });
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
        socket.write("HTTP/1.1 999 Request denied\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
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
): Promise<Map<string, ExternalCheckResult>> {
  return Effect.runPromise(
    checkExternalLinks(urls, cache, {
      concurrency: 4,
      timeoutMs: 500,
      userAgent: "squirrel-test",
      egress: { allowPrivateNetwork: true },
    }),
  ).then((results) => new Map(results.map((r) => [r.href, r])));
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

  test("a timeout is unverifiable, not broken, and is not cached", async () => {
    const base = serve();
    const written: LinkCacheEntry[] = [];
    const cache: LinkCache = {
      getCachedBulk: () => new Map(),
      setCachedBulk: (entries) => written.push(...entries),
    };
    const r = (await check([`${base}/stall`, `${base}/200`], cache)).get(`${base}/stall`)!;
    expect(r).toMatchObject({ status: null, error: null, wafBlocked: true, wafProvider: "unknown" });
    expect(filterBrokenLinks([r])).toEqual([]);
    expect(written.map((e) => e.href)).toEqual([`${base}/200`]);
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
    const base = serve();
    const stale: LinkCacheEntry[] = [
      { href: `${base}/405`, status: 405, error: null, redirectTarget: null, checkedAt: Date.now() },
      { href: `${base}/stall`, status: null, error: "timeout", redirectTarget: null, checkedAt: Date.now() },
      { href: `${base}/404`, status: 404, error: null, redirectTarget: null, checkedAt: Date.now() },
    ];
    const cache: LinkCache = {
      getCachedBulk: () => new Map(stale.map((e) => [e.href, e])),
      setCachedBulk: () => {},
    };
    const results = await check(
      stale.map((e) => e.href),
      cache,
    );
    expect(results.get(`${base}/405`)).toMatchObject({ fromCache: false, wafBlocked: true });
    expect(results.get(`${base}/stall`)).toMatchObject({ fromCache: false, wafBlocked: true });
    // A real answer from the cache is still used as-is.
    expect(results.get(`${base}/404`)).toMatchObject({ fromCache: true, status: 404 });
  });
});
