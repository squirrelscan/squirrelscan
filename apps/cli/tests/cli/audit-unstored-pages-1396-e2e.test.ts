// #1396 end to end: `squirrel audit --include-pages -f json` lists the URLs the crawl requested but stored no page
// for (an errored fetch, an excluded URL, one robots.txt blocks), and the report names the rules that ran.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-unstored-pages-"));

// A raw HTTP server, so one path can drop the connection mid-request (a fetch that fails and stores no response).
const PAGE = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="A page"></head><body><h1>Hello</h1><a href="/fine">Fine</a> <a href="/excluded/a">Excluded</a> <a href="/private/x">Private</a> <a href="/boom">Boom</a></body></html>`;
const reply = (status: string, type: string, body: string): string =>
  `HTTP/1.1 ${status}\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;

const site = Bun.listen<undefined>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data(socket, chunk) {
      const path =
        /^[A-Z]+ (\S+)/.exec(Buffer.from(chunk).toString("latin1"))?.[1] ?? "/";
      if (path === "/boom") {
        socket.terminate();
        return;
      }
      if (path === "/robots.txt")
        socket.end(
          reply("200 OK", "text/plain", "User-agent: *\nDisallow: /private\n")
        );
      else if (path === "/" || path === "/fine")
        socket.end(
          reply("200 OK", "text/html; charset=utf-8", PAGE(`Page ${path}`))
        );
      else socket.end(reply("404 Not Found", "text/plain", "not found"));
    },
  },
});

afterAll(() => {
  site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

interface Row {
  url: string;
  status: number;
  outcome: string;
  ruleCount: number;
  reason?: string;
}
interface Json {
  meta: { schemaVersion: string };
  pages?: Row[];
  pagesTotal?: number;
  executedRules?: string[];
  issues: Array<{ ruleId: string }>;
}

async function audit(...extra: string[]): Promise<Json> {
  const dir = mkdtempSync(join(scratch, "run-"));
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(
    join(dir, "squirrel.toml"),
    '[crawler]\nrespect_robots = true\nexclude = ["/excluded"]\n'
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
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
      "10",
      "-f",
      "json",
      ...extra,
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
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  return JSON.parse(out) as Json;
}

describe("--include-pages lists URLs with no stored page", () => {
  test("an errored fetch, an excluded URL and a robots-blocked one, after the crawled pages", async () => {
    const json = await audit("--include-pages");
    expect(json.meta.schemaVersion).toBe("1.5");
    const rows = json.pages ?? [];
    const byPath = new Map(rows.map((row) => [new URL(row.url).pathname, row]));
    expect(byPath.get("/")).toMatchObject({ status: 200, outcome: "ok" });
    expect(byPath.get("/excluded/a")).toMatchObject({
      status: 0,
      outcome: "skipped",
      reason: "excluded",
      ruleCount: 0,
    });
    expect(byPath.get("/private/x")).toMatchObject({
      status: 0,
      outcome: "skipped",
      reason: "robots-disallowed",
    });
    expect(byPath.get("/boom")).toMatchObject({ status: 0, outcome: "error" });
    expect(byPath.get("/boom")?.reason).toBeTruthy();
    // Crawled pages come first, and the total counts every row.
    const firstUnstored = rows.findIndex((row) => row.reason !== undefined);
    expect(
      rows.slice(firstUnstored).every((row) => row.reason !== undefined)
    ).toBe(true);
    expect(json.pagesTotal).toBe(rows.length);
  }, 240_000);

  test("without --include-pages nothing is listed, and executedRules names the rules that ran", async () => {
    const json = await audit();
    expect(json.pages).toBeUndefined();
    expect(json.executedRules?.length).toBeGreaterThan(5);
    expect([...(json.executedRules ?? [])]).toEqual(
      [...(json.executedRules ?? [])].sort()
    );
    for (const issue of json.issues)
      expect(json.executedRules).toContain(issue.ruleId);
  }, 240_000);
});
