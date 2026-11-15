// security/exposed-files (#1932): a curated sensitive-file probe that runs only
// at aggressive, confirms a hit by content signature, drops catch-all 200s
// against a random-path baseline, never follows a redirect, stops on a 429 and
// never echoes a file's contents. Every test runs the rule against real
// fixture servers on localhost.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { createProbeBudget, type ProbeLevel } from "../src/probe-budget";
import { SENSITIVE_FILES } from "../src/security/exposed-files-allowlist";
import { confirmHit, exposedFilesRule } from "../src/security/exposed-files";
import { clearRequestAsync, setRequestAsync } from "../src/tools";
import type { CheckResult, RuleContext } from "../src/types";

type Handler = (req: Request) => Response | Promise<Response>;

interface Fixture {
  origin: string;
  /** "METHOD /path" for every request the server received. */
  seen: string[];
  stop: () => void;
}

const servers: Fixture[] = [];

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
      return fallback
        ? fallback(req)
        : new Response("<!doctype html><title>Not found</title>", {
            status: 404,
            headers: { "content-type": "text/html" },
          });
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
  opts: { level?: ProbeLevel; noProbe?: boolean; budgetMs?: number; now?: () => number } = {},
): RuleContext {
  return {
    page: { url: `${origin}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as RuleContext["parsed"],
    site: { baseUrl: `${origin}/`, pages: [], robotsTxt: null, sitemaps: null },
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
  return (await exposedFilesRule.run(c)).checks;
}

const text =
  (body: string, type = "text/plain") =>
  () =>
    new Response(body, { headers: { "content-type": type } });
const bytes =
  (b: Uint8Array<ArrayBuffer>, type = "application/octet-stream") =>
  () =>
    new Response(b, { headers: { "content-type": type } });

const ENV_SECRETS = [
  "sk_live_51HxQe2SECRETVALUE",
  "postgres://admin:hunter2@db.internal/app",
  "AKIAEXAMPLEKEY12345",
];

const DS_STORE = new Uint8Array([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31, 0, 0, 0x10, 0, 0, 0, 0x08, 0]);
const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0x08, 0]);
const GZIP = Bun.gzipSync(new TextEncoder().encode("site backup"));

/** A fixture for every path on the list, each answering with its real signature. */
const EXPOSED: Record<string, Handler> = {
  "/.git/HEAD": text("ref: refs/heads/main\n"),
  "/.git/config": text(
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n[remote "origin"]\n\turl = https://token@github.com/acme/site.git\n',
  ),
  "/.svn/entries": text("12\n"),
  "/.hg/requires": text("dotencode\nfncache\ngeneraldelta\nrevlogv1\nstore\n"),
  "/.env": text(
    `# app\nSTRIPE_SECRET_KEY=${ENV_SECRETS[0]}\nDATABASE_URL=${ENV_SECRETS[1]}\nexport AWS_ACCESS_KEY_ID=${ENV_SECRETS[2]}\nAPP_NAME=shop\n`,
  ),
  "/.env.local": text("NEXT_PUBLIC_SITE=shop\nAPI_TOKEN=abc123\n"),
  "/config.php.bak": text("<?php\n$db_host = 'localhost';\n$db_password = 'pw';\n"),
  "/wp-config.php.bak": text("<?php\ndefine( 'DB_NAME', 'wp' );\ndefine( 'DB_PASSWORD', 'pw' );\n"),
  "/appsettings.json": text(
    '{\n  "ConnectionStrings": { "Default": "Server=db;Password=pw" },\n  "Logging": {}\n}',
    "application/json",
  ),
  "/server-status": text(
    "<html><head><title>Apache Status</title></head><body><h1>Apache Server Status for example</h1><dl><dt>Server Version: Apache/2.4</dt></dl></body></html>",
    "text/html",
  ),
  "/server-info": text(
    "<html><body><h1>Apache Server Information</h1><h2>Server Settings</h2></body></html>",
    "text/html",
  ),
  "/phpinfo.php": text(
    "<!DOCTYPE html><html><head><title>PHP 8.2.1 - phpinfo()</title></head><body><h1>PHP Version 8.2.1</h1></body></html>",
    "text/html",
  ),
  "/.htaccess": text(
    "# protect\nRewriteEngine On\nRewriteRule ^admin - [F]\nAuthType Basic\nAuthUserFile /var/www/.htpasswd\nRequire valid-user\n",
  ),
  "/web.config": text(
    '<?xml version="1.0"?>\n<configuration>\n  <connectionStrings><add name="db" connectionString="pw" /></connectionStrings>\n  <system.webServer></system.webServer>\n</configuration>',
    "application/xml",
  ),
  "/.DS_Store": bytes(DS_STORE),
  "/Thumbs.db": bytes(OLE),
  "/backup.zip": bytes(ZIP, "application/zip"),
  "/site.tar.gz": bytes(GZIP, "application/gzip"),
  "/db.sql": text(
    "-- MySQL dump 10.13\n--\nCREATE TABLE `users` (id int);\nINSERT INTO `users` VALUES (1);\n",
  ),
  "/dump.sql": text(
    "-- PostgreSQL database dump\n\nSET client_encoding = 'UTF8';\nCREATE TABLE public.users (id integer);\n",
  ),
};

const SPA_SHELL =
  '<!doctype html><html><head><title>Shop</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

describe("security/exposed-files", () => {
  test("the fixtures cover every listed path", () => {
    expect(Object.keys(EXPOSED).sort()).toEqual(SENSITIVE_FILES.map((f) => f.path).sort());
  });

  test("each signature is confirmed and reported with what it reveals", async () => {
    const site = serve(EXPOSED);
    const checks = await run(ctx(site.origin));
    const hits = checks.filter((c) => c.name === "exposed-files");
    expect(hits.map((c) => c.details?.path).sort()).toEqual(
      SENSITIVE_FILES.map((f) => f.path).sort(),
    );
    for (const file of SENSITIVE_FILES) {
      const check = hits.find((c) => c.details?.path === file.path)!;
      expect(check.status).toBe(file.severity === "high" ? "fail" : "warn");
      expect(check.message).toContain(`${site.origin}${file.path}`);
      expect(check.message).toContain(file.reveals);
      expect(check.items?.[0]).toMatchObject({
        id: `${site.origin}${file.path}`,
        meta: { path: file.path, status: 200, signature: file.signature, reveals: file.reveals },
      });
    }
    // No clean or incomplete line beside the hits.
    expect(checks.filter((c) => c.name !== "exposed-files")).toEqual([]);
  });

  test("a .env hit counts variables and contains no value from the file", async () => {
    const site = serve({ "/.env": EXPOSED["/.env"]! });
    const checks = await run(ctx(site.origin));
    const env = checks.find((c) => c.details?.path === "/.env")!;
    expect(env.status).toBe("fail");
    expect(env.message).toContain("4 variable(s), 3 with secret-looking names");
    const serialized = JSON.stringify(checks);
    for (const secret of [...ENV_SECRETS, "hunter2", "shop"])
      expect(serialized).not.toContain(secret);
    // Names are not echoed either: the finding carries counts only.
    expect(serialized).not.toContain("STRIPE_SECRET_KEY");
  });

  test("only GET is sent, and no Actuator path is requested (security/exposed-actuator owns those)", async () => {
    const site = serve(EXPOSED);
    await run(ctx(site.origin));
    const methods = new Set(site.seen.map((r) => r.split(" ")[0]));
    expect([...methods]).toEqual(["GET"]);
    expect(site.seen.some((r) => r.includes("/actuator"))).toBe(false);
    expect(SENSITIVE_FILES).toHaveLength(20);
    // The baseline first, then one request per listed path, nothing else.
    expect(site.seen[0]).toMatch(/^GET \/\.squirrelscan-baseline-[0-9a-f]{16}$/);
    expect(site.seen).toHaveLength(SENSITIVE_FILES.length + 1);
  });

  test("an SPA that answers every path with its shell (200) is not reported", async () => {
    const site = serve({}, text(SPA_SHELL, "text/html; charset=utf-8"));
    const checks = await run(ctx(site.origin));
    expect(checks.filter((c) => c.name === "exposed-files")).toEqual([]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "exposed-files-none", status: "pass" });
  });

  test("a themed 404 page served with 200 is not reported", async () => {
    const themed = text(
      "<!DOCTYPE html><html><head><title>Page not found</title></head><body><h1>Oops! We can't find that page.</h1><p>Server Version: n/a</p></body></html>",
      "text/html",
    );
    const site = serve({}, themed);
    const checks = await run(ctx(site.origin));
    expect(checks.filter((c) => c.name === "exposed-files")).toEqual([]);
    expect(checks[0]).toMatchObject({ name: "exposed-files-none", status: "pass" });
  });

  test("a catch-all that serves the same plain text for every path matches the baseline and is dropped", async () => {
    // Plain text that even looks like a .env and a git HEAD: the baseline path gets it too.
    const site = serve({}, text("ref: refs/heads/main\n"));
    const checks = await run(ctx(site.origin));
    expect(checks.filter((c) => c.name === "exposed-files")).toEqual([]);
    const envLike = serve({}, text("MODE=prod\n"));
    const envChecks = await run(ctx(envLike.origin));
    expect(envChecks.filter((c) => c.name === "exposed-files")).toEqual([]);
  });

  test("a redirect to another origin is never followed and is not a hit", async () => {
    const other = serve(EXPOSED);
    const site = serve({
      "/.env": () => Response.redirect(`${other.origin}/.env`, 302),
      "/.git/HEAD": () =>
        new Response(null, { status: 301, headers: { location: `${other.origin}/.git/HEAD` } }),
    });
    const checks = await run(ctx(site.origin));
    expect(other.seen).toEqual([]);
    expect(checks.filter((c) => c.name === "exposed-files")).toEqual([]);
    expect(checks[0]).toMatchObject({ name: "exposed-files-none", details: { redirected: 2 } });
  });

  test("below aggressive, or with no probe budget, nothing is sent and the check says how to enable it", async () => {
    const site = serve(EXPOSED);
    for (const opts of [
      { level: "passive" as const },
      { level: "active" as const },
      { noProbe: true },
    ]) {
      const checks = await run(ctx(site.origin, opts));
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        name: "exposed-files-not-checked",
        status: "skipped",
        skipReason: "probe-level-too-low",
        value: "not-checked",
      });
      expect(checks[0]!.message).toContain("--probe aggressive");
    }
    expect(site.seen).toEqual([]);
  });

  test("a 429 mid-run stops further probes and the result says incomplete", async () => {
    const site = serve({
      "/.git/HEAD": EXPOSED["/.git/HEAD"]!,
      "/.svn/entries": () => new Response("slow down", { status: 429 }),
    });
    const checks = await run(ctx(site.origin));
    // Baseline, .git/HEAD, .git/config, then the 429: nothing after it.
    expect(site.seen.slice(1)).toEqual(["GET /.git/HEAD", "GET /.git/config", "GET /.svn/entries"]);
    expect(checks.find((c) => c.name === "exposed-files")?.details?.path).toBe("/.git/HEAD");
    const incomplete = checks.find((c) => c.name === "exposed-files-incomplete")!;
    expect(incomplete).toMatchObject({
      status: "skipped",
      skipReason: "probe-incomplete",
      details: { stoppedBy: "pushback" },
    });
    expect(incomplete.message).toContain("HTTP 429");
    expect(checks.some((c) => c.name === "exposed-files-none")).toBe(false);
  });

  test("a bot challenge on the baseline stops the run before any listed path", async () => {
    const site = serve(
      {},
      () =>
        new Response("<html><title>Just a moment...</title></html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    );
    const checks = await run(ctx(site.origin));
    expect(site.seen).toHaveLength(1);
    expect(checks).toEqual([
      expect.objectContaining({ name: "exposed-files-incomplete", skipReason: "probe-incomplete" }),
    ]);
  });

  test("a 403 JSON from the app on every path is protected: a pass (#1920)", async () => {
    const site = serve(
      {},
      () =>
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json", server: "cloudflare" },
        }),
    );
    const checks = await run(ctx(site.origin));
    expect(site.seen).toHaveLength(SENSITIVE_FILES.length + 1);
    expect(checks).toEqual([
      expect.objectContaining({ name: "exposed-files-none", status: "pass" }),
    ]);
  });

  test("a 403 carrying WAF markers is a challenge: not checked, never a pass (#1920)", async () => {
    const site = serve(
      { "/.git/HEAD": EXPOSED["/.git/HEAD"]! },
      () => new Response("Access Denied", { status: 403, headers: { "x-sucuri-id": "18012" } }),
    );
    const checks = await run(ctx(site.origin));
    // The baseline is challenged: nothing listed is requested.
    expect(site.seen).toHaveLength(1);
    expect(checks).toEqual([
      expect.objectContaining({
        name: "exposed-files-incomplete",
        skipReason: "probe-incomplete",
        details: expect.objectContaining({
          stoppedBy: "pushback",
          unverified: SENSITIVE_FILES.length,
        }),
      }),
    ]);
  });

  test("partial: a confirmed hit is reported and the 5xx paths are counted as not verified (#1920)", async () => {
    const site = serve({
      "/.git/HEAD": EXPOSED["/.git/HEAD"]!,
      "/.env": () => new Response("upstream failed", { status: 502 }),
      "/backup.zip": () => new Response("upstream failed", { status: 500 }),
    });
    const checks = await run(ctx(site.origin));
    expect(site.seen).toHaveLength(SENSITIVE_FILES.length + 1);
    expect(checks.find((c) => c.name === "exposed-files")?.details?.path).toBe("/.git/HEAD");
    const incomplete = checks.find((c) => c.name === "exposed-files-incomplete")!;
    expect(incomplete).toMatchObject({
      status: "skipped",
      value: "not-checked",
      details: { serverErrors: 2, unverified: 2, stoppedBy: "server-errors" },
    });
    expect(incomplete.message).toContain(
      `2 of ${SENSITIVE_FILES.length} path(s) were not verified`,
    );
    expect(checks.some((c) => c.name === "exposed-files-none")).toBe(false);
  });

  test("the shared probe budget running out makes the run incomplete", async () => {
    let t = 0;
    const site = serve({}, () => {
      t += 400;
      return new Response("nope", { status: 404 });
    });
    const checks = await run(ctx(site.origin, { budgetMs: 1000, now: () => t }));
    expect(site.seen.length).toBeLessThan(SENSITIVE_FILES.length + 1);
    expect(checks).toEqual([
      expect.objectContaining({
        name: "exposed-files-incomplete",
        details: expect.objectContaining({ stoppedBy: "budget" }),
      }),
    ]);
  });

  test("squirrel analyze (no request tool) sends nothing", async () => {
    const site = serve(EXPOSED);
    clearRequestAsync();
    try {
      const checks = await run(ctx(site.origin));
      expect(checks).toEqual([expect.objectContaining({ skipReason: "analyze-offline" })]);
      expect(site.seen).toEqual([]);
    } finally {
      setRequestAsync(() => Promise.reject(new Error("unused")));
    }
  });

  test("a body that is only HTML never matches a text signature, and a non-2xx never matches", () => {
    const answer = (body: string, status = 200, contentType = "text/plain") => {
      const b = new TextEncoder().encode(body);
      return { status, contentType, headers: new Headers(), bytes: b, text: body };
    };
    const env = SENSITIVE_FILES.find((f) => f.path === "/.env")!;
    expect(confirmHit(env, answer("A=1\n"), null)).not.toBeNull();
    expect(confirmHit(env, answer("A=1\n", 403), null)).toBeNull();
    expect(confirmHit(env, answer("<html><body>A=1</body></html>"), null)).toBeNull();
    expect(confirmHit(env, answer("A=1\n", 200, "text/html"), null)).toBeNull();
    // Identical bytes on the baseline path: a catch-all.
    expect(confirmHit(env, answer("A=1\n"), answer("A=1\n"))).toBeNull();
    // A 404 baseline does not suppress a real hit.
    expect(confirmHit(env, answer("A=1\n"), answer("A=1\n", 404))).not.toBeNull();
  });
});
