// `squirrel audit --target-url` (#1777) through the real CLI against a local 20 page site that records every
// request: exactly the 3 listed pages are fetched (plus robots.txt), the links on them are status-checked once
// each (#1778), the other 17 get no finding, whole-site rules report not checked with the reason, and the JSON
// report accounts for every URL given.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-target-url-"));
const hits: string[] = [];

const links = Array.from(
  { length: 20 },
  (_, i) => `<a href="/p/${i}">p${i}</a>`
).join(" ");
const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    hits.push(`${req.method} ${pathname}`);
    if (pathname.startsWith("/p/") || pathname === "/") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Page ${pathname}</title></head><body><h1>Hello</h1>${links}</body></html>`,
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

const base = () => `http://127.0.0.1:${site.port}/`;

interface Json {
  meta: {
    auditLevel?: { targeted?: boolean; settings?: { externalLinks?: boolean } };
    targeted?: {
      requested: number;
      audited: number;
      unaudited: Array<{ url: string; reason: string }>;
    };
  };
  pages?: Array<{ url: string; status: number; reason?: string }>;
  rules?: Array<{
    ruleId: string;
    status: string;
    scope: { pages?: number; origin?: string };
    reason?: string;
  }>;
  pagesTotal?: number;
}

describe("--target-url", () => {
  test("fetches exactly the listed pages and accounts for every URL given", async () => {
    hits.length = 0;
    const r = await squirrel(
      join(scratch, "home"),
      "audit",
      base(),
      "--offline",
      "--http",
      "-f",
      "json",
      "--include-pages",
      "--target-url",
      "/p/1",
      "--target-url",
      `${base()}p/2`,
      "--target-url",
      "/p/3",
      "--target-url",
      "https://elsewhere.example.org/x"
    );
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out) as Json;

    // The site saw robots.txt and the three pages fetched, no start URL, no sitemap, no probe, no link
    // followed. The links on the listed pages are status-checked (#1778): every other /p/ target once, with
    // a HEAD request, and the HEAD control on one listed page.
    // (The reachability check reads the first listed URL too, so /p/1 has a second GET: a Set.)
    const gets = new Set(hits.filter((h) => h.startsWith("GET ")));
    expect([...gets].sort()).toEqual([
      "GET /p/1",
      "GET /p/2",
      "GET /p/3",
      "GET /robots.txt",
    ]);
    const heads = hits
      .filter((h) => h.startsWith("HEAD "))
      .map((h) => h.slice(5));
    const listed = ["/p/1", "/p/2", "/p/3"];
    expect(heads.filter((p) => listed.includes(p))).toHaveLength(1);
    expect(heads.filter((p) => !listed.includes(p)).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `/p/${i}`)
        .filter((p) => !listed.includes(p))
        .sort()
    );
    expect(hits.some((h) => /sitemap|llms|well-known/.test(h))).toBe(false);
    expect(hits).not.toContain("GET /");
    expect(hits).not.toContain("HEAD /");

    // The pages list also names the refused URL (status 0, with its reason); the audited pages are the three.
    const rows = json.pages ?? [];
    expect(
      rows
        .filter((p) => p.status > 0)
        .map((p) => new URL(p.url).pathname)
        .sort()
    ).toEqual(["/p/1", "/p/2", "/p/3"]);
    expect(rows.find((p) => p.status === 0)?.url).toContain(
      "elsewhere.example.org"
    );
    // The report marks the run as targeted (#1777); --offline is what turned external links off here.
    expect(json.meta.auditLevel?.targeted).toBe(true);
    expect(json.meta.auditLevel?.settings?.externalLinks).toBe(false);
    // The per-rule statement (#1747): a page rule ran over the three pages, a whole-site rule did not run,
    // and the link rule ran over the links on the listed pages (#1778).
    const byRule = new Map((json.rules ?? []).map((r) => [r.ruleId, r]));
    expect(byRule.get("core/meta-title")).toMatchObject({
      status: "ran",
      scope: { pages: 3 },
    });
    expect(byRule.get("links/orphan-pages")).toMatchObject({
      status: "skipped",
      reason: "targeted-run",
    });
    expect(byRule.get("links/broken-links")).toMatchObject({ status: "ran" });
    // Every URL given is accounted for: the off-site one is listed with a reason, not dropped.
    expect(json.meta.targeted?.requested).toBe(4);
    expect(json.meta.targeted?.audited).toBe(3);
    expect(json.meta.targeted?.unaudited).toHaveLength(1);
    expect(json.meta.targeted?.unaudited[0]?.url).toContain(
      "elsewhere.example.org"
    );
  });

  test("--external-links with --target-url is honoured, with no note that it is ignored (#1778)", async () => {
    const r = await squirrel(
      join(scratch, "home3"),
      "audit",
      base(),
      "--http",
      "-f",
      "json",
      "--external-links",
      "--target-url",
      "/p/1"
    );
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("is ignored on a targeted audit");
    const json = JSON.parse(r.out) as Json;
    expect(json.meta.auditLevel?.targeted).toBe(true);
    expect(json.meta.auditLevel?.settings?.externalLinks).toBe(true);
  });

  test("an ordinary audit of the same site has no meta.targeted", async () => {
    const r = await squirrel(
      join(scratch, "home2"),
      "audit",
      base(),
      "--offline",
      "--http",
      "-m",
      "3",
      "-f",
      "json"
    );
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as Json).meta).not.toHaveProperty("targeted");
  });
});
