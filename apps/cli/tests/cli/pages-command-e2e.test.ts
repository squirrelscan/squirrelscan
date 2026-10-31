// `squirrel pages` (#701), end to end against a local site: one audit, then the page map read back
// from the store in every format and with the filters. One scratch HOME.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-pages-"));
const home = join(scratch, "home");

const page = (
  title: string | null,
  extra = "",
  description:
    | string
    | null = "A page about things that is long enough to read as a description of it."
) =>
  `<!doctype html><html lang="en"><head>${title === null ? "" : `<title>${title}</title>`}${description === null ? "" : `<meta name="description" content="${description}">`}</head><body><h1>Heading</h1><p>${"Words ".repeat(120)}</p>${extra}</body></html>`;

const SAME = "A title that two different pages share word for word";
// Every page but `/lonely` links to every other one, so only `/lonely` is an orphan.
const NAV = ["/", "/a", "/b", "/dup1", "/dup2", "/blog/post"];
const nav = (self: string) =>
  NAV.filter((p) => p !== self)
    .map((p) => `<a href="${p}">${p}</a>`)
    .join(" ");

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname, origin } = new URL(req.url);
    const html = (body: string) =>
      new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    switch (pathname) {
      case "/":
        return html(
          page(
            "Home of the page map test site",
            `${nav("/")} <a href="https://elsewhere.example/x">out</a>`
          )
        );
      case "/a":
        return html(page(null, nav("/a")));
      case "/b":
        return html(page("Page B of the page map test site", nav("/b"), null));
      case "/dup1":
      case "/dup2":
        return html(page(SAME, nav(pathname)));
      case "/blog/post":
        return html(
          page("A blog post on the page map test site", nav("/blog/post"))
        );
      case "/sitemap.xml":
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
            "",
            "a",
            "b",
            "dup1",
            "dup2",
            "blog/post",
            "lonely",
          ]
            .map((p) => `<url><loc>${origin}/${p}</loc></url>`)
            .join("")}</urlset>`,
          { headers: { "content-type": "application/xml" } }
        );
      case "/robots.txt":
        return new Response(
          `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
          {
            headers: { "content-type": "text/plain" },
          }
        );
      case "/lonely":
        // A hostile title and description: terminal escapes, a hyperlink, a bidi override, a newline
        // and a spreadsheet formula, none of which may reach a terminal, a sheet or a viewer.
        return html(
          page(
            `Lonely\u001b[2J\u001b]8;;https://evil.example\u0007click\u202egnp.exe\nsecond line`,
            "",
            "=cmd|' /C calc'!A0"
          )
        );
      default:
        return new Response("not found", { status: 404 });
    }
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

function env(): Record<string, string> {
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

async function squirrel(...args: string[]) {
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], {
    env: env(),
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

interface Row {
  url: string;
  finalUrl: string;
  status: number;
  title: string | null;
  titleLength: number;
  descriptionLength: number;
  h1Count: number | null;
  wordCount: number | null;
  schemaTypes: string[];
  inlinks: number;
  internalOutlinks: number;
  externalOutlinks: number;
  externalDomains: string[];
  flags: string[];
}
interface PageMapJson {
  site: string;
  crawlId: string;
  total: number;
  filtered: number;
  pages: Row[];
}

const paths = (rows: Row[]) => rows.map((r) => new URL(r.url).pathname).sort();
const asJson = async (...args: string[]): Promise<PageMapJson> => {
  const r = await squirrel("pages", "-f", "json", ...args);
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as PageMapJson;
};

beforeAll(async () => {
  const r = await squirrel(
    "audit",
    `http://127.0.0.1:${site.port}/`,
    "--offline",
    "--http",
    "-m",
    "20",
    "-f",
    "json",
    "-o",
    join(scratch, "audit.json")
  );
  expect([0, 1]).toContain(r.code);
}, 180_000);

describe("squirrel pages", () => {
  test("lists every crawled page with the stored columns", async () => {
    const map = await asJson();
    expect(map.total).toBe(map.pages.length);
    expect(map.filtered).toBe(map.total);
    expect(paths(map.pages)).toEqual([
      "/",
      "/a",
      "/b",
      "/blog/post",
      "/dup1",
      "/dup2",
      "/lonely",
    ]);
    const home = map.pages.find((r) => new URL(r.url).pathname === "/")!;
    expect(home).toMatchObject({
      status: 200,
      title: "Home of the page map test site",
      h1Count: 1,
    });
    expect(home.titleLength).toBe("Home of the page map test site".length);
    expect(home.descriptionLength).toBeGreaterThan(20);
    expect(home.wordCount).toBeGreaterThan(100);
    // Five internal links out (every page but itself and the lonely one), one external.
    expect(home.internalOutlinks).toBe(5);
    expect(home.externalOutlinks).toBe(1);
    expect(home.externalDomains).toEqual(["elsewhere.example"]);
    // Every linked page is linked from the other five; the page nobody links to has no inlinks.
    expect(home.inlinks).toBe(5);
    expect(
      map.pages.find((r) => new URL(r.url).pathname === "/lonely")!.inlinks
    ).toBe(0);
    expect(
      map.pages.find((r) => new URL(r.url).pathname === "/b")!.inlinks
    ).toBe(5);
  }, 120_000);

  test("--missing title, description and schema", async () => {
    expect(paths((await asJson("--missing", "title")).pages)).toEqual(["/a"]);
    expect(paths((await asJson("--missing", "description")).pages)).toEqual([
      "/b",
    ]);
    // No page declares schema.org types.
    expect((await asJson("--missing", "schema")).filtered).toBe(7);
  }, 120_000);

  test("--duplicate title names the pages the audit flags, --section and --page narrow by URL", async () => {
    expect(paths((await asJson("--duplicate", "title")).pages)).toEqual([
      "/dup1",
      "/dup2",
    ]);
    expect(paths((await asJson("--section", "/blog")).pages)).toEqual([
      "/blog/post",
    ]);
    expect(paths((await asJson("--page", "dup")).pages)).toEqual([
      "/dup1",
      "/dup2",
    ]);
    expect(
      paths((await asJson("--section", "/blog", "--missing", "title")).pages)
    ).toEqual([]);
  }, 120_000);

  test("--orphan names the page nothing links to", async () => {
    const map = await asJson("--orphan");
    expect(paths(map.pages)).toEqual(["/lonely"]);
    expect(map.pages[0]!.flags).toContain("orphan");
  }, 120_000);

  test("csv and markdown carry the same pages", async () => {
    const csv = await squirrel("pages", "-f", "csv");
    expect(csv.code).toBe(0);
    const lines = csv.out.trim().split("\n");
    expect(
      lines[0]!.startsWith("url,finalUrl,status,depth,canonical,noindex,title")
    ).toBe(true);
    expect(lines).toHaveLength(8);
    const md = await squirrel("pages", "-f", "markdown", "--section", "/blog");
    expect(md.code).toBe(0);
    expect(md.out).toContain("1 of 7 pages match");
    expect(md.out).toContain("/blog/post");
  }, 120_000);

  test("-o writes the file and says so on stderr; a pipe defaults to markdown", async () => {
    const file = join(scratch, "pages.csv");
    const r = await squirrel("pages", "-f", "csv", "-o", file);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`Wrote ${file}`);
    expect(readFileSync(file, "utf8").split("\n")[0]).toContain("url,finalUrl");
    const piped = await squirrel("pages");
    expect(piped.out).toContain("# Page map: ");
  }, 120_000);

  test("bad flag values are usage errors", async () => {
    const missing = await squirrel("pages", "--missing", "nonsense");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("--missing: unknown value nonsense");
    const dup = await squirrel("pages", "--duplicate", "h1");
    expect(dup.code).toBe(1);
    const fmt = await squirrel("pages", "-f", "xml");
    expect(fmt.code).toBe(1);
    expect(fmt.err).toContain('--format: unknown value "xml"');
  }, 120_000);

  test("an unknown crawl id is an answer, not a failure", async () => {
    const r = await squirrel("pages", "--crawl", "ffffffff");
    expect(r.code).toBe(0);
    expect(r.out).toContain("No audit found");
  }, 120_000);

  test("--crawl reads a named audit", async () => {
    const latest = await asJson();
    const named = await asJson("--crawl", latest.crawlId.slice(0, 8));
    expect(named.crawlId).toBe(latest.crawlId);
  }, 120_000);
});

describe("hostile page values (#701)", () => {
  const unsafe = (text: string): string[] =>
    [...text].filter((ch) => {
      const c = ch.charCodeAt(0);
      return (
        c === 27 ||
        c === 7 ||
        (c >= 0x80 && c <= 0x9f) ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069)
      );
    });

  test("csv and markdown carry no escape, control or bidi character from a page", async () => {
    for (const format of ["csv", "markdown"]) {
      const r = await squirrel("pages", "-f", format);
      expect(r.code).toBe(0);
      expect(unsafe(r.out)).toEqual([]);
      expect(r.out).toContain("Lonely");
    }
  }, 120_000);

  test("csv neutralises the formula in the description and keeps one record per page", async () => {
    const r = await squirrel("pages", "-f", "csv");
    expect(r.out).toContain("'=cmd|' /C calc'!A0");
    expect(r.out.split("\n").filter((l) => l.length > 0)).toHaveLength(8);
  }, 120_000);

  test("json is valid and keeps the page's own bytes", async () => {
    const map = await asJson();
    const lonely = map.pages.find((r) => new URL(r.url).pathname === "/lonely");
    expect(lonely?.title).toContain("Lonely");
    // The hostile bytes really are in the stored page, so the clean outputs above prove something.
    expect(lonely?.title).toContain(String.fromCharCode(27));
  }, 120_000);
});
