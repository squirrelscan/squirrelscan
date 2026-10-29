// #1254 end to end: a Vite-style SPA whose HTML is an empty shell and whose
// stack lives only in its bundle. A signed-out `--offline` audit reports the
// stack from local detection, and reading the bundle costs no request the audit
// did not already make: the bundle bodies are the bytes the crawl fetched for
// the secret rules.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");
const REF = "abcdefghijklmnopqrst";

const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture app</title><meta name="description" content="A fixture single page app for tech detection."></head><body><div id="root"></div><script type="module" crossorigin src="/assets/index-a1b2c3.js"></script></body></html>`;
const BUNDLE = `var a=1;const supabase=createClient("https://${REF}.supabase.co","anon-key-value");export{supabase};`;

let server: ReturnType<typeof Bun.serve>;
let base: string;
let home: string;
let out: string;
const hits = new Map<string, number>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
      if (pathname === "/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (pathname === "/") {
        return new Response(SHELL, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/assets/index-a1b2c3.js") {
        return new Response(BUNDLE, {
          headers: { "content-type": "application/javascript" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  home = mkdtempSync(join(tmpdir(), "sq-1254-home-"));
  out = mkdtempSync(join(tmpdir(), "sq-1254-out-"));
});

afterAll(() => {
  server?.stop(true);
  for (const dir of [home, out]) rmSync(dir, { recursive: true, force: true });
});

async function cli(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, NO_COLOR: "1", NO_TELEMETRY: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`cli ${args.join(" ")} exited ${exitCode}\n${stderr}`);
}

/** One offline audit in its own project dir; returns the detected tech ids and the request counts. */
async function audit(name: string, toml?: string) {
  const cwd = join(out, name);
  mkdirSync(cwd, { recursive: true });
  if (toml) writeFileSync(join(cwd, "squirrel.toml"), toml);
  hits.clear();
  const file = join(out, `${name}.json`);
  await cli(cwd, [
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
    file,
  ]);
  const report = JSON.parse(readFileSync(file, "utf8")) as {
    technologies?: { items: Array<{ id: string }> };
  };
  return {
    ids: report.technologies?.items.map((t) => t.id) ?? null,
    requests: Object.fromEntries([...hits].sort()),
  };
}

describe("#1254 tech detection reads fetched bundles", () => {
  test("a signed-out --offline audit reports Supabase from the bundle, with no extra request", async () => {
    const withBundles = await audit("on");
    expect(withBundles.ids).toContain("supabase");
    // the bundle was fetched by the crawl itself: once-or-more is the audit's
    // own business, but it is the same number with bundle matching switched off
    const bundleOff = await audit("off", "[tech_detect]\nbundle_bytes = 0\n");
    expect(bundleOff.ids ?? []).not.toContain("supabase");
    expect(withBundles.requests).toEqual(bundleOff.requests);
    expect(
      withBundles.requests["/assets/index-a1b2c3.js"]
    ).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
