// #1327: a request still hanging in the stage before the page rules (the soft-404
// re-fetch here) must not take the page rules' time. The real CLI against a local
// site whose pages all answer, except that the one page that looks like a soft 404
// is never answered a second time. At the probes deadline the probe is skipped and
// the report names it; the page rules still run on the fetched pages and the site
// checks finish, so `siteChecksCut` stays false.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-max-duration-probes-"));
const hung: Array<() => void> = [];
let goneRequests = 0;

const html = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch(req) {
    const { pathname } = new URL(req.url);
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (pathname === "/")
      return new Response(
        html(
          "Home page",
          `<p>Welcome to the test site.</p><a href="/about">About</a> <a href="/gone">Gone</a>`
        ),
        { headers }
      );
    if (pathname === "/about")
      return new Response(
        html(
          "About this site",
          `<p>About text for the page.</p><a href="/">Home</a>`
        ),
        { headers }
      );
    if (pathname === "/gone") {
      goneRequests++;
      // The crawl gets its answer; the soft-404 confirmation re-fetch never does.
      if (goneRequests > 1)
        return new Promise<Response>((resolve) =>
          hung.push(() => resolve(new Response("late")))
        );
      return new Response(
        html("Page Not Found", `<p>Sorry.</p><a href="/">Home</a>`),
        { headers }
      );
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  for (const release of hung) release();
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: join(scratch, "home"),
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
  };
}

interface JsonReport {
  status: string;
  meta: { totalPages?: number };
  issues?: unknown[];
  maxDuration?: {
    seconds: number;
    pagesNotEvaluated: number;
    siteChecksCut: boolean;
    probesSkipped?: string[];
  };
}

describe("--max-duration with a probe that hangs before the page rules (#1327)", () => {
  test("the probe is skipped at its deadline, named in the report, and the page rules and site checks still run", async () => {
    const started = Date.now();
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
        "--max-duration",
        "5",
      ],
      { env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
    );
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const elapsedMs = Date.now() - started;
    // Budget 5 s + margin 15 s, plus start-up and the report.
    expect(elapsedMs).toBeLessThan((5 + 15) * 1000 + 8_000);
    expect(code).toBe(0);
    const report = JSON.parse(out) as JsonReport;
    expect(report.status).toBe("partial");
    expect(report.maxDuration?.probesSkipped).toEqual([
      "soft-404-confirmation",
    ]);
    expect(report.maxDuration?.siteChecksCut).toBe(false);
    expect(report.maxDuration?.pagesNotEvaluated).toBe(0);
    // The page rules ran on the fetched pages.
    expect(report.meta.totalPages ?? 0).toBeGreaterThanOrEqual(3);
    expect((report.issues ?? []).length).toBeGreaterThan(0);
  }, 90_000);
});
