// `squirrel audit --include-pages -f json` and `squirrel report --include-pages` (#1260),
// end to end against a local site with ok pages and a 404. One scratch HOME for
// the audit and the report that reads it back.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-include-pages-"));

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname === "/about") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Page ${pathname}</title><meta name="description" content="A page"></head><body><h1>Hello</h1><a href="/about">About</a> <a href="/missing">Missing</a></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

function env(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    out[k] = v;
  }
  return {
    ...out,
    HOME: home,
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
  };
}

async function squirrel(home: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], {
    env: env(home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

const url = () => `http://127.0.0.1:${site.port}/`;
const auditArgs = (...extra: string[]) => [
  "audit",
  url(),
  "--offline",
  "--http",
  "-m",
  "10",
  ...extra,
];

interface Page {
  url: string;
  status: number;
  ruleCount: number;
}
interface Json {
  meta: { schemaVersion?: string };
  pages?: Page[];
  pagesTotal?: number;
  pagesTruncated?: boolean;
}

describe("--include-pages", () => {
  const home = join(scratch, "home-main");

  test("audit lists every crawled page with status and ruleCount", async () => {
    const r = await squirrel(
      home,
      ...auditArgs("-f", "json", "--include-pages")
    );
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out) as Json;
    expect(json.meta.schemaVersion).toBe("1.2");
    const pages = json.pages ?? [];
    const byPath = new Map(pages.map((p) => [new URL(p.url).pathname, p]));
    expect(byPath.get("/")?.status).toBe(200);
    expect(byPath.get("/about")?.status).toBe(200);
    expect(byPath.get("/missing")?.status).toBe(404);
    // An audited page had rules report on it; every entry has a whole count.
    expect(byPath.get("/")?.ruleCount).toBeGreaterThan(0);
    for (const p of pages) expect(Number.isInteger(p.ruleCount)).toBe(true);
    expect(json.pagesTotal).toBe(pages.length);
    expect(json.pagesTruncated).toBe(false);
  }, 120_000);

  test("report -f json --include-pages reads the same list back from the store", async () => {
    const r = await squirrel(
      home,
      "report",
      url(),
      "-f",
      "json",
      "--include-pages"
    );
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out) as Json;
    expect(json.pages?.map((p) => new URL(p.url).pathname).sort()).toEqual([
      "/",
      "/about",
      "/missing",
    ]);
    expect(
      json.pages?.find((p) => new URL(p.url).pathname === "/")?.ruleCount
    ).toBeGreaterThan(0);
  }, 120_000);

  test("without the flag the JSON has no pages key", async () => {
    const r = await squirrel(home, "report", url(), "-f", "json");
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out) as Json;
    expect(json).not.toHaveProperty("pages");
    expect(json).not.toHaveProperty("pagesTotal");
    expect(json.meta.schemaVersion).toBe("1.2");
  }, 120_000);

  test("another format says the flag is JSON only and still prints the report", async () => {
    const r = await squirrel(
      home,
      "report",
      url(),
      "-f",
      "text",
      "--include-pages"
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain("--include-pages only applies to --format json");
    expect(r.out).toContain("SUMMARY");
  }, 120_000);
});
