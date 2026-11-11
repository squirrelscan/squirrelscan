// #1762 end to end: a redirect to a destination the crawl will not visit (an excluded path) stays a page. The
// crawler marks the row, the report lists it (`reconstructReport` reads the stored crawl), and a redirect to a
// crawled destination is still a `redirects` row, not a page.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-redirect-kept-"));

const PAGE = (title: string, body = "") =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="A page"></head><body><h1>${title}</h1>${body}</body></html>`;

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    const html = (body: string) =>
      new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (pathname === "/")
      return html(
        PAGE(
          "Home",
          `<a href="/docs/">Docs</a> <a href="/old">Old</a> <a href="/about">About</a>`
        )
      );
    if (pathname === "/docs/")
      return new Response(null, {
        status: 301,
        headers: { location: "/documentation/" },
      });
    if (pathname === "/documentation/") return html(PAGE("Documentation"));
    if (pathname === "/old")
      return new Response(null, {
        status: 301,
        headers: { location: "/about" },
      });
    if (pathname === "/about") return html(PAGE("About"));
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

interface Json {
  pages?: Array<{ url: string; status: number; ruleCount?: number }>;
  pagesTotal?: number;
  redirects?: Array<{ url: string }>;
  summary?: { pagesAudited?: number };
  totalPages?: number;
}

async function audit(): Promise<Json> {
  const dir = mkdtempSync(join(scratch, "run-"));
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(
    join(dir, "squirrel.toml"),
    '[crawler]\nexclude = ["/documentation"]\n'
  );
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
      `http://127.0.0.1:${site.port}/`,
      "--offline",
      "--http",
      "-m",
      "10",
      "-f",
      "json",
      "--include-pages",
    ],
    {
      cwd: dir,
      env: {
        ...env,
        HOME: join(dir, "home"),
        SQUIRREL_NO_UPDATE: "1",
        NO_TELEMETRY: "1",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  return JSON.parse(out) as Json;
}

describe("a redirect to a destination the crawl will not visit stays a page", () => {
  test("/docs/ is a page of the report, /old is a redirect", async () => {
    const json = await audit();
    const paths = (json.pages ?? []).map((p) => new URL(p.url).pathname);
    expect(paths).toContain("/docs/");
    // Audited as a page, not listed empty: rules reported on its content.
    const docs = (json.pages ?? []).find(
      (p) => new URL(p.url).pathname === "/docs/"
    );
    expect(docs?.ruleCount).toBeGreaterThan(0);
    expect(paths).not.toContain("/old");
    expect((json.redirects ?? []).map((r) => new URL(r.url).pathname)).toEqual([
      "/old",
    ]);
    expect(json.pagesTotal).toBe(json.pages?.length);
  }, 240_000);
});
