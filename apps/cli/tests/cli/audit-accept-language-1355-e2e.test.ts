// #1355: the crawler sends no Accept-Language of its own, and a page that
// redirected to another URL is not counted as a second page carrying that URL's
// description. The real CLI against a shop-like site whose locale paths redirect
// to /en only when the request carries Accept-Language.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-accept-language-"));
const html = { "content-type": "text/html; charset=utf-8" };

const page = (title: string, description: string, links = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${description}"></head><body><main><h1>${title}</h1><p>Copy for ${title} that is long enough to be a page.</p>${links}</main></body></html>`;

const seen: Array<{ path: string; acceptLanguage: string | null }> = [];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    const acceptLanguage = req.headers.get("accept-language");
    seen.push({ path: pathname, acceptLanguage });
    if (pathname === "/robots.txt")
      return new Response("User-agent: *\nAllow: /\n");
    if (pathname === "/") {
      return new Response(
        page(
          "Home",
          "The home page of the shop",
          `<a href="/de-ch">de</a> <a href="/fr-ch">fr</a> <a href="/en">en</a> <a href="/old">old</a>`
        ),
        { headers: html }
      );
    }
    // Locale redirection keyed on Accept-Language, as Shopify Markets does.
    if (pathname === "/de-ch" || pathname === "/fr-ch") {
      if (acceptLanguage)
        return new Response(null, {
          status: 302,
          headers: { location: "/en" },
        });
      return pathname === "/de-ch"
        ? new Response(
            page("Sattel Schweiz", "Beschreibung auf Deutsch fuer die Schweiz"),
            { headers: html }
          )
        : new Response(
            page("Selle Suisse", "Description en francais pour la Suisse"),
            { headers: html }
          );
    }
    if (pathname === "/old")
      return new Response(null, { status: 301, headers: { location: "/en" } });
    // A second shop where the redirect target is never linked, so never crawled:
    // /a2 carries /b2's text and /c2 repeats it. That is a real duplicate.
    if (pathname === "/shop2") {
      return new Response(
        page(
          "Shop two",
          "The second shop",
          `<a href="/a2">a</a> <a href="/c2">c</a>`
        ),
        { headers: html }
      );
    }
    if (pathname === "/a2")
      return new Response(null, { status: 301, headers: { location: "/b2" } });
    if (pathname === "/b2" || pathname === "/c2") {
      return new Response(
        page("Shared title two", "A description both pages share verbatim"),
        { headers: html }
      );
    }
    if (pathname === "/en") {
      return new Response(
        page("Saddle shop", "English description of the saddle shop"),
        { headers: html }
      );
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
});

let runs = 0;
async function audit(toml?: string, start = "/") {
  const dir = join(scratch, `run-${++runs}`);
  mkdirSync(dir, { recursive: true });
  if (toml) writeFileSync(join(dir, "squirrel.toml"), toml);
  const out = join(dir, "report.json");
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      `http://127.0.0.1:${server.port}${start}`,
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
      cwd: dir,
      env: {
        ...process.env,
        HOME: join(dir, "home"),
        SQUIRREL_NO_UPDATE: "1",
        NO_TELEMETRY: "1",
        NO_COLOR: "1",
        SQUIRREL_CONTENT_STORE_PATH: undefined,
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
  if (code !== 0) throw new Error(`audit exited ${code}\n${stderr}`);
  return JSON.parse(readFileSync(out, "utf8")) as {
    issues: Array<{ ruleId: string }>;
  };
}

describe("a default crawl sends no Accept-Language", () => {
  test("no request carries it, the locale paths are real pages, and nothing is a duplicate", async () => {
    const report = await audit();
    expect(seen.filter((r) => r.acceptLanguage !== null)).toEqual([]);
    // /de-ch and /fr-ch were served in their own language, so they were crawled as pages.
    expect(seen.map((r) => r.path)).toContain("/de-ch");
    expect(report.issues.map((i) => i.ruleId)).not.toContain(
      "content/duplicate-description"
    );
    expect(report.issues.map((i) => i.ruleId)).not.toContain(
      "content/duplicate-title"
    );
  }, 120_000);
});

describe("an Accept-Language set in [crawler] headers is still sent", () => {
  test("it is on every page request, and the redirected locale paths are not duplicates of /en", async () => {
    const report = await audit(
      '[crawler]\nheaders = { "Accept-Language" = "en-US" }\n'
    );
    // The crawl's own page requests (the start page is also fetched by probes that
    // vary the client on purpose, so it is only required to appear with the header).
    const pageRequests = seen.filter((r) =>
      ["/de-ch", "/fr-ch", "/en"].includes(r.path)
    );
    expect(pageRequests.length).toBeGreaterThan(0);
    expect(pageRequests.filter((r) => r.acceptLanguage !== "en-US")).toEqual(
      []
    );
    expect(
      seen.some((r) => r.path === "/" && r.acceptLanguage === "en-US")
    ).toBe(true);
    // /de-ch, /fr-ch and /old all redirect to /en: one page carries that description.
    expect(report.issues.map((i) => i.ruleId)).not.toContain(
      "content/duplicate-description"
    );
    expect(report.issues.map((i) => i.ruleId)).not.toContain(
      "content/duplicate-title"
    );
  }, 120_000);
});

describe("a redirect whose target was never crawled does not hide a duplicate", () => {
  test("/a2 redirects to /b2 (never linked) and /c2 repeats /b2's text: the duplicate is reported", async () => {
    const report = await audit(undefined, "/shop2");
    expect(report.issues.map((i) => i.ruleId)).toContain(
      "content/duplicate-description"
    );
  }, 120_000);
});
