// `squirrel audit URL -f json | jq` is how agents read an audit, so for every
// machine-readable format stdout must hold the report and nothing else:
// progress ("New crawl: ...", "Found N URLs in sitemap") and logger lines go
// to stderr. A local Bun.serve site stands in for the target, and every run
// gets a scratch HOME, --offline, and no update or telemetry.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-audit-stdout-"));

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname, origin } = new URL(req.url);
    if (pathname === "/robots.txt") {
      return new Response(
        `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`
      );
    }
    if (pathname === "/sitemap.xml") {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/about</loc></url></urlset>`,
        { headers: { "content-type": "application/xml" } }
      );
    }
    if (pathname === "/" || pathname === "/about") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Page ${pathname}</title></head><body><h1>Hello</h1><a href="/about">About</a></body></html>`,
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

/** Nothing inherited that points at the real machine or the real API. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: join(scratch, `home-${++homes}`),
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
  };
}

async function audit(...args: string[]) {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      site.url.origin,
      "--offline",
      "-m",
      "5",
      ...args,
    ],
    { env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

// The first bytes each format's report writes.
const REPORT_START: Record<string, string> = {
  json: "{",
  xml: "<?xml",
  llm: "<?xml",
  markdown: "# squirrelscan",
  text: "squirrelscan v",
};

describe("squirrel audit -f <machine format> keeps stdout to the report", () => {
  test("json parses as a whole, progress goes to stderr", async () => {
    const r = await audit("-f", "json");
    expect(r.code).toBe(0);
    expect(r.out.startsWith("{")).toBe(true);
    const report = JSON.parse(r.out) as { meta: { baseUrl: string } };
    expect(report.meta.baseUrl).toBe(site.url.origin);
    expect(r.err).toContain(`New crawl: ${site.url.origin}`);
    expect(r.err).toContain("Found 2 URLs in sitemap");
  }, 60_000);

  for (const [format, start] of Object.entries(REPORT_START)) {
    test(`${format}: stdout starts with the report`, async () => {
      const r = await audit("-f", format);
      expect(r.code).toBe(0);
      expect(r.out.slice(0, start.length)).toBe(start);
      expect(r.out).not.toContain("New crawl:");
      expect(r.out).not.toContain("URLs in sitemap");
    }, 60_000);
  }

  test("an unknown format exits 1 without running the audit", async () => {
    const r = await audit("-f", "bogus");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("Unknown format: bogus");
    expect(r.err).not.toContain("New crawl:");
  }, 60_000);
});
