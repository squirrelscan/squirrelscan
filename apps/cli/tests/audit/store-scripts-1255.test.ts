// #1255 end to end: `squirrel audit --store-scripts` keeps the first-party
// scripts the crawl fetched in the content store and indexes them by URL, with
// identical bundles stored once and the caps enforced. Without the flag nothing
// is stored. Drives the real CLI against a fixture site, like the other e2e
// audit tests, and reads the files it writes.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  storedScriptLimits,
  scriptsToStore,
} from "../../src/audit/store-scripts";
import { getDefaultConfig } from "../../src/config";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");
const SHARED = `var shared=1;${"/* vendor */".repeat(80)}`;
const OWN = `var own=2;${"/* app */".repeat(80)}`;
const BIG = `var big=3;${"x".repeat(6000)}`;

const page = (title: string, scripts: string[]) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="Fixture page ${title} for stored scripts."></head><body><main><h1>${title}</h1><p>Body copy for ${title}.</p><a href="/">Home</a> <a href="/about">About</a></main>${scripts.map((s) => `<script src="${s}"></script>`).join("")}</body></html>`;
const PAGES: Record<string, string> = {
  "/": page("Home", ["/assets/shared.js", "/assets/own.js", "/assets/big.js"]),
  "/about": page("About", ["/assets/vendor-copy.js"]),
};
const SCRIPTS: Record<string, string> = {
  "/assets/shared.js": SHARED,
  "/assets/vendor-copy.js": SHARED, // same bytes under another URL
  "/assets/own.js": OWN,
  "/assets/big.js": BIG,
};

let server: ReturnType<typeof Bun.serve>;
let base: string;
let out: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/robots.txt")
        return new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain" },
        });
      const js = SCRIPTS[pathname];
      if (js !== undefined)
        return new Response(js, {
          headers: { "content-type": "application/javascript" },
        });
      const html = PAGES[pathname];
      if (!html) return new Response("Not found", { status: 404 });
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  out = mkdtempSync(join(tmpdir(), "sq-1255-"));
});

afterAll(() => {
  server?.stop(true);
  rmSync(out, { recursive: true, force: true });
});

function findDbs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(entry.parentPath ?? dir, entry.name);
    if (entry.isDirectory()) found.push(...findDbs(path));
    else if (entry.name.endsWith(".db")) found.push(path);
  }
  return found;
}

/** One audit in its own HOME and project dir; returns the project index and the content store rows. */
async function audit(name: string, flags: string[], toml?: string) {
  const home = join(out, `${name}-home`);
  const cwd = join(out, `${name}-cwd`);
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (toml) writeFileSync(join(cwd, "squirrel.toml"), toml);
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      CLI,
      "audit",
      base,
      "-m",
      "5",
      "--offline",
      "--http",
      "--refresh",
      "-y",
      "-f",
      "json",
      "-o",
      join(out, `${name}.json`),
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
  const dbs = findDbs(home);
  const contentDb = dbs.find((p) => p.endsWith("content-store.db"));
  const projectDb = dbs.find(
    (p) => !p.endsWith("content-store.db") && !p.endsWith("link-cache.db")
  );
  expect(projectDb).toBeDefined();
  const project = new Database(projectDb!, { readonly: true });
  const scripts = project
    .query(
      "SELECT url, content_hash, size_bytes, status, skip_reason, source_pages FROM crawl_scripts ORDER BY url"
    )
    .all() as Array<{
    url: string;
    content_hash: string | null;
    size_bytes: number;
    status: string;
    skip_reason: string | null;
    source_pages: string;
  }>;
  project.close();
  let jsRows: Array<{ hash: string; content: Buffer }> = [];
  if (contentDb) {
    const store = new Database(contentDb, { readonly: true });
    jsRows = store
      .query(
        "SELECT hash, content FROM content WHERE content_type = 'application/javascript'"
      )
      .all() as typeof jsRows;
    store.close();
  }
  return { scripts, jsRows };
}

describe("#1255 stored scripts", () => {
  test("--store-scripts keeps every fetched script by URL, identical bundles once, oversized skipped with size", async () => {
    const { scripts, jsRows } = await audit(
      "on",
      ["--store-scripts"],
      "[storage]\nstore_scripts_max_bytes = 4096\n"
    );
    const byPath = new Map(scripts.map((s) => [new URL(s.url).pathname, s]));
    expect([...byPath.keys()]).toEqual([
      "/assets/big.js",
      "/assets/own.js",
      "/assets/shared.js",
      "/assets/vendor-copy.js",
    ]);

    const shared = byPath.get("/assets/shared.js")!;
    const copy = byPath.get("/assets/vendor-copy.js")!;
    expect(shared).toMatchObject({
      status: "stored",
      skip_reason: null,
      size_bytes: SHARED.length,
    });
    expect(copy.content_hash).toBe(shared.content_hash);
    expect(byPath.get("/assets/own.js")).toMatchObject({ status: "stored" });
    // linked from the page: the index names the pages that load each script
    expect(JSON.parse(shared.source_pages)).toEqual([`${base}/`]);
    expect(JSON.parse(copy.source_pages)).toEqual([`${base}/about`]);

    // oversized: recorded as skipped with its size, body never stored
    expect(byPath.get("/assets/big.js")).toMatchObject({
      status: "skipped",
      skip_reason: "too-large",
      size_bytes: BIG.length,
      content_hash: null,
    });

    // identical bundles are one content-store row; every stored body is readable by hash
    expect(jsRows).toHaveLength(2);
    const bodies = new Map(
      jsRows.map((r) => [r.hash, gunzipSync(r.content).toString()])
    );
    expect(bodies.get(shared.content_hash!)).toBe(SHARED);
    expect(bodies.get(byPath.get("/assets/own.js")!.content_hash!)).toBe(OWN);
  }, 120_000);

  test("the total cap is enforced", async () => {
    const { scripts } = await audit(
      "cap",
      ["--store-scripts"],
      "[storage]\nstore_scripts_max_bytes = 4096\nstore_scripts_total_bytes = 1000\n"
    );
    const stored = scripts.filter((s) => s.status === "stored");
    const capped = scripts.filter((s) => s.skip_reason === "total-cap");
    expect(stored.length).toBeGreaterThan(0);
    expect(capped.length).toBeGreaterThan(0);
    // bodies of the distinct stored scripts fit the total
    const distinct = new Map(stored.map((s) => [s.content_hash, s.size_bytes]));
    expect(
      [...distinct.values()].reduce((a, b) => a + b, 0)
    ).toBeLessThanOrEqual(1000);
  }, 120_000);

  test("[storage] store_scripts = true works without the flag", async () => {
    const { scripts } = await audit(
      "config",
      [],
      "[storage]\nstore_scripts = true\n"
    );
    expect(scripts.some((s) => s.status === "stored")).toBe(true);
  }, 120_000);

  test("off by default: no index rows and no script in the content store", async () => {
    const { scripts, jsRows } = await audit("off", []);
    expect(scripts).toEqual([]);
    expect(jsRows).toEqual([]);
  }, 120_000);
});

describe("limits", () => {
  test("defaults: 2 MB per file, a quarter of the content store cap in total", () => {
    const config = getDefaultConfig();
    expect(storedScriptLimits(config, 1_000_000)).toEqual({
      maxBytes: 2 * 1024 * 1024,
      totalBytes: 250_000,
    });
  });

  test("config overrides both", () => {
    const config = getDefaultConfig();
    config.storage.store_scripts_max_bytes = 10;
    config.storage.store_scripts_total_bytes = 20;
    expect(storedScriptLimits(config, 1_000_000)).toEqual({
      maxBytes: 10,
      totalBytes: 20,
    });
  });

  test("scripts to store: one entry per URL, preloaded chunks included", () => {
    const entry = (url: string) => ({
      url,
      status: 200,
      error: null,
      contentType: null,
      sizeBytes: 1,
      content: "x",
      sourcePages: ["p"],
    });
    expect(
      scriptsToStore({
        scripts: [entry("a"), entry("b")],
        preloadedScripts: [entry("b"), entry("c")],
      }).map((s) => s.url)
    ).toEqual(["a", "b", "c"]);
  });
});
