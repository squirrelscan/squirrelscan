// squirrelscan/repo#2717: Bun's fetch inflates a Content-Encoding body in full
// as soon as it arrives, read or not, so no byte cap in the crawl bounded a
// compression bomb: a 1 MB gzip page that inflates to 1 GiB cost 2.9 GB of
// RSS, and a redirect hop's own body did the same even though it is discarded.
// Every request the crawl sends now turns that decoding off, and the capped
// readers decode the body themselves, no further than their cap.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  brotliCompressSync,
  constants,
  createBrotliCompress,
  createGzip,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";

import { DEFAULT_MAX_DOCUMENT_BODY_BYTES } from "@squirrelscan/utils/response-body";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { fetchPage } from "../src/fetcher";
import { fetchLlmsTxt } from "../src/llms";
import { fetchRobotsEvaluator } from "../src/robots";

const GIB = 1024 * 1024 * 1024;
const FETCH_OPTIONS = { userAgent: "squirrel-test", timeoutMs: 30_000, followRedirects: true };

/** `total` bytes of spaces through a streaming compressor, never held whole. */
async function bomb(compressor: NodeJS.ReadWriteStream, total: number): Promise<Buffer> {
  const out: Buffer[] = [];
  compressor.on("data", (chunk: Buffer) => out.push(chunk));
  const ended = new Promise((resolve) => compressor.on("end", resolve));
  const chunk = Buffer.alloc(16 * 1024 * 1024, 0x20);
  for (let sent = 0; sent < total; sent += chunk.byteLength) {
    if (!compressor.write(chunk)) await new Promise((resolve) => compressor.once("drain", resolve));
  }
  compressor.end();
  await ended;
  return Buffer.concat(out);
}

/** A body sent chunked, so no Content-Length lets a probe skip the read. */
function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 64 * 1024));
      offset += 64 * 1024;
    },
  });
}

/** Peak RSS growth while `run` runs. */
async function peakRssGrowth(run: () => Promise<unknown>): Promise<number> {
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 1);
  try {
    await run();
  } finally {
    clearInterval(sampler);
  }
  return Math.max(peak, process.memoryUsage().rss) - before;
}

let gzipBomb: Buffer;
let brBomb: Buffer;
let server: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(async () => {
  gzipBomb = await bomb(createGzip({ level: 6 }), GIB);
  brBomb = await bomb(
    createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }),
    GIB,
  );
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/bomb") {
        return new Response(gzipBomb, {
          headers: { "content-type": "text/html", "content-encoding": "gzip" },
        });
      }
      if (path === "/hop-bomb") {
        // A redirect whose own body is the bomb: the redirect loop discards it.
        return new Response(brBomb, {
          status: 302,
          headers: { location: "/plain", "content-type": "text/html", "content-encoding": "br" },
        });
      }
      if (path === "/plain") {
        return new Response("<!doctype html><title>plain</title>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/robots.txt" || path === "/llms.txt") {
        return new Response(chunked(path === "/llms.txt" ? gzipBomb : brBomb), {
          headers: {
            "content-type": "text/plain",
            "content-encoding": path === "/llms.txt" ? "gzip" : "br",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

describe("a compression bomb costs the cap, not its inflated size", () => {
  test("a page whose gzip body inflates to 1 GiB is recorded cut at the document cap", async () => {
    let body = "";
    const growth = await peakRssGrowth(async () => {
      const result = await Effect.runPromise(fetchPage(`${origin}/bomb`, FETCH_OPTIONS));
      body = result.body;
    });
    expect(body.length).toBe(DEFAULT_MAX_DOCUMENT_BODY_BYTES);
    // Inflated in full: over 1 GiB (2.9 GB measured before #2717). Decoded to
    // the 10 MiB cap: about 50 MB, the same as an uncompressed body over it.
    expect(growth).toBeLessThan(256 * 1024 * 1024);
  });

  test("a redirect hop whose own body is a bomb is never inflated", async () => {
    let title = "";
    const growth = await peakRssGrowth(async () => {
      const result = await Effect.runPromise(fetchPage(`${origin}/hop-bomb`, FETCH_OPTIONS));
      title = result.body;
    });
    expect(title).toContain("plain");
    expect(growth).toBeLessThan(128 * 1024 * 1024);
  });

  test("root probes read a bomb only to their caps", async () => {
    let llmsBytes = 0;
    let robotsBytes = 0;
    const growth = await peakRssGrowth(async () => {
      const llms = await Effect.runPromise(fetchLlmsTxt(origin, "squirrel-test"));
      llmsBytes = llms?.llmsTxt.sizeBytes ?? -1;
      const robots = await Effect.runPromise(fetchRobotsEvaluator(origin, "squirrel-test", true));
      robotsBytes = robots.data.sizeBytes;
    });
    expect(llmsBytes).toBe(1_000_000);
    expect(robotsBytes).toBe(512 * 1024);
    expect(growth).toBeLessThan(128 * 1024 * 1024);
  });
});

const HTML = (title: string, links: string[]) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${links
    .map((href) => `<a href="${href}">${href}</a>`)
    .join("")}</body></html>`;

/** One coding per path, so the crawl meets every one Bun decodes. */
const ENCODERS: Record<string, [string, (body: string) => Uint8Array]> = {
  "/home": ["gzip", (b) => gzipSync(b)],
  "/about": ["br", (b) => brotliCompressSync(b)],
  "/team": ["deflate", (b) => deflateSync(b)],
  "/raw-deflate": ["deflate", (b) => deflateRawSync(b)],
  "/contact": ["zstd", (b) => zstdCompressSync(b)],
};

describe("every request a crawl sends", () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  test("turns the runtime's decoding off, on every hop, and still decodes every page", async () => {
    const site = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        // The seed and a page link both redirect, so seed resolution and the
        // page fetcher's own redirect loop each follow a hop.
        if (path === "/")
          return new Response(null, { status: 301, headers: { location: "/home" } });
        if (path === "/old-team") {
          return new Response(null, { status: 302, headers: { location: "/team" } });
        }
        if (path === "/robots.txt") {
          return new Response(
            gzipSync(`User-agent: *\nAllow: /\nSitemap: ${origin2}/sitemap.xml\n`),
            {
              headers: { "content-type": "text/plain", "content-encoding": "gzip" },
            },
          );
        }
        if (path === "/sitemap.xml") {
          const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin2}/contact</loc></url></urlset>`;
          return new Response(brotliCompressSync(xml), {
            headers: { "content-type": "application/xml", "content-encoding": "br" },
          });
        }
        if (path === "/llms.txt") {
          return new Response(gzipSync("# squirrel\n\n- [home](/home)\n"), {
            headers: { "content-type": "text/plain", "content-encoding": "gzip" },
          });
        }
        const encoder = ENCODERS[path];
        if (encoder) {
          const [coding, encode] = encoder;
          return new Response(
            encode(HTML(`page ${path}`, ["/about", "/old-team", "/raw-deflate"])),
            {
              headers: { "content-type": "text/html", "content-encoding": coding },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    const origin2 = `http://localhost:${site.port}`;

    const sent: Array<{ url: string; decompress: unknown }> = [];
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({
          url: String(input),
          decompress: (init as { decompress?: unknown })?.decompress,
        });
        return real(input, init);
      },
      { preconnect: real.preconnect },
    );

    const config: Partial<CrawlerConfig> = {
      maxPages: 10,
      concurrency: 2,
      perHostConcurrency: 2,
      delayMs: 0,
      perHostDelayMs: 0,
      timeoutMs: 5_000,
      userAgent: "squirrel-test",
      respectRobots: true,
      incremental: false,
      useCacheControl: false,
      breadthFirst: true,
      coverageMode: "full",
    };
    try {
      const crawler = await Effect.runPromise(createCrawler({ config }));
      const crawlId = await Effect.runPromise(crawler.start(`${origin2}/`, `${origin2}/`));
      const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
      globalThis.fetch = real;

      // Every page arrived decoded, whatever its coding.
      const titles = new Map(pages.map((p) => [new URL(p.finalUrl).pathname, p.html ?? ""]));
      for (const path of Object.keys(ENCODERS)) {
        expect(titles.get(path) ?? `missing ${path}`).toContain(`<title>page ${path}</title>`);
      }

      // Every request, root probes, sitemaps, seed resolution and redirect
      // hops included, went out with the runtime's decoding off.
      const paths = new Set(sent.map((s) => new URL(s.url).pathname));
      for (const path of [
        "/",
        "/robots.txt",
        "/llms.txt",
        "/index.md",
        "/.well-known/agent-card.json",
        "/sitemap.xml",
        "/home",
        "/old-team",
        "/team",
      ]) {
        expect(paths.has(path)).toBe(true);
      }
      expect(sent.filter((s) => s.decompress !== false)).toEqual([]);
    } finally {
      globalThis.fetch = real;
      site.stop(true);
    }
  });
});
