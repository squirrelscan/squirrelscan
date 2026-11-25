// security/exposed-backups (#2330): backup and temporary siblings of crawled
// server-side files. Candidates come only from crawled paths, a hit needs a
// content signature, a catch-all 200 is dropped against a same-shape baseline,
// requests are capped per file and per audit inside the shared probe budget,
// and nothing is sent below aggressive or to another origin. Probing tests run
// the rule against real fixture servers on localhost.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import type { ProbeAnswer } from "../src/security/exposed-files-allowlist";
import type { CheckResult, RuleContext } from "../src/types";

import { createProbeBudget, type ProbeLevel } from "../src/probe-budget";
import {
  BACKUP_PROBES_PER_FILE,
  BACKUP_SIBLINGS,
  backupCandidates,
  buildBackupProbe,
  classifyBackup,
  exposedBackupsRule,
  MAX_BACKUP_PROBES,
  MAX_BACKUP_SOURCE_FILES,
  selectBackupSourceFiles,
} from "../src/security/exposed-backups";
import { clearRequestAsync, setRequestAsync } from "../src/tools";

type Handler = (req: Request) => Response | Promise<Response>;

interface Fixture {
  origin: string;
  /** "METHOD /path" for every request the server received. */
  seen: string[];
  stop: () => void;
}

const servers: Fixture[] = [];

const NOT_FOUND = () =>
  new Response("<!doctype html><title>Not found</title>", {
    status: 404,
    headers: { "content-type": "text/html" },
  });

function serve(routes: Record<string, Handler>, fallback?: Handler): Fixture {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(`${req.method} ${path}`);
      const route = routes[path];
      if (route) return route(req);
      return (fallback ?? NOT_FOUND)(req);
    },
  });
  const fixture = {
    origin: `http://127.0.0.1:${server.port}`,
    seen,
    stop: () => server.stop(true),
  };
  servers.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

beforeAll(() => {
  // The CLI installs a request tool; without one the rule reports analyze-offline.
  setRequestAsync(() => Promise.reject(new Error("unused")));
});
afterAll(() => {
  clearRequestAsync();
});

function ctx(
  origin: string,
  pagePaths: string[],
  opts: {
    level?: ProbeLevel;
    noProbe?: boolean;
    budgetMs?: number;
    now?: () => number;
    extraUrls?: string[];
  } = {}
): RuleContext {
  const urls = [
    ...pagePaths.map((p) => `${origin}${p}`),
    ...(opts.extraUrls ?? []),
  ];
  return {
    page: {
      url: `${origin}/`,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as RuleContext["parsed"],
    site: {
      baseUrl: `${origin}/`,
      pages: urls.map((url) => ({
        url,
        statusCode: 200,
        parsed: {} as RuleContext["parsed"],
      })),
      robotsTxt: null,
      sitemaps: null,
    },
    probe: opts.noProbe
      ? undefined
      : createProbeBudget({
          level: opts.level ?? "aggressive",
          budgetMs: opts.budgetMs ?? 60_000,
          ...(opts.now ? { now: opts.now } : {}),
        }),
    options: {},
  };
}

async function run(c: RuleContext): Promise<CheckResult[]> {
  return (await exposedBackupsRule.run(c)).checks;
}

const text =
  (body: string, type = "text/plain") =>
  () =>
    new Response(body, { headers: { "content-type": type } });
const bytes =
  (b: Uint8Array<ArrayBuffer>, type = "application/octet-stream") =>
  () =>
    new Response(b, { headers: { "content-type": type } });

const DB_SECRET_VALUE = ["hunter2", "db", "value"].join("-");
const PHP_SOURCE = `<?php\n$db_password = '${DB_SECRET_VALUE}';\necho render('cart');\n`;
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0x08, 0]);
const SWAP = new TextEncoder().encode("b0VIM 9.0\0\0\0\0/var/www/cart.php");
const SPA_SHELL =
  '<!doctype html><html><head><title>Shop</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

function answer(body: string | Uint8Array, status = 200): ProbeAnswer {
  const b = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    status,
    contentType: "",
    headers: new Headers(),
    bytes: b,
    text: new TextDecoder().decode(b),
  };
}

/** Every path the rule would request for these crawled paths, in order. */
function expectedPaths(paths: string[], origin: string): string[] {
  return selectBackupSourceFiles(
    paths.map((p) => `${origin}${p}`),
    origin
  ).files.flatMap((f) => backupCandidates(f).map((c) => `GET ${c.path}`));
}

describe("security/exposed-backups candidates", () => {
  const origin = "https://example.com";

  test("only crawled same-origin server-side files are used, deduped, query dropped", () => {
    const { files, found } = selectBackupSourceFiles(
      [
        `${origin}/shop/cart.php?id=1`,
        `${origin}/shop/cart.php?id=2`,
        `${origin}/about.html`,
        `${origin}/blog/post`,
        `${origin}/`,
        `${origin}/Default.ASPX`,
        "https://other.example.com/admin.php",
        "http://example.com/http-only.php",
        `${origin}/account/logout.php`,
      ],
      origin
    );
    expect(files.map((f) => f.path)).toEqual([
      "/shop/cart.php",
      "/Default.ASPX",
    ]);
    expect(found).toBe(2);
  });

  test("each file yields at most BACKUP_PROBES_PER_FILE siblings in its own directory", () => {
    const file = selectBackupSourceFiles([`${origin}/shop/cart.php`], origin)
      .files[0]!;
    const paths = backupCandidates(file).map((c) => c.path);
    expect(paths.length).toBeLessThanOrEqual(BACKUP_PROBES_PER_FILE);
    expect(paths).toEqual([
      "/shop/cart.php.bak",
      "/shop/cart.php~",
      "/shop/.cart.php.swp",
      "/shop/cart.php.old",
      "/shop/cart.bak",
      "/shop/cart.php.zip",
    ]);
  });

  test("files are capped per audit and the count of eligible ones is kept", () => {
    const urls = Array.from(
      { length: MAX_BACKUP_SOURCE_FILES + 5 },
      (_, i) => `${origin}/p${i}.php`
    );
    const { files, found } = selectBackupSourceFiles(urls, origin);
    expect(files.length).toBe(MAX_BACKUP_SOURCE_FILES);
    expect(found).toBe(MAX_BACKUP_SOURCE_FILES + 5);
  });
});

describe("security/exposed-backups content signatures", () => {
  test("source, archives, swap files and SQL dumps are recognized", () => {
    const cases: Array<[string | Uint8Array, string, string]> = [
      [PHP_SOURCE, "php", "PHP source"],
      ['<%@ Page Language="C#" %>\n<html></html>', "aspx", "ASP.NET source"],
      ["<% Response.Write(x) %>", "asp", "ASP source"],
      ['<%= request.getParameter("q") %>', "jsp", "JSP source"],
      ['<cfquery name="q">SELECT 1</cfquery>', "cfm", "ColdFusion source"],
      [
        '<!--#include virtual="/inc/head.html" -->',
        "shtml",
        "server-side include directives",
      ],
      ["#!/usr/bin/env python3\nprint(1)\n", "py", "Python script source"],
      ["#!/usr/bin/perl -w\nuse strict;\n", "cgi", "Perl script source"],
      [ZIP, "php", "ZIP archive"],
      [Bun.gzipSync(new TextEncoder().encode("x")), "php", "gzip archive"],
      [SWAP, "php", "Vim swap file"],
      ["-- MySQL dump 10.13\nCREATE TABLE `u` (id int);\n", "php", "SQL dump"],
    ];
    for (const [body, ext, type] of cases) {
      expect(classifyBackup(answer(body), ext)?.contentType).toBe(type);
    }
  });

  test("a rendered page, plain text or an empty body is not a backup", () => {
    for (const body of [
      SPA_SHELL,
      "Page not found",
      "",
      "<p>Use &lt;?php to start</p>",
    ]) {
      expect(classifyBackup(answer(body), "php")).toBeNull();
    }
    // A bare `<% %>` block is read only for an ASP or JSP file.
    expect(classifyBackup(answer("<p><% x %></p>"), "php")).toBeNull();
  });
});

describe("security/exposed-backups probing", () => {
  test("a reachable copy is reported with its URL, source file and inferred content type, never its contents", async () => {
    const site = serve({ "/shop/cart.php.bak": text(PHP_SOURCE) });
    const checks = await run(ctx(site.origin, ["/shop/cart.php"]));
    const hit = checks.find((c) => c.name === "exposed-backups")!;
    expect(hit.status).toBe("fail");
    expect(hit.message).toContain(`${site.origin}/shop/cart.php.bak`);
    expect(hit.message).toContain("PHP source");
    expect(hit.items?.[0]).toMatchObject({
      id: `${site.origin}/shop/cart.php.bak`,
      meta: {
        path: "/shop/cart.php.bak",
        source: "/shop/cart.php",
        contentType: "PHP source",
        kind: "source",
        status: 200,
      },
    });
    expect(JSON.stringify(checks)).not.toContain(DB_SECRET_VALUE);
    // Every candidate of the file, then one baseline for the hit's shape.
    expect(site.seen.slice(0, 1)).toEqual(["GET /shop/cart.php.bak"]);
    expect(site.seen).toHaveLength(BACKUP_PROBES_PER_FILE + 1);
    expect(
      site.seen.filter((s) => s.includes("squirrelscan-baseline-"))
    ).toEqual([
      expect.stringMatching(
        /^GET \/shop\/squirrelscan-baseline-[0-9a-f]{16}\.php\.bak$/
      ),
    ]);
  });

  test("a zip archive and a Vim swap file are both reported", async () => {
    const site = serve({
      "/cart.php.zip": bytes(ZIP, "application/zip"),
      "/.cart.php.swp": bytes(SWAP),
    });
    const checks = await run(ctx(site.origin, ["/cart.php"]));
    expect(
      checks
        .filter((c) => c.name === "exposed-backups")
        .map((c) => c.details?.contentType)
        .sort()
    ).toEqual(["Vim swap file", "ZIP archive"]);
  });

  test("a crawled path starting with // is probed on the audited origin, and other files are still reported", async () => {
    const site = serve({ "/cart.php.bak": text(PHP_SOURCE) });
    const checks = await run(
      ctx(site.origin, ["//other.example.com/x.php", "/cart.php"])
    );
    expect(
      checks
        .filter((c) => c.name === "exposed-backups")
        .map((c) => c.details?.path)
    ).toEqual(["/cart.php.bak"]);
    // Sent to the audited server (Bun collapses the leading "//" on the wire).
    expect(
      site.seen.some((s) => s.endsWith("/other.example.com/x.php.bak"))
    ).toBe(true);
    expect(
      buildBackupProbe("https://example.com", "//other.example.com/x.php.bak")
        .url
    ).toBe("https://example.com//other.example.com/x.php.bak");
  });

  test("only paths derived from crawled files are requested, and never another origin", async () => {
    const other = serve({}, () => new Response(PHP_SOURCE));
    const site = serve({});
    const paths = ["/a.php", "/dir/b.aspx", "/c.html", "/d"];
    const checks = await run(
      ctx(site.origin, paths, { extraUrls: [`${other.origin}/admin.php`] })
    );
    expect(site.seen).toEqual(expectedPaths(paths, site.origin));
    expect(site.seen).toHaveLength(2 * BACKUP_PROBES_PER_FILE);
    expect(other.seen).toEqual([]);
    expect(checks).toEqual([
      expect.objectContaining({ name: "exposed-backups-none", status: "pass" }),
    ]);
  });

  test("a catch-all that answers every path with the same source is dropped by the baseline", async () => {
    const site = serve({}, text(PHP_SOURCE));
    const checks = await run(ctx(site.origin, ["/cart.php"]));
    expect(checks.some((c) => c.name === "exposed-backups")).toBe(false);
    expect(checks).toEqual([
      expect.objectContaining({
        name: "exposed-backups-none",
        details: expect.objectContaining({ catchAll: BACKUP_PROBES_PER_FILE }),
      }),
    ]);
  });

  test("a catch-all that serves a different archive for every zip is dropped by the baseline", async () => {
    let n = 0;
    const site = serve({}, (req) =>
      new URL(req.url).pathname.endsWith(".zip")
        ? new Response(new Uint8Array([...ZIP, n++]))
        : NOT_FOUND()
    );
    const checks = await run(ctx(site.origin, ["/cart.php"]));
    expect(checks.some((c) => c.name === "exposed-backups")).toBe(false);
  });

  test("an SPA or themed 404 served with 200 for every path is not reported and sends no baseline", async () => {
    const site = serve({}, text(SPA_SHELL, "text/html"));
    const checks = await run(ctx(site.origin, ["/cart.php"]));
    expect(checks.map((c) => c.name)).toEqual(["exposed-backups-none"]);
    expect(site.seen.some((s) => s.includes("baseline"))).toBe(false);
  });

  test("a redirect is never followed and is not a hit", async () => {
    const other = serve({}, text(PHP_SOURCE));
    const site = serve(
      {},
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `${other.origin}/x.php.bak` },
        })
    );
    const checks = await run(ctx(site.origin, ["/cart.php"]));
    expect(other.seen).toEqual([]);
    expect(checks).toEqual([
      expect.objectContaining({
        name: "exposed-backups-none",
        details: expect.objectContaining({
          redirected: BACKUP_PROBES_PER_FILE,
        }),
      }),
    ]);
  });

  test("below aggressive, or with no probe budget, nothing is sent and the check says how to enable it", async () => {
    const site = serve({ "/cart.php.bak": text(PHP_SOURCE) });
    for (const opts of [
      { level: "passive" as const },
      { level: "active" as const },
      { noProbe: true },
    ]) {
      const checks = await run(ctx(site.origin, ["/cart.php"], opts));
      expect(checks).toEqual([
        expect.objectContaining({
          name: "exposed-backups-not-checked",
          status: "skipped",
          skipReason: "probe-level-too-low",
        }),
      ]);
    }
    expect(site.seen).toEqual([]);
  });

  test("requests are hard-capped per audit, baselines included", async () => {
    // Every file in its own directory, every sibling a real copy: each hit
    // needs its own baseline, so the run reaches the cap.
    const paths = Array.from(
      { length: MAX_BACKUP_SOURCE_FILES + 3 },
      (_, i) => `/d${i}/page.php`
    );
    const site = serve({}, (req) =>
      req.url.includes("squirrelscan-baseline-")
        ? NOT_FOUND()
        : text(PHP_SOURCE)()
    );
    const checks = await run(ctx(site.origin, paths));
    expect(site.seen).toHaveLength(MAX_BACKUP_PROBES);
    expect(site.seen.every((s) => /^GET \/d\d+\//.test(s))).toBe(true);
    // No file beyond the per-audit file cap is touched.
    expect(
      site.seen.some((s) => s.startsWith(`GET /d${MAX_BACKUP_SOURCE_FILES}/`))
    ).toBe(false);
    expect(
      checks.find((c) => c.name === "exposed-backups-incomplete")
    ).toMatchObject({
      status: "skipped",
      skipReason: "probe-incomplete",
      details: { stoppedBy: "cap" },
    });
    expect(
      checks.filter((c) => c.name === "exposed-backups").length
    ).toBeGreaterThan(0);
    expect(BACKUP_SIBLINGS.length).toBeGreaterThanOrEqual(
      BACKUP_PROBES_PER_FILE
    );
  });

  test("the shared probe budget running out makes the run incomplete", async () => {
    let t = 0;
    const site = serve({}, () => {
      t += 400;
      return NOT_FOUND();
    });
    const checks = await run(
      ctx(site.origin, ["/cart.php"], { budgetMs: 1000, now: () => t })
    );
    expect(site.seen.length).toBeLessThan(BACKUP_PROBES_PER_FILE);
    expect(checks).toEqual([
      expect.objectContaining({
        name: "exposed-backups-incomplete",
        details: expect.objectContaining({ stoppedBy: "budget" }),
      }),
    ]);
  });

  test("a 429 stops further probes and the result says incomplete", async () => {
    const site = serve({
      "/cart.php~": () => new Response("slow down", { status: 429 }),
    });
    const checks = await run(ctx(site.origin, ["/cart.php", "/b.php"]));
    expect(site.seen).toEqual(["GET /cart.php.bak", "GET /cart.php~"]);
    const incomplete = checks.find(
      (c) => c.name === "exposed-backups-incomplete"
    )!;
    expect(incomplete.details?.stoppedBy).toBe("pushback");
    expect(incomplete.message).toContain("HTTP 429");
  });

  test("a hit whose baseline fails is not reported and the run is incomplete", async () => {
    const site = serve({ "/cart.php.bak": text(PHP_SOURCE) }, (req) =>
      req.url.includes("squirrelscan-baseline-")
        ? new Response("oops", { status: 503 })
        : NOT_FOUND()
    );
    const checks = await run(ctx(site.origin, ["/cart.php"]));
    expect(checks.some((c) => c.name === "exposed-backups")).toBe(false);
    expect(checks).toEqual([
      expect.objectContaining({
        name: "exposed-backups-incomplete",
        details: expect.objectContaining({ stoppedBy: "unconfirmed" }),
      }),
    ]);
  });

  test("no crawled server-side file: a pass and no request", async () => {
    const site = serve({});
    const checks = await run(
      ctx(site.origin, ["/", "/about.html", "/blog/post"])
    );
    expect(checks).toEqual([
      expect.objectContaining({ name: "exposed-backups-none", status: "pass" }),
    ]);
    expect(site.seen).toEqual([]);
  });

  test("squirrel analyze (no request tool) sends nothing", async () => {
    const site = serve({ "/cart.php.bak": text(PHP_SOURCE) });
    clearRequestAsync();
    try {
      const checks = await run(ctx(site.origin, ["/cart.php"]));
      expect(checks).toEqual([
        expect.objectContaining({ skipReason: "analyze-offline" }),
      ]);
      expect(site.seen).toEqual([]);
    } finally {
      setRequestAsync(() => Promise.reject(new Error("unused")));
    }
  });
});
