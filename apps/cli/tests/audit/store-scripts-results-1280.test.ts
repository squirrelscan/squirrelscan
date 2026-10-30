// #1280: `store_scripts` is a storage option, so it must not change what the
// audit finds. A run that stores scripts fetches more of them (up to 200), but
// the script rules evaluate the same set they do with it off. One page, 120
// scripts, three of them past the audit's own share (10) and over the js-file-size
// warning size: only a run that fed the rules every script would flag them. The run also
// keeps the rules' view when `store_scripts_max_scripts` is below the audit's own
// share, and fetches the same preloaded chunks.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");
const COUNT = 120; // more than the 50 an audit would ever fetch for its own checks
const CHUNKS = 30; // preloaded chunks, which a page with a CSP also has fetched
const LARGE = new Set([14, 18, 22, 90]); // past the first 10, over 250 KB
const scriptPath = (i: number) => `/assets/s${String(i).padStart(2, "0")}.js`;
const body = (i: number) =>
  LARGE.has(i)
    ? `var n${i}=1;${"/*pad*/".repeat(45_000)}`
    : `var n${i}=1;${"/*pad*/".repeat(20)}`;

let server: ReturnType<typeof Bun.serve>;
let base: string;
let out: string;
let chunkHits = 0;

beforeAll(() => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Many scripts fixture page</title><meta name="description" content="A fixture page with many scripts.">${Array.from({ length: CHUNKS }, (_, i) => `<link rel="modulepreload" href="/chunks/c${i}.js">`).join("")}</head><body><main><h1>Many scripts</h1><p>Body copy.</p></main>${Array.from({ length: COUNT }, (_, i) => `<script src="${scriptPath(i)}"></script>`).join("")}</body></html>`;
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/robots.txt")
        return new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain" },
        });
      if (pathname === "/")
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'self'",
          },
        });
      if (pathname.startsWith("/chunks/")) {
        chunkHits++;
        return new Response(`var chunk="${pathname}";`, {
          headers: { "content-type": "application/javascript" },
        });
      }
      const match = /^\/assets\/s(\d+)\.js$/.exec(pathname);
      if (match) {
        return new Response(body(Number(match[1])), {
          headers: { "content-type": "application/javascript" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  out = mkdtempSync(join(tmpdir(), "sq-1280-"));
});

afterAll(() => {
  server?.stop(true);
  rmSync(out, { recursive: true, force: true });
});

interface Report {
  score?: unknown;
  summary?: unknown;
  issues: unknown[];
  meta: { scriptsEvaluated?: number };
}

async function audit(
  name: string,
  flags: string[],
  toml?: string
): Promise<{ report: Report; storedScripts: number; chunks: number }> {
  chunkHits = 0;
  const home = join(out, `${name}-home`);
  const cwd = join(out, `${name}-cwd`);
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const file = join(out, `${name}.json`);
  if (toml) writeFileSync(join(cwd, "squirrel.toml"), toml);
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      CLI,
      "audit",
      base,
      "-m",
      "1",
      "--offline",
      "--http",
      "--refresh",
      "-y",
      "-f",
      "json",
      "-o",
      file,
      ...flags,
    ],
    {
      cwd,
      env: { ...process.env, HOME: home, NO_COLOR: "1", NO_TELEMETRY: "1" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`audit exited ${code}\n${stderr}`);
  let storedScripts = 0;
  const dbs = (function find(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? find(join(dir, e.name))
        : e.name.endsWith(".db")
          ? [join(dir, e.name)]
          : []
    );
  })(home).filter(
    (p) => !p.endsWith("content-store.db") && !p.endsWith("link-cache.db")
  );
  for (const path of dbs) {
    const db = new Database(path, { readonly: true });
    try {
      storedScripts += (
        db
          .query(
            "SELECT count(*) AS n FROM crawl_scripts WHERE status = 'stored'"
          )
          .get() as { n: number }
      ).n;
    } finally {
      db.close();
    }
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Report;
  return { report: parsed, storedScripts, chunks: chunkHits };
}

describe("#1280 store_scripts is storage only", () => {
  test("findings, score and the script count are identical with and without it, and every script is stored", async () => {
    const off = await audit("off", []);
    const on = await audit("on", ["--store-scripts"]);

    // The rules saw the same first-party scripts: the audit's own share.
    expect(off.report.meta.scriptsEvaluated).toBe(10);
    expect(on.report.meta.scriptsEvaluated).toBe(10);
    // None of the large scripts is in that share, so none is flagged.
    expect(JSON.stringify(on.report.issues)).not.toContain("s14.js");
    expect(JSON.stringify(on.report.issues)).not.toContain("s90.js");
    expect(JSON.stringify(on.report.issues)).toBe(
      JSON.stringify(off.report.issues)
    );
    expect(on.report.score).toEqual(off.report.score);
    expect(on.report.summary).toEqual(off.report.summary);

    // The extra scripts are still fetched and kept.
    expect(off.storedScripts).toBe(0);
    // (the preloaded chunks the audit fetches are kept too)
    expect(on.storedScripts).toBe(COUNT + on.chunks);
    // Preloaded chunks are fetched exactly as an audit that does not store.
    expect(on.chunks).toBe(off.chunks);
    expect(off.chunks).toBeGreaterThan(0);
  }, 180_000);

  test("a store_scripts_max_scripts below the audit's own share changes nothing the rules see", async () => {
    const off = await audit("off-5", []);
    const on = await audit(
      "on-5",
      ["--store-scripts"],
      "[storage]\nstore_scripts_max_scripts = 5\n"
    );

    expect(on.report.meta.scriptsEvaluated).toBe(10);
    expect(JSON.stringify(on.report.issues)).toBe(
      JSON.stringify(off.report.issues)
    );
    expect(on.report.score).toEqual(off.report.score);
    // Storing still honours its own limit, but never fewer than the rules read.
    expect(on.storedScripts).toBe(10 + on.chunks);
  }, 180_000);
});
