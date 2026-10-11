// repo#2342 end to end: `squirrel audit` against a site whose pages outgrow the
// content store's cap, through citty's real parser, the real crawler and a real
// content store, with the site served by a stubbed fetch (no network).
//
// - A crawl whose bytes exceed the cap still has every page in the store at the
//   end of the run; the control without the run's retention lease does not.
// - `squirrel report` over an audit whose bodies were evicted afterwards says so.
// - A re-audit fetches evicted pages again instead of reusing a body-less entry
//   on a 304, and says how many.
// - A small audit under the default cap produces the same report with or without
//   the lease (the parity check for the default behaviour).
//
// Paths are redirected through the paths module, like the other wiring tests,
// because homedir() is fixed at process start in Bun. No `mock.module`.

import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { runCommand } from "citty";
import { Effect } from "effect";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { audit } from "@/cli/commands/audit";
import { report } from "@/cli/commands/report";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import {
  ContentStore,
  closeGlobalContentStore,
} from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { logger } from "@/utils/logger";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

// Each test runs one or two real audits.
setDefaultTimeout(60_000);

// #626: every squirrel path under one scratch dir; each test takes its own home.
const squirrelHome = isolateSquirrelHome("squirrel-store-cap");
const scratch = squirrelHome.dir;
const restores: (() => void)[] = [];
let home = squirrelHome.root;

const SITE = "https://cap.example.com";
const PAGES = 12;
const CAP = 32 * 1024;

beforeAll(() => {
  closeGlobalContentStore();
  closeGlobalLinkCache();
  const previousConfig = getGlobalConfigPath();
  restores.push(() => setGlobalConfigPath(previousConfig));
});

afterAll(() => {
  closeGlobalContentStore();
  closeGlobalLinkCache();
  for (const restore of restores) restore();
});

/** Deterministic, poorly compressible text, so both arms see identical bytes. */
function noise(seed: number, bytes: number): string {
  let a = seed + 1;
  let out = "";
  while (out.length < bytes) {
    a = (a * 1103515245 + 12345) % 4_294_967_296;
    out += a.toString(36);
  }
  return out.slice(0, bytes);
}

/** Page 0 is the home page "/"; pages 1..PAGES-1 live at /p/<i>. */
const pagePath = (i: number) => (i === 0 ? "/" : `/p/${i}`);

function pageHtml(i: number): string {
  const links = Array.from(
    { length: PAGES },
    (_, k) => `<a href="${pagePath(k)}">Page ${k}</a>`
  ).join("");
  return `<html><head><title>Page ${i}</title><meta name="description" content="Page ${i} of the cap test"></head><body><h1>Page ${i}</h1><nav>${links}</nav><p>${noise(i, 12_000)}</p></body></html>`;
}

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalEnv = { ...process.env };
let requests: Array<{ path: string; conditional: boolean; status: number }> =
  [];
let notices: string[] = [];
let restoreOutput: () => void = () => {};

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function withHome(name: string, config: string): void {
  home = squirrelHome.use(name);
  const configPath = join(scratch, `${name}.toml`);
  writeFileSync(configPath, `[cloud]\npublish = false\n${config}`);
  setGlobalConfigPath(configPath);
}

beforeEach(() => {
  requests = [];
  notices = [];
  process.exitCode = 0;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  delete process.env.SQUIRREL_CONTENT_STORE_MAX_BYTES;
  // An earlier test file in the same process (createTestStorage) can leave
  // this set, and it beats the spied path: the audit would then write to that
  // store and this file would census an empty one.
  delete process.env.SQUIRREL_CONTENT_STORE_PATH;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  const quiet = () => {};
  const log = spyOn(console, "log").mockImplementation(quiet);
  const error = spyOn(console, "error").mockImplementation(quiet);
  const warnConsole = spyOn(console, "warn").mockImplementation(quiet);
  const warn = spyOn(logger, "warn").mockImplementation(
    (...args: unknown[]) => {
      notices.push(args.map(String).join(" "));
    }
  );
  restoreOutput = () => {
    log.mockRestore();
    error.mockRestore();
    warnConsole.mockRestore();
    warn.mockRestore();
  };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = input.toString();
    if (url.includes("/v1/credits")) {
      return Response.json({
        balance: { total: 5000, monthly: 5000, pack: 0, periodEnd: null },
        plan: { id: "pro", monthlyCredits: 5000 },
        branding: null,
      });
    }
    if (url.includes("/v1/agent-runs"))
      return Response.json({ runId: "RUN1" }, { status: 201 });
    if (url.includes("/v1/")) return Response.json({});

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    const conditional = headers.has("if-none-match");
    const path = new URL(url).pathname;
    const record = (status: number) =>
      requests.push({ path, conditional, status });
    if (path === "/sitemap.xml") {
      const locs = Array.from(
        { length: PAGES },
        (_, i) => `<url><loc>${SITE}${pagePath(i)}</loc></url>`
      ).join("");
      return new Response(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`,
        {
          headers: { "Content-Type": "application/xml" },
        }
      );
    }
    const i = Array.from({ length: PAGES }, (_, k) => k).find(
      (k) => pagePath(k) === path
    );
    if (i === undefined) return new Response("not found", { status: 404 });
    const etag = `"page-${i}-v1"`;
    if (headers.get("if-none-match") === etag) {
      record(304);
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    record(200);
    return new Response(pageHtml(i), {
      headers: {
        "Content-Type": "text/html",
        ETag: etag,
        "Cache-Control": "no-cache",
      },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  restoreOutput();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  process.exitCode = originalExitCode ?? 0;
  process.env = { ...originalEnv };
  closeGlobalContentStore();
  closeGlobalLinkCache();
});

async function runCli(command: typeof audit, rawArgs: string[]): Promise<void> {
  try {
    await runCommand(command, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

const auditSite = (...extra: string[]) =>
  runCli(audit, [
    `${SITE}/`,
    "-m",
    String(PAGES),
    "-C",
    "quick",
    "-y",
    "--no-publish",
    "-n",
    "cap-test",
    ...extra,
  ]);

const run = <A>(eff: Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);

/** The newest crawl of the project, and how many of its bodies the store still holds. */
async function latestCrawlBodies(): Promise<{
  crawlId: string;
  evicted: number;
  stored: number;
}> {
  closeGlobalContentStore();
  const content = new ContentStore(join(home, "content-store.db"));
  const storage = new SQLiteStorage(
    join(home, "projects", "cap-test", "project.db"),
    content
  );
  try {
    await run(storage.init());
    const crawls = await run(storage.listCrawls());
    const latest = crawls.sort((a, b) => b.startedAt - a.startedAt)[0]!;
    return {
      crawlId: latest.id,
      ...(await run(storage.countEvictedPageBodies(latest.id))),
    };
  } finally {
    await run(storage.close());
    content.close();
  }
}

function storeState(): { totalBytes: number; leases: number } {
  const db = new Database(join(home, "content-store.db"));
  try {
    const { total } = db
      .prepare("SELECT COALESCE(SUM(compressed_size), 0) AS total FROM content")
      .get() as {
      total: number;
    };
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM retention_leases")
      .get() as { n: number };
    return { totalBytes: total, leases: n };
  } finally {
    db.close();
  }
}

/**
 * What a later audit's prune does to this one: drop the bodies of some pages,
 * leaving their page rows pointing at them. Done directly rather than through a
 * prune so the test knows exactly WHICH pages went (a prune takes the oldest).
 */
async function evictBodies(paths: string[]): Promise<void> {
  const project = new Database(
    join(home, "projects", "cap-test", "project.db")
  );
  const { crawlId } = await latestCrawlBodies();
  const hashes = paths.map(
    (path) =>
      (
        project
          .prepare(
            "SELECT content_hash FROM pages WHERE crawl_id = ? AND normalized_url = ?"
          )
          .get(crawlId, `${SITE}${path}`) as { content_hash: string }
      ).content_hash
  );
  project.close();
  const store = new Database(join(home, "content-store.db"));
  for (const hash of hashes)
    store.prepare("DELETE FROM content WHERE hash = ?").run(hash);
  store.close();
}

const EVICTED = [2, 5, 7, 9].map(pagePath);

describe("squirrel audit under a content-store cap smaller than the crawl (#2342)", () => {
  test("every crawled page is still in the store at the end of the run", async () => {
    withHome("kept", `[storage]\ncontent_store_max_bytes = ${CAP}\n`);
    await auditSite();
    expect(process.exitCode).not.toBe(1);

    const { evicted, stored } = await latestCrawlBodies();
    expect(stored).toBe(PAGES);
    expect(evicted).toBe(0);
    const state = storeState();
    // The crawl really did outgrow the cap, and the lease was released.
    expect(state.totalBytes).toBeGreaterThan(CAP);
    expect(state.leases).toBe(0);
  });

  test("the control: without the run's lease the same audit evicts its own pages", async () => {
    withHome("control", `[storage]\ncontent_store_max_bytes = ${CAP}\n`);
    const noLease = spyOn(
      ContentStore.prototype,
      "beginRetention"
    ).mockImplementation(() => () => {});
    try {
      await auditSite();
    } finally {
      noLease.mockRestore();
    }
    const { evicted, stored } = await latestCrawlBodies();
    expect(stored).toBe(PAGES);
    expect(evicted).toBeGreaterThan(0);
  });

  test("squirrel report says how many of the audit's pages were evicted since", async () => {
    withHome("report", `[storage]\ncontent_store_max_bytes = ${CAP}\n`);
    await auditSite();
    await evictBodies(EVICTED);
    const { evicted } = await latestCrawlBodies();
    expect(evicted).toBe(EVICTED.length);

    notices = [];
    await runCli(report as typeof audit, [
      "--format",
      "json",
      "--output",
      join(home, "report.json"),
    ]);
    const line = notices.find((n) => n.startsWith("Content store:"));
    expect(line).toBe(
      `Content store: ${evicted} of ${PAGES} pages stored for this audit are no longer in the local content store, most likely evicted by its size cap (now 32.0 KB). Findings are unaffected; anything rebuilt from page HTML is missing for them. Raise [storage] content_store_max_bytes or SQUIRREL_CONTENT_STORE_MAX_BYTES to keep more.`
    );
  });

  test("a re-audit fetches evicted pages again instead of reusing them on a 304", async () => {
    // A cap that holds the whole site, so only the deliberate eviction counts.
    withHome("reaudit", "");
    await auditSite();
    await evictBodies(EVICTED);

    requests = [];
    notices = [];
    await auditSite();
    // Every evicted page was fetched in full with no validator, and none was
    // answered "unchanged" (a 304 here is the bug: a page with no HTML).
    for (const path of EVICTED) {
      const seen = requests.filter((r) => r.path === path);
      expect(seen.some((r) => !r.conditional && r.status === 200)).toBe(true);
      expect(seen.some((r) => r.status === 304)).toBe(false);
    }
    // The control inside the same run: pages whose body survived were
    // revalidated and reused.
    const kept = Array.from({ length: PAGES }, (_, i) => pagePath(i)).filter(
      (path) => !EVICTED.includes(path) && path !== "/"
    );
    for (const path of kept) {
      expect(requests.some((r) => r.path === path && r.status === 304)).toBe(
        true
      );
    }
    expect(notices).toContain(
      `Content store: ${EVICTED.length} pages cached from an earlier audit were no longer in the local content store, most likely evicted by its size cap (now 1.0 GB), so they were requested again in full instead of revalidated. Raise [storage] content_store_max_bytes or SQUIRREL_CONTENT_STORE_MAX_BYTES to keep more.`
    );
    // And the re-audit read every page back.
    expect((await latestCrawlBodies()).evicted).toBe(0);
  });
});

describe("squirrel audit under the default cap (#2342 parity)", () => {
  test("a small audit reports the same with or without the lease, and evicts nothing", async () => {
    const reportOf = async (name: string) => {
      withHome(name, "");
      await auditSite(
        "--format",
        "json",
        "--output",
        join(scratch, `${name}.json`)
      );
      const json = JSON.parse(
        await Bun.file(join(scratch, `${name}.json`)).text()
      );
      return { score: json.score, summary: json.summary, issues: json.issues };
    };

    const withLease = await reportOf("parity-lease");
    expect(storeState().leases).toBe(0);
    expect((await latestCrawlBodies()).evicted).toBe(0);
    const store = new ContentStore(join(home, "content-store.db"));
    expect(store.getLastEviction()).toBeNull();
    store.close();

    const noLease = spyOn(
      ContentStore.prototype,
      "beginRetention"
    ).mockImplementation(() => () => {});
    let without;
    try {
      without = await reportOf("parity-nolease");
    } finally {
      noLease.mockRestore();
    }
    expect(withLease.issues.length).toBeGreaterThan(0);
    expect(withLease).toEqual(without);
  });
});
