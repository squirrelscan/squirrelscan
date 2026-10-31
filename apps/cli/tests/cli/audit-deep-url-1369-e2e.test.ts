// A deep start URL is disclosed, retained in JSON and fetched inside a small
// page budget even when the sitemap already offers enough other pages (#1369).

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-deep-url-"));

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname, origin, searchParams } = new URL(req.url);
    if (pathname === "/deep-to-root") {
      return new Response(null, { status: 302, headers: { location: "/" } });
    }
    if (pathname === "/" && searchParams.has("to-deep")) {
      return new Response(null, {
        status: 302,
        headers: { location: "/requested" },
      });
    }
    if (pathname === "/robots.txt") {
      return new Response(
        `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`
      );
    }
    if (pathname === "/sitemap.xml") {
      // The requested page is last: if sitemap insertion wins frontier dedup,
      // this seven-page list can push it past the five-page budget.
      const urls = [
        "/",
        "/one",
        "/two",
        "/three",
        "/four",
        "/five",
        "/requested",
      ];
      return new Response(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
          .map((path) => `<url><loc>${origin}${path}</loc></url>`)
          .join("")}</urlset>`,
        { headers: { "content-type": "application/xml" } }
      );
    }
    if (
      ["/", "/requested", "/one", "/two", "/three", "/four", "/five"].includes(
        pathname
      )
    ) {
      return new Response(
        `<!doctype html><html lang="en"><head><title>${pathname}</title></head><body><h1>${pathname}</h1></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

let homes = 0;
async function audit(path: string, maxPages: number) {
  const home = join(scratch, `home-${++homes}`);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !/^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(key)
    )
  ) as Record<string, string>;
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      `${site.url.origin}${path}`,
      "--offline",
      "--disable-discovery-probes",
      "--include-pages",
      "-m",
      String(maxPages),
      "-f",
      "json",
    ],
    {
      env: {
        ...env,
        HOME: home,
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
  return { out, err, code, home };
}

describe("deep audit start URL", () => {
  test("names the site-wide scope, records the request and includes that page", async () => {
    const result = await audit("/requested", 5);
    expect(result.code).toBe(0);
    expect(result.err).toContain(
      `Notice: requested ${site.url.origin}/requested; auditing the whole site at ${site.url.origin}.`
    );
    const report = JSON.parse(result.out) as {
      meta: { baseUrl: string; requestedUrl?: string };
      pages: Array<{ url: string }>;
    };
    expect(report.meta.baseUrl).toBe(site.url.origin);
    expect(report.meta.requestedUrl).toBe(`${site.url.origin}/requested`);
    expect(report.pages.map((page) => page.url)).toContain(
      `${site.url.origin}/requested`
    );
  }, 90_000);

  test("an origin-only start has no notice or requestedUrl", async () => {
    const result = await audit("/", 1);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("Notice: requested");
    const report = JSON.parse(result.out) as {
      meta: { requestedUrl?: string };
    };
    expect(report.meta.requestedUrl).toBeUndefined();
  }, 90_000);

  test("an origin-only start lets sitemap insertion win seed dedup", async () => {
    const result = await audit("/?origin-order=1", 1);
    expect(result.code).toBe(0);
    const dbPath = Array.from(
      new Bun.Glob(".squirrel/projects/*/project.db").scanSync({
        cwd: result.home,
        absolute: true,
      })
    )[0];
    expect(dbPath).toBeDefined();
    const db = new Database(dbPath!, { readonly: true });
    try {
      const entry = db
        .query("SELECT source FROM frontier WHERE normalized_url = ?")
        .get(`${site.url.origin}/`) as { source: string } | null;
      // The sitemap root is inserted before the query-bearing seed. It keeps
      // ownership when the seed is added later, exercising `!prioritizeSeed`.
      expect(entry?.source).toBe("sitemap");
    } finally {
      db.close();
    }
  }, 90_000);

  test("a deep redirect reports the request and prioritizes its root destination", async () => {
    const result = await audit("/deep-to-root?ref=campaign", 1);
    expect(result.code).toBe(0);
    expect(result.err).toContain(
      `Notice: requested ${site.url.origin}/deep-to-root; auditing the whole site at ${site.url.origin}.`
    );
    const report = JSON.parse(result.out) as {
      meta: { requestedUrl?: string };
      pages: Array<{ url: string }>;
    };
    expect(report.meta.requestedUrl).toBe(`${site.url.origin}/deep-to-root`);
    expect(report.pages.map((page) => page.url)).toContain(
      `${site.url.origin}/`
    );
  }, 90_000);

  test("a root redirect to a deep page retains root-start reporting", async () => {
    const result = await audit("/?to-deep=1", 1);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("Notice: requested");
    const report = JSON.parse(result.out) as {
      meta: { requestedUrl?: string };
      pages: Array<{ url: string }>;
    };
    expect(report.meta.requestedUrl).toBeUndefined();
    // Root-start order (#1405): the sitemap's first entry, the root, is crawled in a one-page
    // budget, not the page it redirects to. A deep typed start is covered by the tests above.
    expect(report.pages.map((page) => page.url)).toEqual([
      `${site.url.origin}/`,
    ]);
  }, 90_000);
});
