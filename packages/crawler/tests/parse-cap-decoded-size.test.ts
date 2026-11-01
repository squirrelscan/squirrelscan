// The `--max-duration` parse cap (#1332) is on the size of the page the parser would see. `sizeBytes` is the
// Content-Length header, the ENCODED size, so a small gzip body that inflates past the cap was parsed anyway: the
// parse cannot be interrupted, which is why the cap exists. The cap now also compares the decoded body.
// Driven through the real crawler.start() against a local server.

import { afterEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

const CAP = 64 * 1024;
const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 5,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 5000,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  coverageMode: "full",
  maxParseBytes: CAP,
};

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

/** A page of `links` anchors: parsed, they are discovered and queued; unparsed, nothing is. */
const html = (links: number, padding: number): string =>
  `<!doctype html><html><head><title>p</title></head><body>${Array.from({ length: links }, (_, i) => `<a href="/l${i}">l${i}</a>`).join("")}<p>${"x".repeat(padding)}</p></body></html>`;

function serve(body: string, { gzip }: { gzip: boolean }): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/") return new Response("<!doctype html><title>l</title><p>leaf</p>", { headers: { "content-type": "text/html" } });
      if (!gzip) return new Response(body, { headers: { "content-type": "text/html" } });
      const packed = gzipSync(body);
      return new Response(packed, { headers: { "content-type": "text/html", "content-encoding": "gzip", "content-length": String(packed.length) } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function crawl(origin: string) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: CONFIG, storage });
      const crawlId = yield* crawler.start(`${origin}/`, `${origin}/`);
      return yield* storage.getPages(crawlId);
    }),
  );
}

describe("the parse cap judges the decoded page (#1332)", () => {
  test("a small gzip body that inflates past the cap is not parsed: its links are not followed", async () => {
    const body = html(20, 300 * 1024);
    expect(gzipSync(body).length).toBeLessThan(CAP / 8); // the wire size is far under the cap, the decoded size far over
    const pages = await crawl(serve(body, { gzip: true }));
    const seed = pages.find((p) => p.normalizedUrl.endsWith("/"))!;
    expect(seed.parsedData).toBeNull();
    expect(pages.length).toBe(1); // no link was discovered, so no other page was fetched
  }, 30_000);

  test("the same page served plain (Content-Length is the decoded size) is not parsed either", async () => {
    const pages = await crawl(serve(html(20, 300 * 1024), { gzip: false }));
    expect(pages.find((p) => p.normalizedUrl.endsWith("/"))!.parsedData).toBeNull();
    expect(pages.length).toBe(1);
  }, 30_000);

  test("a page under the cap, gzip or plain, is parsed and its links followed", async () => {
    for (const gzip of [true, false]) {
      const pages = await crawl(serve(html(5, 2_000), { gzip }));
      expect(pages.find((p) => p.normalizedUrl.endsWith("/"))!.parsedData).not.toBeNull();
      expect(pages.length).toBeGreaterThan(1);
    }
  }, 30_000);

  test("a multi-byte page whose character count is under the cap but whose bytes are over it is not parsed", async () => {
    // 30,000 three-byte characters: 30 K characters, 90 KB of bytes.
    const pages = await crawl(serve(html(20, 0).replace("</p>", `${"中".repeat(30_000)}</p>`), { gzip: true }));
    expect(pages.find((p) => p.normalizedUrl.endsWith("/"))!.parsedData).toBeNull();
  }, 30_000);

  test("the boundary: a decoded page of exactly the cap is parsed, one byte more is not (plain and gzip)", async () => {
    // A page padded to an exact byte length: the shell plus a paragraph of the remaining bytes.
    const exact = (bytes: number): string => {
      const shell = html(5, 0);
      return shell.replace("<p></p>", `<p>${"x".repeat(bytes - Buffer.byteLength(shell))}</p>`);
    };
    for (const gzip of [false, true]) {
      const atCap = exact(CAP);
      const over = exact(CAP + 1);
      expect(Buffer.byteLength(atCap)).toBe(CAP);
      expect(Buffer.byteLength(over)).toBe(CAP + 1);
      const parsedAt = await crawl(serve(atCap, { gzip }));
      expect(parsedAt.find((p) => p.normalizedUrl.endsWith("/"))!.parsedData, `cap, gzip=${gzip}`).not.toBeNull();
      const parsedOver = await crawl(serve(over, { gzip }));
      expect(parsedOver.find((p) => p.normalizedUrl.endsWith("/"))!.parsedData, `cap+1, gzip=${gzip}`).toBeNull();
    }
  }, 60_000);
});
