// Blocked-page follow-ups (#1258), end to end with the real CLI against local sites:
// a seed that redirects to a challenge is one blocked page, and a stored refusal-shaped
// page with no provider marker warns, lands in the JSON report and is still audited.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-waf-1258-"));

/** `/` redirects to `/challenge`, a Cloudflare challenge; the sitemap lists `/` again. */
const redirectSite = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(null, {
        status: 302,
        headers: { location: "/challenge" },
      });
    }
    if (url.pathname === "/challenge") {
      return new Response(
        "<html><title>Just a moment...</title><body>wait</body></html>",
        {
          status: 403,
          headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        }
      );
    }
    if (url.pathname === "/robots.txt") {
      return new Response(`Sitemap: ${url.origin}/sitemap.xml`, {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/sitemap.xml") {
      return new Response(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url.origin}/</loc></url></urlset>`,
        { headers: { "content-type": "application/xml" } }
      );
    }
    return new Response("nf", { status: 404 });
  },
});

/** A normal home page linking to a 406 and a 403 whose bodies read like a refusal behind Cloudflare. */
const suspectSite = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Home</title><meta name="description" content="Home page"></head><body><h1>Hi</h1><a href="/denied">denied</a> <a href="/forbidden">forbidden</a></body></html>`,
        { headers: { "content-type": "text/html" } }
      );
    }
    if (pathname === "/denied") {
      return new Response(
        "<html><head><title>Denied</title></head><body><h1>Access Denied</h1></body></html>",
        {
          status: 406,
          headers: {
            "content-type": "text/html",
            server: "cloudflare",
            "cf-ray": "8abc123def-AMS",
          },
        }
      );
    }
    if (pathname === "/forbidden") {
      return new Response(
        "<html><head><title>Forbidden</title></head><body><h1>Access Denied</h1></body></html>",
        {
          status: 403,
          headers: {
            "content-type": "text/html",
            server: "cloudflare",
            "cf-ray": "8abc123def-FRA",
          },
        }
      );
    }
    return new Response("nf", { status: 404 });
  },
});

afterAll(() => {
  void redirectSite.stop(true);
  void suspectSite.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

let homes = 0;
async function audit(port: number | undefined, ...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      `http://127.0.0.1:${port}/`,
      "--offline",
      "--http",
      "-m",
      "5",
      ...args,
    ],
    {
      env: {
        ...env,
        HOME: join(scratch, `home-${++homes}`),
        SQUIRREL_NO_UPDATE: "1",
        NO_TELEMETRY: "1",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

interface Blocked {
  total: number;
  seed?: { url: string };
  pages: Array<{ url: string }>;
}

describe("a seed that redirects to a challenge", () => {
  test("is one blocked page: counted once, the typed URL not listed beside the destination", async () => {
    const r = await audit(redirectSite.port, "-f", "json");
    expect(r.code).toBe(3);
    const report = JSON.parse(r.out) as { status: string; wafBlocked: Blocked };
    expect(report.status).toBe("blocked");
    expect(report.wafBlocked.seed?.url).toBe(
      `http://127.0.0.1:${redirectSite.port}/challenge`
    );
    expect(report.wafBlocked.total).toBe(1);
    expect(report.wafBlocked.pages).toEqual([]);
  }, 120_000);
});

describe("a refusal-shaped page with no provider marker", () => {
  test("is audited, listed under wafSuspect in JSON, and the audit completes", async () => {
    const r = await audit(suspectSite.port, "-f", "json");
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as {
      status: string;
      meta: { totalPages: number };
      wafSuspect?: {
        total: number;
        providers: string[];
        pages: Array<{
          url: string;
          status: number;
          providerId: string;
          signal: string;
        }>;
      };
      wafBlocked?: unknown;
    };
    expect(report.status).toBe("completed");
    // The home page and the 406 page are stored; the bare 403 fails its fetch as it always did.
    expect(report.meta.totalPages).toBe(2);
    expect(report.wafBlocked).toBeUndefined();
    expect(report.wafSuspect?.total).toBe(2);
    expect(report.wafSuspect?.providers).toEqual(["Cloudflare"]);
    const byPath = new Map(
      (report.wafSuspect?.pages ?? []).map((page) => [
        new URL(page.url).pathname,
        page,
      ])
    );
    expect(byPath.get("/denied")).toMatchObject({
      status: 406,
      providerId: "cloudflare",
    });
    expect(byPath.get("/forbidden")).toMatchObject({
      status: 403,
      providerId: "cloudflare",
    });
  }, 120_000);

  test("the console report warns", async () => {
    const r = await audit(suspectSite.port);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "Warning: 2 pages look like a refusal from Cloudflare but carry no block marker"
    );
    expect(r.out).toContain("/denied: Cloudflare, HTTP 406");
    expect(r.out).toContain("/forbidden: Cloudflare, HTTP 403");
  }, 120_000);
});
