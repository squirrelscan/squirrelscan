// squirrelscan/repo#2717: the CLI's own script fetcher, external link checker
// and reachability probe fetch site-controlled URLs, and Bun's fetch inflates
// a Content-Encoding body in full before any reader can stop it. Each turns
// that decoding off and reads the body decoded, no further than its cap.

import { readBodyCapped } from "@squirrelscan/utils/response-body";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip, gzipSync } from "node:zlib";

import { checkExternalLinks } from "@/crawler/external-checker";
import { fetchScriptContents } from "@/crawler/script-fetcher";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { LinkCacheStorage } from "@/crawler/storage/link-cache";
import { requestOnceScoped } from "@/tools/request";

const SCRIPT = `window.squirrel = ${JSON.stringify("nuts ".repeat(100))};`;
const WAF_PAGE = `<!doctype html><title>Just a moment...</title><script>window._cf_chl_opt = {};</script>`;

/** 1 GiB of spaces through gzip, never held whole: about 1 MB. */
async function gzipBomb(): Promise<Buffer> {
  const gzip = createGzip({ level: 6 });
  const out: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => out.push(chunk));
  const ended = new Promise((resolve) => gzip.on("end", resolve));
  const chunk = Buffer.alloc(16 * 1024 * 1024, 0x20);
  for (let i = 0; i < 64; i++) {
    if (!gzip.write(chunk))
      await new Promise((resolve) => gzip.once("drain", resolve));
  }
  gzip.end();
  await ended;
  return Buffer.concat(out);
}

let bomb: Uint8Array<ArrayBuffer>;
let server: ReturnType<typeof Bun.serve>;
let base: string;

const cacheDir = mkdtempSync(join(tmpdir(), "squirrel-undecoded-"));
const priorContentStorePath = process.env.SQUIRREL_CONTENT_STORE_PATH;
process.env.SQUIRREL_CONTENT_STORE_PATH = join(cacheDir, "content.db");
const linkCache = new LinkCacheStorage(join(cacheDir, "links.db"));

beforeAll(async () => {
  bomb = new Uint8Array(await gzipBomb());
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/moved.js") {
        return new Response(null, {
          status: 302,
          headers: { location: "/app.js" },
        });
      }
      if (path === "/app.js" || path === "/bomb.js") {
        return new Response(path === "/app.js" ? gzipSync(SCRIPT) : bomb, {
          headers: {
            "content-type": "application/javascript",
            "content-encoding": "gzip",
          },
        });
      }
      if (path === "/waf") {
        return new Response(req.method === "HEAD" ? null : gzipSync(WAF_PAGE), {
          status: 403,
          headers: { "content-type": "text/html", "content-encoding": "gzip" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  linkCache.close();
  closeGlobalContentStore();
  if (priorContentStorePath === undefined) {
    delete process.env.SQUIRREL_CONTENT_STORE_PATH;
  } else {
    process.env.SQUIRREL_CONTENT_STORE_PATH = priorContentStorePath;
  }
  rmSync(cacheDir, { recursive: true, force: true });
});

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
    { preconnect: real.preconnect }
  );
});
afterAll(() => {
  globalThis.fetch = real;
});
afterEach(() => {
  sent.length = 0;
});

describe("CLI fetches of site-controlled URLs (#2717)", () => {
  test("a script is fetched undecoded and read decoded", async () => {
    const [result] = await Effect.runPromise(
      fetchScriptContents([`${base}/moved.js`])
    );
    expect(result?.content).toBe(SCRIPT);
    expect(result?.contentEncoding).toBe("gzip");
    expect(sent).toEqual([{ path: "/moved.js", decompress: false }]);
  });

  test("a script that inflates to 1 GiB is refused at the size limit, not inflated", async () => {
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 1);
    const [result] = await Effect.runPromise(
      fetchScriptContents([`${base}/bomb.js`])
    );
    clearInterval(sampler);
    expect(result?.error).toBe("script too large");
    // The read used to be an unbounded `.text()` of the inflated gigabyte.
    expect(Math.max(peak, process.memoryUsage().rss) - before).toBeLessThan(
      256 * 1024 * 1024
    );
  });

  test("an external link's HEAD and GET are undecoded, its 403 body read decoded", async () => {
    const [result] = await Effect.runPromise(
      checkExternalLinks([`${base}/waf`], linkCache)
    );
    expect(result?.wafBlocked).toBe(true);
    expect(result?.wafProvider).toBe("cloudflare");
    expect(sent).toEqual([
      { path: "/waf", decompress: false },
      { path: "/waf", decompress: false },
    ]);
  });

  test("the reachability probe's request is undecoded", async () => {
    const text = await Effect.runPromise(
      requestOnceScoped(`${base}/app.js`, { method: "GET" }, (res) =>
        readBodyCapped(res, 10_240)
      )
    );
    expect(text).toBe(SCRIPT);
    expect(sent).toEqual([{ path: "/app.js", decompress: false }]);
  });
});
