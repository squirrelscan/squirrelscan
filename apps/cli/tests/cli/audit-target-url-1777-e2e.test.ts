// `squirrel audit --target-url` (#1777) through the real CLI against a local 20 page site that records every
// request: exactly the 3 listed pages are fetched (plus robots.txt), the other 17 get no finding, whole-site
// rules report not checked with the reason, and the JSON report accounts for every URL given.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-target-url-"));
const hits: string[] = [];

const links = Array.from(
  { length: 20 },
  (_, i) => `<a href="/p/${i}">p${i}</a>`
).join(" ");
const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    hits.push(`${req.method} ${pathname}`);
    if (pathname.startsWith("/p/") || pathname === "/") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Page ${pathname}</title></head><body><h1>Hello</h1>${links}</body></html>`,
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

function env(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    out[k] = v;
  }
  return {
    ...out,
    HOME: home,
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
  };
}

async function squirrel(home: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], {
    env: env(home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

const base = () => `http://127.0.0.1:${site.port}/`;

interface Json {
  meta: {
    targeted?: {
      requested: number;
      audited: number;
      unaudited: Array<{ url: string; reason: string }>;
    };
  };
  pages?: Array<{ url: string; status: number; reason?: string }>;
  pagesTotal?: number;
}

describe("--target-url", () => {
  test("fetches exactly the listed pages and accounts for every URL given", async () => {
    hits.length = 0;
    const r = await squirrel(
      join(scratch, "home"),
      "audit",
      base(),
      "--offline",
      "--http",
      "-f",
      "json",
      "--include-pages",
      "--target-url",
      "/p/1",
      "--target-url",
      `${base()}p/2`,
      "--target-url",
      "/p/3",
      "--target-url",
      "https://elsewhere.example.org/x"
    );
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out) as Json;

    // The site saw the three pages and robots.txt: no start URL, no sitemap, no probe, no link followed, and
    // no status check of the links on the pages (the link rules are site-wide and skip).
    expect([...new Set(hits)].sort()).toEqual([
      "GET /p/1",
      "GET /p/2",
      "GET /p/3",
      "GET /robots.txt",
    ]);
    expect(hits.some((h) => /sitemap|llms|well-known/.test(h))).toBe(false);

    // The pages list also names the refused URL (status 0, with its reason); the audited pages are the three.
    const rows = json.pages ?? [];
    expect(
      rows
        .filter((p) => p.status > 0)
        .map((p) => new URL(p.url).pathname)
        .sort()
    ).toEqual(["/p/1", "/p/2", "/p/3"]);
    expect(rows.find((p) => p.status === 0)?.url).toContain(
      "elsewhere.example.org"
    );
    // Every URL given is accounted for: the off-site one is listed with a reason, not dropped.
    expect(json.meta.targeted?.requested).toBe(4);
    expect(json.meta.targeted?.audited).toBe(3);
    expect(json.meta.targeted?.unaudited).toHaveLength(1);
    expect(json.meta.targeted?.unaudited[0]?.url).toContain(
      "elsewhere.example.org"
    );
  });

  test("an ordinary audit of the same site has no meta.targeted", async () => {
    const r = await squirrel(
      join(scratch, "home2"),
      "audit",
      base(),
      "--offline",
      "--http",
      "-m",
      "3",
      "-f",
      "json"
    );
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as Json).meta).not.toHaveProperty("targeted");
  });
});
