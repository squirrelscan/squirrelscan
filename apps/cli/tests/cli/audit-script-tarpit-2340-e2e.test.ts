// #2340 end to end: a default CLI audit (no --max-duration) still skips the rest of a host's scripts once the
// host has tarpitted the first ones, because the asset fetchers always share a tarpit-aware fetch budget.

import { CLOUD_RESOURCE_CHECK } from "@squirrelscan/core-contracts";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-script-tarpit-"));

const SCRIPT_COUNT = 40;
const scriptPaths = Array.from(
  { length: SCRIPT_COUNT },
  (_, i) => `/assets/bundle-${i}.js`
);
const scriptHits = new Set<string>();

const page = `<!doctype html><html lang="en"><head><title>Home</title><meta name="description" content="A page">${scriptPaths
  .map((p) => `<script src="${p}"></script>`)
  .join("")}</head><body><h1>Home</h1></body></html>`;

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/")
      return new Response(page, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (scriptPaths.includes(pathname)) {
      scriptHits.add(pathname);
      // Slower than a tarpit strike, so every script that is requested counts against the host.
      await Bun.sleep(CLOUD_RESOURCE_CHECK.tarpitLatencyMs + 300);
      return new Response("var a=1;", {
        headers: { "content-type": "application/javascript" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

describe("script fetches share the tarpit budget without --max-duration", () => {
  test("later scripts from a tarpitting host are never requested", async () => {
    const dir = mkdtempSync(join(scratch, "run-"));
    mkdirSync(join(dir, "home"), { recursive: true });
    // A page-count-scaled script limit is 10 for one page, as many as run at once, so nothing would be
    // "later". Storing scripts fetches every bundle, which is what queues the later ones.
    writeFileSync(
      join(dir, "squirrel.toml"),
      "[storage]\nstore_scripts = true\n"
    );
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (
        v === undefined ||
        /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k)
      )
        continue;
      env[k] = v;
    }
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
        "1",
        "-f",
        "json",
      ],
      {
        cwd: dir,
        env: {
          ...env,
          HOME: join(dir, "home"),
          SQUIRREL_NO_UPDATE: "1",
          NO_TELEMETRY: "1",
          NO_COLOR: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(scriptHits.size).toBeGreaterThan(0);
    expect(scriptHits.size).toBeLessThan(SCRIPT_COUNT);
  }, 120_000);
});
