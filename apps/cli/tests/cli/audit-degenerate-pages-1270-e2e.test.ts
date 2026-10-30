// #1270 end to end: the real CLI over a site whose pages have no markup (plain
// text, JSON, a comment, a bare doctype served as text/html) reports no
// `Rule error` for any rule. A zero-byte body is not audited at all (the
// engine drops a page with no html), which is tracked separately.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-degenerate-"));
const html = { "content-type": "text/html; charset=utf-8" };

const PAGES: Record<string, string> = {
  "/": `<!doctype html><html lang="en"><head><title>Degenerate pages fixture</title></head><body><h1>Home</h1><a href="/text">t</a><a href="/json">j</a><a href="/comment">c</a><a href="/doctype">d</a></body></html>`,
  "/text": "plain text, no markup at all",
  "/json": '{"json":1}',
  "/comment": "<!-- only a comment -->",
  "/doctype": "<!doctype html>",
};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/robots.txt")
      return new Response("User-agent: *\nAllow: /\n");
    const body = PAGES[pathname];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body, { headers: html });
  },
});

afterAll(() => {
  void server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

describe("squirrel audit over pages with no markup", () => {
  test("no rule reports a Rule error, and the degenerate pages were audited", async () => {
    const out = join(scratch, "report.json");
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        entry,
        "audit",
        `http://127.0.0.1:${server.port}/`,
        "--offline",
        "--passive",
        "-m",
        "10",
        "-f",
        "json",
        "-o",
        out,
      ],
      {
        env: {
          ...process.env,
          HOME: join(scratch, "home"),
          SQUIRREL_NO_UPDATE: "1",
          NO_TELEMETRY: "1",
          NO_COLOR: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).not.toContain("Rule error");
    expect(stderr).not.toContain("Rule error");
    const report = JSON.parse(text) as { meta: { totalPages: number } };
    expect(report.meta.totalPages).toBeGreaterThanOrEqual(5);
  }, 120_000);
});
