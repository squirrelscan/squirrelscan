// `squirrel audit` exit codes, end to end (#1657): the real CLI in a subprocess against local
// sites. One row per exit path the CLI can reach without a signed-in account. This file was
// green on the code before the exit code was computed in one place, which is the point: only the
// rows the issue changes may differ (they are covered by the unit table in
// tests/audit/exit-code.test.ts, because a publish needs a public host and these are loopback).
//
// From #1657 the JSON report also carries `outcome`; the exit codes themselves did not change.
// A `partial` report exiting 0 is pinned by audit-max-duration-e2e.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-exit-1657-"));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Exit code fixture page for squirrel audits</title></head><body><main><h1>Fixture</h1><p>${"Plain words about nothing in particular. ".repeat(30)}</p></main></body></html>`;

/** 200 on `/`. */
const okSite = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/")
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    if (pathname === "/robots.txt")
      return new Response("User-agent: *\nAllow: /\n");
    return new Response("nf", { status: 404 });
  },
});

/** 500 on every page: the site is up and answers with an error. */
const brokenSite = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/robots.txt")
      return new Response("User-agent: *\nAllow: /\n");
    return new Response("boom", {
      status: 500,
      headers: { "content-type": "text/html" },
    });
  },
});

/** A Cloudflare challenge on every page. */
const blockedSite = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/robots.txt")
      return new Response("User-agent: *\nAllow: /\n");
    return new Response(
      "<html><title>Just a moment...</title><body>wait</body></html>",
      {
        status: 403,
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
      }
    );
  },
});

/** `/x` answers 301 to the ok site, which is another host (`localhost` against `127.0.0.1`). */
const shortener = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/x") {
      return new Response(null, {
        status: 301,
        headers: { location: `${okSite.url.origin}/` },
      });
    }
    return new Response("nf", { status: 404 });
  },
});

afterAll(() => {
  for (const s of [okSite, brokenSite, blockedSite, shortener])
    void s.stop(true);
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

async function audit(url: string, ...args: string[]) {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      url,
      "--offline",
      "--http",
      "-m",
      "3",
      "-f",
      "json",
      ...args,
    ],
    { env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

/** A port nothing listens on. */
function closedPort(): number {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  const port = s.port ?? 0;
  void s.stop(true);
  return port;
}

interface Row {
  name: string;
  url: () => string;
  args?: string[];
  code: number;
  status?: string;
}

const ROWS: Row[] = [
  {
    name: "ok",
    url: () => `${okSite.url.origin}/`,
    code: 0,
    status: "completed",
  },
  {
    name: "failed (the site answers 500)",
    url: () => `${brokenSite.url.origin}/`,
    code: 1,
    status: "failed",
  },
  {
    name: "blocked (a challenge page)",
    url: () => `${blockedSite.url.origin}/`,
    code: 3,
    status: "blocked",
  },
  {
    name: "redirected to another site",
    url: () => `http://localhost:${shortener.port}/x`,
    args: ["-y"],
    code: 4,
  },
  {
    name: "unreachable (nothing listens)",
    url: () => `http://127.0.0.1:${closedPort()}/`,
    code: 5,
  },
  {
    name: "fail-on tripped",
    url: () => `${okSite.url.origin}/`,
    args: ["--fail-on", "warnings>=0"],
    code: 2,
    status: "completed",
  },
  {
    name: "fail-on not tripped",
    url: () => `${okSite.url.origin}/`,
    args: ["--fail-on", "score<1"],
    code: 0,
    status: "completed",
  },
  {
    name: "blocked beats a fail-on gate",
    url: () => `${blockedSite.url.origin}/`,
    args: ["--fail-on", "warnings>=0"],
    code: 3,
    status: "blocked",
  },
  {
    name: "validation: a start URL that is not http",
    url: () => "ftp://example.com/",
    code: 1,
  },
  {
    name: "validation: an unknown --level",
    url: () => `${okSite.url.origin}/`,
    args: ["--level", "nonsense"],
    code: 1,
  },
  {
    name: "validation: --max-depth is not a number",
    url: () => `${okSite.url.origin}/`,
    args: ["--max-depth", "zero"],
    code: 1,
  },
];

describe("squirrel audit exit codes (#1657)", () => {
  for (const row of ROWS) {
    test(`${row.name} exits ${row.code}`, async () => {
      const r = await audit(row.url(), ...(row.args ?? []));
      expect(r.code, r.err.slice(-400)).toBe(row.code);
      if (row.status) {
        const report = JSON.parse(r.out) as {
          status?: string;
          outcome?: {
            exit_code: number;
            status: string;
            publish: { status: string; reason?: string };
          };
        };
        expect(report.status).toBe(row.status);
        // The report says what the process exits with, and that nothing was published and why
        // (a loopback site is never published, whatever else is set).
        expect(report.outcome).toEqual({
          exit_code: row.code,
          status: row.status,
          publish: { status: "skipped", reason: "non-public-host" },
        });
      }
    }, 120_000);
  }
});
