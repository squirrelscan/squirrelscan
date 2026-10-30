// `squirrel audit --max-duration` (#1271), end to end: the real CLI in a
// subprocess against a local site that is slow on every page and never answers
// one of them. The budget must cut the crawl, keep what was fetched and write a
// `partial` report with reason code `max_duration`, inside the documented margin
// (max(10% of the budget, 15 s)). Every run gets a scratch HOME, --offline, no
// update or telemetry, and no stdin.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-max-duration-"));

const PAGE_DELAY_MS = 700;
const hung: Array<() => void> = [];

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

afterAll(() => {
  for (const release of hung) release();
  void site.stop(true);
  void fastSite.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

let homes = 0;

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
  return auditUrl(`http://127.0.0.1:${site.port}/`, ...args);
}

async function auditUrl(url: string, ...args: string[]) {
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
    { env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
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
    seconds: number;
    unfetchedPages: number;
    pagesNotEvaluated: number;
    siteChecksCut: boolean;
  };
}

describe("squirrel audit --max-duration", () => {
  test("cuts a slow crawl at the budget and writes a partial report inside the margin", async () => {
    const r = await audit("--max-duration", "5");
    // Exits within budget + margin max(10%, 15 s), plus start-up and the report.
    expect(r.elapsedMs).toBeLessThan((5 + 15) * 1000 + 8_000);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as JsonReport;
    expect(report.status).toBe("partial");
    expect(report.statusReasonCode).toBe("max_duration");
    expect(report.statusReason).toContain("--max-duration");
    expect(report.maxDuration?.seconds).toBe(5);
    expect(report.maxDuration?.unfetchedPages).toBeGreaterThan(0);
  }, 90_000);

  test("the text report says it is partial", async () => {
    const r = await audit("--max-duration", "4", "-f", "text");
    expect(r.code).toBe(0);
    expect(r.out).toContain("PARTIAL AUDIT");
    expect(r.out).toContain("--max-duration");
  }, 90_000);

  test("a budget the audit never reaches changes nothing", async () => {
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
