// #1255 end to end: `squirrel audit --store-scripts` keeps the first-party
// scripts the crawl fetched in the content store and indexes them by URL, with
// identical bundles stored once and the caps enforced. Without the flag nothing
// is stored. Drives the real CLI against a fixture site, like the other e2e
// audit tests, and reads the files it writes.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  skippedScriptsWarning,
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
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: "1",
        NO_TELEMETRY: "1",
        // Another test file may have set it; the CLI must use this run's HOME.
        SQUIRREL_CONTENT_STORE_PATH: undefined,
      },
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
      "SELECT url, content_hash, size_bytes, status, skip_reason, source_pages, final_url FROM crawl_scripts ORDER BY url"
    )
    .all() as Array<{
    url: string;
    content_hash: string | null;
    size_bytes: number;
    status: string;
    skip_reason: string | null;
    source_pages: string;
    final_url: string | null;
  }>;
  const summary = project
    .query("SELECT fetch_limit, dropped_by_limit FROM crawl_scripts_summary")
    .get() as { fetch_limit: number | null; dropped_by_limit: number } | null;
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
  return { scripts, jsRows, summary };
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

  test("--no-store-scripts turns the config opt-in off for one run (#1268)", async () => {
    const { scripts, jsRows } = await audit(
      "no-flag",
      ["--no-store-scripts"],
      "[storage]\nstore_scripts = true\n"
    );
    expect(scripts).toEqual([]);
    expect(jsRows).toEqual([]);
  }, 120_000);

  test("the content store and the project database are owner-only files (#1268)", async () => {
    await audit("modes", ["--store-scripts"]);
    const dbs = findDbs(join(out, "modes-home")).filter(
      (p) => !p.endsWith("link-cache.db")
    );
    expect(dbs.length).toBeGreaterThanOrEqual(2);
    for (const db of dbs) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = db + suffix;
        if (!existsSync(file)) continue;
        expect(statSync(file).mode & 0o077).toBe(0);
      }
    }
    // The folders squirrel made for them are owner-only too.
    for (const db of dbs.filter((p) => !p.endsWith("content-store.db"))) {
      expect(statSync(dirname(db)).mode & 0o077).toBe(0);
    }
  }, 120_000);

  test("off by default: no index rows and no script in the content store", async () => {
    const { scripts, jsRows } = await audit("off", []);
    expect(scripts).toEqual([]);
    expect(jsRows).toEqual([]);
  }, 120_000);
});

describe("#1255 every referenced script, not the audit's own share", () => {
  let manyServer: ReturnType<typeof Bun.serve>;
  let manyBase: string;
  const COUNT = 25;
  const SPA = "<!doctype html><html><body>app</body></html>";

  beforeAll(() => {
    const scripts = Array.from(
      { length: COUNT },
      (_, i) => `/assets/s${String(i).padStart(2, "0")}.js`
    );
    manyServer = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/robots.txt")
          return new Response("User-agent: *\nAllow: /\n", {
            headers: { "content-type": "text/plain" },
          });
        if (pathname === "/") {
          return new Response(
            page("Many", [...scripts, "/assets/spa.js", "/assets/moved.js"]),
            { headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        if (pathname === "/assets/spa.js")
          return new Response(SPA, {
            headers: { "content-type": "application/javascript" },
          });
        if (pathname === "/assets/moved.js")
          return new Response(null, {
            status: 302,
            headers: { location: "/assets/final.js" },
          });
        if (pathname === "/assets/final.js" || scripts.includes(pathname)) {
          return new Response(`var n="${pathname}";${"/* pad */".repeat(30)}`, {
            headers: { "content-type": "application/javascript" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    manyBase = `http://127.0.0.1:${manyServer.port}`;
  });
  afterAll(() => manyServer?.stop(true));

  async function auditMany(name: string, flags: string[], toml?: string) {
    const prev = base;
    base = manyBase;
    try {
      return await audit(name, flags, toml);
    } finally {
      base = prev;
    }
  }

  test("a one-page audit stores all 25 scripts, skips the SPA fallback, keeps the redirect's final URL", async () => {
    const { scripts, summary } = await auditMany("many", ["--store-scripts"]);
    const stored = scripts.filter((s) => s.status === "stored");
    // the audit's own checks would fetch 10 of these
    expect(stored.filter((s) => /\/s\d\d\.js$/.test(s.url))).toHaveLength(
      COUNT
    );
    expect(scripts.find((s) => s.url.endsWith("/spa.js"))).toMatchObject({
      status: "skipped",
      skip_reason: "not-javascript",
    });
    expect(scripts.find((s) => s.url.endsWith("/moved.js"))?.final_url).toBe(
      `${manyBase}/assets/final.js`
    );
    expect(summary).toMatchObject({ dropped_by_limit: 0 });
  }, 120_000);

  test("store_scripts_max_scripts bounds the fetch and the rest is counted, not lost silently", async () => {
    const { scripts, summary } = await auditMany(
      "many-cap",
      ["--store-scripts"],
      "[storage]\nstore_scripts_max_scripts = 12\n"
    );
    expect(scripts.filter((s) => s.status === "stored")).toHaveLength(12);
    expect(summary).toMatchObject({
      fetch_limit: 12,
      dropped_by_limit: COUNT + 2 - 12,
    });
  }, 120_000);

  test("without store_scripts the audit fetches only its own share", async () => {
    const { scripts } = await auditMany("many-off", []);
    expect(scripts).toEqual([]);
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

describe("#1268 the skipped scripts warning names each reason", () => {
  const limits = { maxBytes: 2097152, totalBytes: 268435456 };

  test("nothing skipped: no warning", () => {
    expect(skippedScriptsWarning({}, limits)).toBeNull();
  });

  test("each reason has its count and the setting or bound that applies", () => {
    const warning = skippedScriptsWarning(
      { "too-large": 3, "total-cap": 2, "memory-cap": 5, "time-budget": 7 },
      limits
    )!;
    expect(warning).toContain("17 script(s) were not stored");
    expect(warning).toContain(
      "3 over 2097152 bytes each (raise [storage] store_scripts_max_bytes)"
    );
    expect(warning).toContain(
      "2 past the 268435456 byte total (raise [storage] store_scripts_total_bytes)"
    );
    expect(warning).toContain("5 not fetched because");
    expect(warning).toContain("a fixed memory bound");
    expect(warning).toContain("7 not fetched after 120 seconds");
    expect(warning).toContain("a fixed time bound");
  });

  test("a memory or time skip never tells you to raise a size setting", () => {
    const warning = skippedScriptsWarning({ "memory-cap": 1 }, limits)!;
    expect(warning).not.toContain("store_scripts_max_bytes");
    expect(warning).not.toContain("store_scripts_total_bytes");
  });
});

describe("#1268 restrictToOwner", () => {
  test("a missing file is created 0600, so it never exists wider, and an existing one is tightened", async () => {
    const { restrictToOwner } = await import("@squirrelscan/crawler/file-mode");
    const { chmodSync, writeFileSync } = await import("node:fs");
    const fresh = join(out, "fresh.db");
    restrictToOwner(fresh);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    const old = join(out, "old.db");
    writeFileSync(old, "");
    chmodSync(old, 0o644);
    restrictToOwner(old);
    expect(statSync(old).mode & 0o777).toBe(0o600);
  });
});
