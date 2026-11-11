// `squirrel audit --target-url` (#1777) through the real CLI against a local 20 page site that records every
// request: exactly the 3 listed pages are fetched (plus robots.txt), the other 17 get no finding, whole-site
// rules report not checked with the reason, and the JSON report accounts for every URL given.

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
        // Each page also links to a path of its own that does not exist: `/from/<page>` is a dead link found
        // only on that page.
        `<!doctype html><html lang="en"><head><title>Page ${pathname}</title></head><body><h1>Hello</h1>${links}<a href="/from${pathname}">dead</a><a href="/p/2#no-such-section">anchor</a></body></html>`,
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
    auditLevel?: { targeted?: boolean };
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

    // The site saw the three pages and robots.txt as GETs: no start URL, no sitemap, no probe, no link followed.
    const gets = [...new Set(hits.filter((h) => h.startsWith("GET ")))].sort();
    expect(gets).toEqual([
      "GET /p/1",
      "GET /p/2",
      "GET /p/3",
      "GET /robots.txt",
    ]);
    // Link status checks (#1778): only links found on the three listed pages are checked, each once. The dead
    // link of a listed page is asked for; the dead link of an unlisted page never is.
    const heads = hits.filter((h) => h.startsWith("HEAD "));
    expect(new Set(heads).size).toBe(heads.length);
    expect(heads).toContain("HEAD /from/p/1");
    expect(heads).toContain("HEAD /from/p/3");
    expect(heads).not.toContain("HEAD /from/p/4");
    expect(hits.some((h) => /sitemap|llms|well-known/.test(h))).toBe(false);

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
    // The report says the run was targeted (#1777).
    expect(json.meta.auditLevel?.targeted).toBe(true);
    // The per-rule statement (#1747): a page rule ran over the three pages, a whole-site rule did not run.
    const byRule = new Map((json.rules ?? []).map((r) => [r.ruleId, r]));
    expect(byRule.get("core/meta-title")).toMatchObject({
      status: "ran",
      scope: { pages: 3 },
    });
    expect(byRule.get("links/orphan-pages")).toMatchObject({
      status: "skipped",
      reason: "targeted-run",
    });
    // The site rules that can be judged from the listed pages run (#1778) and report the dead links on them.
    for (const id of ["links/broken-links", "security/csp"]) {
      expect(byRule.get(id)?.status, id).toBe("ran");
    }
    // An anchor to a listed page that has no such id is found (#1778); the rule judges only targets it fetched.
    expect(byRule.get("links/broken-anchors")?.status).toBe("ran");
    expect(r.out).toContain("no-such-section");
    expect(r.out).toContain("/from/p/1");
    expect(r.out).not.toContain("/from/p/4");
    // Every URL given is accounted for: the off-site one is listed with a reason, not dropped.
    expect(json.meta.targeted?.requested).toBe(4);
    expect(json.meta.targeted?.audited).toBe(3);
    expect(json.meta.targeted?.unaudited).toHaveLength(1);
    expect(json.meta.targeted?.unaudited[0]?.url).toContain(
      "elsewhere.example.org"
    );
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
