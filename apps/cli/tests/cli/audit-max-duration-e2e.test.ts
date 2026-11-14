// `squirrel audit --max-duration` (#1271), end to end: the real CLI in a
// subprocess against a local site that is slow on every page and never answers
// one of them. The budget must cut the crawl, keep what was fetched and write a
// `partial` report with reason code `max_duration`, inside the documented margin
// (max(10% of the budget, 15 s)). Every run gets a scratch HOME, --offline, no
// update or telemetry, and no stdin.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-max-duration-"));

const PAGE_DELAY_MS = 700;
const hung: Array<() => void> = [];

// Budgets (seconds) for the runs that wait one out. Small on purpose: every assertion is against the
// configured budget, never an absolute time, and 3 s still leaves the slow crawl several page
// rounds (PAGE_DELAY_MS) before the cut.
const BUDGET_S = 3;
const DISCOVERY_BUDGET_S = 5;

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    // Discovery probes (robots.txt, sitemaps, llms.txt, ...) answer at once; only pages are slow.
    if (
      pathname !== "/" &&
      !pathname.startsWith("/p/") &&
      pathname !== "/hang"
    ) {
      return new Response("not found", { status: 404 });
    }
    // A page that never answers: in flight when the budget runs out.
    if (pathname === "/hang") {
      return new Promise<Response>((resolve) => {
        hung.push(() => resolve(new Response("late", { status: 200 })));
      });
    }
    // The start page answers at once (the CLI probes it several times before the crawl);
    // every page below it is slow.
    if (pathname !== "/") await Bun.sleep(PAGE_DELAY_MS);
    const n = pathname.startsWith("/p/") ? Number(pathname.slice(3)) : 0;
    const links = Array.from(
      { length: 6 },
      (_, i) => `<a href="/p/${n * 6 + i + 1}">page ${n * 6 + i + 1}</a>`
    ).join(" ");
    return new Response(
      `<!doctype html><html lang="en"><head><title>Page ${n}</title></head><body><h1>Page ${n}</h1>${links}<a href="/hang">hang</a></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  },
});

// A small fast site that finishes on its own, for the runs that never reach the budget.
const fastSite = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname === "/about") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Fast ${pathname}</title></head><body><h1>Hello</h1><a href="/about">About</a></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
});

// Pages answer fast; robots.txt, sitemaps and llms.txt never do. Without a cap on discovery
// the whole budget went before the first page (#1271 review).
const slowDiscoverySite = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname.startsWith("/p/")) {
      await Bun.sleep(150);
      const n = pathname.startsWith("/p/") ? Number(pathname.slice(3)) : 0;
      const links = Array.from(
        { length: 6 },
        (_, i) => `<a href="/p/${n * 6 + i + 1}">p</a>`
      ).join(" ");
      return new Response(
        `<!doctype html><html lang="en"><head><title>P ${n}</title></head><body><h1>P ${n}</h1>${links}</body></html>`,
        { headers: { "content-type": "text/html" } }
      );
    }
    if (/robots|sitemap|llms/.test(pathname)) {
      return new Promise<Response>((resolve) =>
        hung.push(() => resolve(new Response("x")))
      );
    }
    return new Response("not found", { status: 404 });
  },
});

// Accepts the TCP connection and never answers: the seed itself hangs.
const blackhole = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { data() {}, open() {}, close() {} },
});

// Pages are fast and the home page links 60 stylesheets that each take 3 s: the resource checks
// cannot finish inside the budget's margin.
const slowAssetsSite = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/") {
      const links = Array.from(
        { length: 60 },
        (_, i) => `<link rel="stylesheet" href="/slow/${i}.css">`
      ).join("");
      return new Response(
        `<!doctype html><html lang="en"><head><title>Assets</title>${links}</head><body><h1>Assets</h1><p>hello</p></body></html>`,
        { headers: { "content-type": "text/html" } }
      );
    }
    if (pathname.startsWith("/slow/")) {
      await Bun.sleep(3000);
      return new Response("body{}", {
        headers: { "content-type": "text/css" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void slowAssetsSite.stop(true);
  void slowDiscoverySite.stop(true);
  blackhole.stop(true);
  for (const release of hung) release();
  void site.stop(true);
  void fastSite.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

let homes = 0;

// #1839: test-only knobs, read under NODE_ENV "test" alone, set by the runs that wait out the
// floors they replace. The margin's floor (production 15 s):
const MIN_MARGIN_MS = 3_000;
// The start-URL probes' limits (production: a 10 s redirect hop, then 10 s per reachability
// attempt). Shorter than the hop, so a seed that never answers reaches the budget sooner, and
// with the reachability check longer than what is left of a 5 or 6 s budget, so the budget,
// not the probe, still ends the run.
const PROBE_TIMEOUT_MS = 4_000;

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
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
    NODE_ENV: "test",
    ...extra,
  };
}

async function audit(...args: string[]) {
  return auditUrl(`http://127.0.0.1:${site.port}/`, ...args);
}

async function auditUrl(url: string, ...args: string[]) {
  return auditUrlWithEnv({}, url, ...args);
}

async function auditUrlWithEnv(
  extra: Record<string, string>,
  url: string,
  ...args: string[]
) {
  const started = Date.now();
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      url,
      "--offline",
      "--http",
      "--concurrency",
      "2",
      "--per-host",
      "2",
      "-m",
      "40",
      ...(args.includes("-f") ? [] : ["-f", "json"]),
      ...args,
    ],
    { env: cleanEnv(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err, elapsedMs: Date.now() - started };
}

interface JsonReport {
  meta: { pagesCrawled?: number; totalPages?: number };
  status: string;
  statusReason?: string;
  statusReasonCode?: string;
  maxDuration?: {
    resourceChecksCut?: boolean;
    seconds: number;
    unfetchedPages: number;
    pagesNotEvaluated: number;
    siteChecksCut: boolean;
  };
}

// The runs that wait out a budget are concurrent: each is a separate subprocess against its own
// server and scratch HOME, idle while it waits, and every bound below is the configured budget plus
// the documented margin, so overlapping them shortens the file without loosening a single assertion.
describe("squirrel audit --max-duration", () => {
  test.concurrent("cuts a slow crawl at the budget and writes a partial report inside the margin", async () => {
    const r = await audit("--max-duration", String(BUDGET_S));
    // Exits within budget + margin max(10%, 15 s), plus start-up and the report.
    expect(r.elapsedMs).toBeLessThan((BUDGET_S + 15) * 1000 + 8_000);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as JsonReport;
    expect(report.status).toBe("partial");
    expect(report.statusReasonCode).toBe("max_duration");
    expect(report.statusReason).toContain("--max-duration");
    expect(report.maxDuration?.seconds).toBe(BUDGET_S);
    expect(report.maxDuration?.unfetchedPages).toBeGreaterThan(0);
  }, 90_000);

  test.concurrent("the text report says it is partial", async () => {
    const r = await audit("--max-duration", String(BUDGET_S), "-f", "text");
    expect(r.code).toBe(0);
    expect(r.out).toContain("PARTIAL AUDIT");
    expect(r.out).toContain("--max-duration");
  }, 90_000);

  test.concurrent("a budget the audit never reaches changes nothing", async () => {
    const r = await auditUrl(
      `http://127.0.0.1:${fastSite.port}/`,
      "--max-duration",
      "300"
    );
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as JsonReport;
    expect(report.status).toBe("completed");
    expect(report.maxDuration).toBeUndefined();
  }, 90_000);

  test.concurrent("robots.txt and sitemaps that never answer do not use up the budget before the first page", async () => {
    const r = await auditUrlWithEnv(
      { SQUIRREL_TEST_MIN_MARGIN_MS: String(MIN_MARGIN_MS) },
      `http://127.0.0.1:${slowDiscoverySite.port}/`,
      "--max-duration",
      String(DISCOVERY_BUDGET_S)
    );
    // Budget + the configured margin, plus start-up and the report.
    expect(r.elapsedMs).toBeLessThan(
      DISCOVERY_BUDGET_S * 1000 + MIN_MARGIN_MS + 8_000
    );
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as JsonReport;
    expect(["completed", "partial"]).toContain(report.status);
    expect(report.meta.totalPages ?? 0).toBeGreaterThan(1);
  }, 90_000);

  test.concurrent("a seed that never answers fails at the limit with an unreachable report, exit 5, class timeout", async () => {
    const r = await auditUrlWithEnv(
      { SQUIRREL_TEST_REACHABILITY_TIMEOUT_MS: String(PROBE_TIMEOUT_MS) },
      `http://127.0.0.1:${blackhole.port}/`,
      "--max-duration",
      String(BUDGET_S)
    );
    expect(r.code).toBe(5);
    // It waits for the budget, and stops there (start-up and the report get 8 s).
    expect(r.elapsedMs).toBeGreaterThanOrEqual(BUDGET_S * 1000);
    expect(r.elapsedMs).toBeLessThan(BUDGET_S * 1000 + 8_000);
    const outcome = JSON.parse(r.out) as {
      status: string;
      statusReason: string;
      statusReasonCode: string;
      message: string;
    };
    expect(outcome.status).toBe("unreachable");
    expect(outcome.statusReasonCode).toBe("timeout");
    expect(outcome.statusReason).toContain(
      `${BUDGET_S}s --max-duration time limit was reached`
    );
    // The reason says what happened once; the message adds "Cannot reach" itself.
    expect(outcome.message.match(/Cannot reach/g)).toHaveLength(1);
  }, 60_000);

  test.concurrent("the unreachable outputs never carry userinfo, query or fragment (budget and not)", async () => {
    const secret = (port: number | undefined) => {
      // Built at runtime: a literal user:password@ URL trips the secret scan.
      const url = new URL(`http://127.0.0.1:${port}/p?token=SECRET#frag`);
      url.username = "admin";
      url.password = ["hunt", "er2"].join("");
      return url.href;
    };
    for (const [url, args] of [
      [secret(blackhole.port), ["--max-duration", String(BUDGET_S)]],
      [secret(1), []],
    ] as const) {
      const r = await auditUrlWithEnv(
        { SQUIRREL_TEST_REACHABILITY_TIMEOUT_MS: String(PROBE_TIMEOUT_MS) },
        url,
        ...args
      );
      expect(r.code).toBe(5);
      for (const text of [r.out, r.err]) {
        expect(text).not.toContain("hunter2");
        expect(text).not.toContain("SECRET");
        expect(text).not.toContain("#frag");
        expect(text).not.toContain("admin:");
      }
    }
  }, 90_000);

  test.concurrent("resource checks that run out of the budget's time are named in the report", async () => {
    const r = await auditUrl(
      `http://127.0.0.1:${slowAssetsSite.port}/`,
      "--max-duration",
      String(BUDGET_S)
    );
    expect(r.elapsedMs).toBeLessThan((BUDGET_S + 15) * 1000 + 8_000);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as JsonReport & {
      maxDuration?: { resourceChecksCut?: boolean };
    };
    expect(report.status).toBe("partial");
    expect(report.maxDuration?.resourceChecksCut).toBe(true);
    expect(report.statusReason).toContain("resource checks were cut short");
  }, 90_000);

  test("a squirrel.toml max_duration past 7 days is refused with the config error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "squirrel-max-duration-cfg-"));
    try {
      writeFileSync(
        join(dir, "squirrel.toml"),
        "[crawler]\nmax_duration = 604801\n"
      );
      const proc = Bun.spawn(
        [
          process.execPath,
          "run",
          entry,
          "audit",
          "http://127.0.0.1:1/",
          "--offline",
          "--http",
          "-f",
          "json",
        ],
        {
          cwd: dir,
          env: cleanEnv(),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${out}${err}`).toContain(
        "crawler.max_duration: Too big: expected number to be <=604800"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a budget past 7 days is refused, not turned into a timer overflow", async () => {
    const r = await audit("--max-duration", "99999999");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--max-duration must be at most 604800 seconds");
  }, 60_000);

  test.each(["0", "-5", "abc", "1e3", ""])(
    "--max-duration %p is rejected with exit 1 before anything is crawled",
    async (value) => {
      const r = await audit("--max-duration", value);
      expect(r.code).toBe(1);
      expect(r.err).toContain(
        "--max-duration must be a positive number of seconds"
      );
    },
    60_000
  );
});
