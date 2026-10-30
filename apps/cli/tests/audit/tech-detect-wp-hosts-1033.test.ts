// #1033 end to end: the crawler stores only allow-listed response headers, so a host
// fingerprint that reads a header the list lacks passes its unit test and is dead in a real
// audit. This fixture sends the headers and the page comment those fingerprints read.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");

const HOME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture WordPress site</title>
<meta name="description" content="A fixture WordPress site served by managed hosts for technology detection.">
<meta name="generator" content="WordPress 6.6.2">
<link rel="stylesheet" href="/wp-content/themes/fixture/style.css"></head>
<body><main><h1>Fixture</h1><p>${"Hello from the fixture. ".repeat(20)}</p></main>
<!-- This website is like a Rocket, isn't it ? Performance optimized by WP Rocket. Learn more: https://wp-rocket.me --></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let base: string;
let home: string;
let out: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (pathname === "/") {
        return new Response(HOME, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-kinsta-cache": "HIT",
            "x-sg-cache": "HIT",
            "x-powered-by": "WP Engine",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  home = mkdtempSync(join(tmpdir(), "sq-1033-home-"));
  out = mkdtempSync(join(tmpdir(), "sq-1033-out-"));
});

afterAll(() => {
  server?.stop(true);
  for (const dir of [home, out]) rmSync(dir, { recursive: true, force: true });
});

describe("#1033 WordPress hosts and plugins in a real audit", () => {
  test("host headers and the plugin comment reach detection", async () => {
    const cwd = join(out, "run");
    mkdirSync(cwd, { recursive: true });
    const file = join(out, "run.json");
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
        file,
      ],
      {
        cwd,
        env: { ...process.env, HOME: home, NO_COLOR: "1", NO_TELEMETRY: "1" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`audit exited ${exitCode}\n${stderr}`);
    const report = JSON.parse(readFileSync(file, "utf8")) as {
      technologies?: { items: Array<{ id: string }> };
    };
    const ids = (report.technologies?.items ?? []).map((item) => item.id);
    // Each of these reads a header only the allow-list lets the crawler keep, or the page comment.
    expect(ids).toEqual(
      expect.arrayContaining(["kinsta", "siteground", "wp-engine", "wp-rocket"])
    );
  }, 120_000);
});
