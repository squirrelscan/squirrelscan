// #1263 end to end: a logged-out `squirrel audit --http` over a fixture site with a
// known CMS, shop system, tag manager, consent tool and CDN reports every one of
// them in `technologies.items`, from the pages the crawl already fetched and with
// no request beyond the audit's own. The detection needs no account and no credits.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");

// WordPress with WooCommerce (CMS and shop system), Google Tag Manager, Cookiebot
// (consent) and a Cloudflare-served response (CDN). Nothing here is fetched from a
// third party: every signal is in the HTML or the response headers.
const HOME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture shop</title>
<meta name="description" content="A fixture WordPress shop for technology detection.">
<meta name="generator" content="WordPress 6.6.2">
<link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">
<script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="00000000-0000-0000-0000-000000000000" async></script>
<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script>
</head><body><main><h1>Fixture shop</h1><p>${"Welcome to the shop. ".repeat(20)}</p></main></body></html>`;

// No technology marker in the markup: only the response headers name the stack.
const PLAIN_HOME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Header only</title>
<meta name="description" content="A page whose stack is named only by response headers."></head><body><main><h1>Header only</h1><p>${"Plain words. ".repeat(30)}</p></main></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let headerServer: ReturnType<typeof Bun.serve>;
let headerBase: string;
let base: string;
let home: string;
let out: string;
const hits: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      hits.push(pathname);
      if (pathname === "/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (pathname === "/") {
        return new Response(HOME, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            server: "cloudflare",
            "cf-ray": "8a1b2c3d4e5f6a7b-AMS",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  headerServer = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/") {
        return new Response(PLAIN_HOME, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "liferay-portal": "Liferay Community Edition Portal 7.4.3.1",
            "x-azure-ref": "20261030T000000Z-r1abcdef",
            "x-powered-by": "pimcore",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  headerBase = `http://127.0.0.1:${headerServer.port}`;
  home = mkdtempSync(join(tmpdir(), "sq-1263-home-"));
  out = mkdtempSync(join(tmpdir(), "sq-1263-out-"));
});

afterAll(() => {
  server?.stop(true);
  headerServer?.stop(true);
  for (const dir of [home, out]) rmSync(dir, { recursive: true, force: true });
});

async function audit(name: string, extra: string[] = [], target?: string) {
  const cwd = join(out, name);
  mkdirSync(cwd, { recursive: true });
  const file = join(out, `${name}.json`);
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      CLI,
      "audit",
      target ?? base,
      "-m",
      "30",
      "--http",
      "--refresh",
      "-y",
      "-f",
      "json",
      "-o",
      file,
      ...extra,
    ],
    {
      cwd,
      env: { ...process.env, HOME: home, NO_COLOR: "1", NO_TELEMETRY: "1" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`audit exited ${exitCode}\n${stderr}`);
  return JSON.parse(readFileSync(file, "utf8")) as {
    technologies?: {
      source?: string;
      items: Array<{ id: string; category: string }>;
    };
  };
}

describe("#1263 logged-out --http audit detects the stack from the crawled pages", () => {
  test("CMS, shop system, tag manager, consent tool and CDN are all reported", async () => {
    hits.length = 0;
    const report = await audit("local", ["--offline"]);
    expect(report.technologies?.source).toBe("local");
    const items = report.technologies?.items ?? [];
    const ids = items.map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "wordpress",
        "woocommerce",
        "google-tag-manager",
        "cookiebot",
        "cloudflare-cdn",
      ])
    );
    // Free and offline: the audit asked only for the site's own pages.
    expect(hits.every((path) => !path.startsWith("http"))).toBe(true);
  }, 120_000);

  // The crawler stores only allow-listed response headers (TECH_DETECT_HEADER_NAMES), so a
  // fingerprint that reads a header missing from that list never fires in a real audit.
  test("fingerprints that read response headers fire from a real crawl", async () => {
    const report = await audit("headers", ["--offline"], headerBase);
    const ids = (report.technologies?.items ?? []).map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining(["liferay", "azure-front-door", "pimcore"])
    );
  }, 120_000);
});
