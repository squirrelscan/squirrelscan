// squirrelscan/repo#2717: the engine's own fetches of site-controlled URLs
// (script contents, the cloaking probe, the soft-404 confirmation) read bodies
// under a byte cap, and Bun's fetch inflates a Content-Encoding body in full
// before any cap applies. Each must turn that decoding off on every hop and
// still see the decoded body.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { brotliCompressSync, createGzip, gzipSync } from "node:zlib";

import { parsePage } from "@squirrelscan/parser";

import { runCloakingProbe } from "../src/cloaking-probe";
import { checkExternalLink } from "../src/external-checker";
import { checkResourceSizes } from "../src/resource-checker";
import { fetchScriptContents } from "../src/script-fetcher";
import { confirmSoft404Candidates } from "../src/soft404-confirm";

const SCRIPT = `window.squirrel = ${JSON.stringify("nuts ".repeat(100))};`;
const STYLE = `body { color: ${"rebeccapurple ".repeat(50)}; }`;
const WAF_PAGE = `<!doctype html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt = {};</script></body></html>`;
const PAGE = `<!doctype html><html><head><title>Honest page</title></head><body><p>${"the same honest page for everyone ".repeat(20)}</p></body></html>`;
const SHELL = `<!doctype html>
<html id="__next_error__">
  <head><meta name="robots" content="noindex" /><title>Page Not Found | Example</title></head>
  <body><main><h1>Page Not Found</h1><p>The page does not exist.</p></main></body>
</html>`;

/** 1 GiB of spaces through gzip, never held whole: about 1 MB. */
async function gzipBomb(): Promise<Buffer> {
  const gzip = createGzip({ level: 6 });
  const out: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => out.push(chunk));
  const ended = new Promise((resolve) => gzip.on("end", resolve));
  const chunk = Buffer.alloc(16 * 1024 * 1024, 0x20);
  for (let i = 0; i < 64; i++) {
    if (!gzip.write(chunk)) await new Promise((resolve) => gzip.once("drain", resolve));
  }
  gzip.end();
  await ended;
  return Buffer.concat(out);
}

let bomb: Buffer;
let server: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(async () => {
  bomb = await gzipBomb();
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/moved")) {
        return new Response(null, {
          status: 302,
          headers: { location: path.slice("/moved".length) },
        });
      }
      if (path === "/app.js") {
        return new Response(gzipSync(SCRIPT), {
          headers: { "content-type": "application/javascript", "content-encoding": "gzip" },
        });
      }
      if (path === "/style.css") {
        // Chunked, so no Content-Length gives the size: the checker reads it.
        const bytes = gzipSync(STYLE);
        let sent = 0;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await Bun.sleep(1);
              if (sent >= bytes.byteLength) return controller.close();
              controller.enqueue(bytes.subarray(sent, sent + 16));
              sent += 16;
            },
          }),
          { headers: { "content-type": "text/css", "content-encoding": "gzip" } },
        );
      }
      if (path === "/huge.css") {
        // Chunked, so the checker counts the whole decoded body for its size.
        let offset = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (offset >= bomb.byteLength) return controller.close();
              controller.enqueue(bomb.subarray(offset, offset + 64 * 1024));
              offset += 64 * 1024;
            },
          }),
          { headers: { "content-type": "text/css", "content-encoding": "gzip" } },
        );
      }
      if (path === "/waf") {
        // A Cloudflare interstitial, told apart from a broken link by its body.
        return new Response(gzipSync(WAF_PAGE), {
          status: 403,
          headers: { "content-type": "text/html", "content-encoding": "gzip" },
        });
      }
      if (path === "/page") {
        return new Response(brotliCompressSync(PAGE), {
          headers: { "content-type": "text/html", "content-encoding": "br" },
        });
      }
      if (path === "/gone") {
        return new Response(gzipSync(SHELL), {
          headers: { "content-type": "text/html", "content-encoding": "gzip" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

const real = globalThis.fetch;
const sent: Array<{ path: string; decompress: unknown }> = [];

beforeAll(() => {
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        path: new URL(String(input)).pathname,
        decompress: (init as { decompress?: unknown } | undefined)?.decompress,
      });
      return real(input, init);
    },
    { preconnect: real.preconnect },
  );
});
afterAll(() => {
  globalThis.fetch = real;
});
afterEach(() => {
  sent.length = 0;
});

describe("engine fetches of site-controlled URLs", () => {
  test("script contents: every redirect hop undecoded, the script read decoded", async () => {
    const [result] = await Effect.runPromise(fetchScriptContents([`${origin}/moved/app.js`]));
    expect(result?.content).toBe(SCRIPT);
    expect(result?.contentEncoding).toBe("gzip");
    expect(sent.map((s) => s.path)).toEqual(["/moved/app.js", "/app.js"]);
    expect(sent.every((s) => s.decompress === false)).toBe(true);
  });

  test("resource sizes: every hop undecoded, the size measured on the decoded body", async () => {
    const [result] = await Effect.runPromise(checkResourceSizes([`${origin}/moved/style.css`]));
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe("gzip");
    expect(result?.sizeBytes).toBe(STYLE.length);
    expect(sent.map((s) => s.path)).toContain("/style.css");
    expect(sent.every((s) => s.decompress === false)).toBe(true);
  });

  test("resource sizes: a body that inflates to 1 GiB is counted, never held", async () => {
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 1);
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${origin}/huge.css`], { timeoutMs: 30_000 }),
    );
    clearInterval(sampler);
    expect(result?.sizeBytes).toBe(1024 * 1024 * 1024);
    // Buffered whole, as this read once was, the body alone is 1 GiB.
    expect(Math.max(peak, process.memoryUsage().rss) - before).toBeLessThan(256 * 1024 * 1024);
  }, 30_000);

  test("external links: HEAD and GET undecoded, a 403 interstitial read decoded", async () => {
    // Loopback fixture: the policy a private site's audit uses.
    const result = await Effect.runPromise(
      checkExternalLink(`${origin}/waf`, null, { egress: { allowPrivateNetwork: true } }),
    );
    expect(result.wafBlocked).toBe(true);
    expect(result.wafProvider).toBe("cloudflare");
    expect(sent.map((s) => s.path)).toEqual(["/waf", "/waf"]);
    expect(sent.every((s) => s.decompress === false)).toBe(true);
  });

  test("cloaking probe: both identities fetch undecoded and compare decoded pages", async () => {
    const [probe] = await runCloakingProbe([{ url: `${origin}/moved/page`, reason: "orphan" }], {
      maxPages: 1,
      recentDays: 14,
      queryVariation: false,
      googlebotUserAgent: "Googlebot",
      defaultUserAgent: "squirrel-test",
    });
    expect(probe?.defaultStatus).toBe(200);
    expect(probe?.uaSimilarity).toBe(1);
    expect(probe?.defaultBytes).toBe(PAGE.length);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.decompress === false)).toBe(true);
  });

  test("soft-404 confirmation: the re-fetch is undecoded and sees the decoded shell", async () => {
    const url = `${origin}/moved/gone`;
    const pages = [{ url, statusCode: 200, parsed: parsePage(SHELL, url) }];
    const summary = await confirmSoft404Candidates(pages, { userAgent: "squirrel-test" });
    expect(summary.confirmed).toBe(1);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.decompress === false)).toBe(true);
  });
});
