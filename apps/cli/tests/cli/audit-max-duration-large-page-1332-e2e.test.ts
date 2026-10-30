// `--max-duration` and one very large page (#1332), end to end with the real CLI: a page over the
// documented cap (5 MiB of HTML) is stored but not parsed or evaluated in a budgeted run and is
// counted in `maxDuration.pagesNotEvaluated`; a run without the flag audits it as before.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-max-duration-big-"));

const BIG_BYTES = 6 * 1024 * 1024;
const bigBody = `<!doctype html><html lang="en"><head><title>Big</title></head><body><h1>Big</h1>${"<b></b>".repeat(Math.ceil(BIG_BYTES / 7))}</body></html>`;

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    const html = { headers: { "content-type": "text/html; charset=utf-8" } };
    if (pathname === "/") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Home</title></head><body><h1>Home</h1><a href="/big">big</a> <a href="/small">small</a></body></html>`,
        html
      );
    }
    if (pathname === "/small") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Small</title></head><body><h1>Small</h1><p>hello</p></body></html>`,
        html
      );
    }
    if (pathname === "/big") return new Response(bigBody, html);
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

let homes = 0;
async function audit(...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
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
      ...args,
    ],
    {
      env: {
        ...env,
        HOME: join(scratch, `home-${++homes}`),
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
  return { code, out, elapsedMs: Date.now() - started };
}

interface Report {
  status: string;
  statusReasonCode?: string;
  statusReason?: string;
  maxDuration?: {
    pagesNotEvaluated: number;
    pagesTooLarge?: number;
    tooLargePages?: string[];
    siteChecksCut: boolean;
  };
}

describe("a very large page under --max-duration (#1332)", () => {
  test("is not evaluated, is counted, and the run stays inside the budget plus margin", async () => {
    const budget = 20;
    const { out, elapsedMs } = await audit("--max-duration", String(budget));
    const report = JSON.parse(out) as Report;
    expect(report.status).toBe("partial");
    expect(report.statusReasonCode).toBe("max_duration");
    // Its own reason and list, not a count under a clock that did not run out.
    expect(report.maxDuration?.pagesTooLarge).toBe(1);
    expect(report.maxDuration?.tooLargePages?.[0]).toContain("/big");
    expect(report.maxDuration?.pagesNotEvaluated).toBe(0);
    expect(report.maxDuration?.siteChecksCut).toBe(false);
    expect(report.statusReason).toContain("too large to parse");
    expect(report.statusReason).not.toContain("Stopped at");
    // One parse of this page takes over 10 s, and an uncapped run parses it several times: the whole
    // run stays inside the budget, with no margin.
    expect(elapsedMs).toBeLessThan(budget * 1000);
  }, 90_000);

  test("without the flag the page is audited and nothing is cut", async () => {
    const { out } = await audit();
    const report = JSON.parse(out) as Report;
    expect(report.maxDuration).toBeUndefined();
    expect(report.status).not.toBe("partial");
  }, 90_000);
});
