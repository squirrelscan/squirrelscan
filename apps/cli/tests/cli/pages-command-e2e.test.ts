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
// `/b?id=1` and `/blog/post/` are stored with their query string and trailing slash: their link counts
// must still be found (#701).
// `/items?id=1` and `/items?id=2` are two pages that differ only by query string: each keeps its own
// out-links, and they share one `inlinks` count (the rules key links without the query string).
// The site changes between the two audits the --diff tests compare: `phase` 2 gives /a a title,
// /b a description, takes /dup2 down and adds /fresh.
let phase = 1;
const navPaths = () => [
  "/",
  "/a",
  "/b?id=1",
  "/dup1",
  "/dup2",
  "/blog/post/",
  "/items?id=1",
  "/items?id=2",
  ...(phase === 2 ? ["/fresh"] : []),
];
const nav = (self: string) =>
  navPaths()
    .filter((p) => p !== self)
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
        return html(
          page(
            phase === 2 ? "Page A now has a title of its own" : null,
            nav("/a")
          )
        );
      case "/b":
        return html(
          page(
            "Page B of the page map test site",
            nav("/b?id=1"),
            phase === 2
              ? "Page B now has a description that is long enough to read as one."
              : null
          )
        );
      case "/dup2":
        if (phase === 2) return new Response("gone", { status: 404 });
      // falls through
      case "/dup1":
        return html(page(SAME, nav(pathname)));
      case "/fresh":
        return html(page("A page added between the two audits", nav("/fresh")));
      case "/blog/post/":
        return html(
          page("A blog post on the page map test site", nav("/blog/post/"))
        );
      case "/items": {
        // A self link, a link to the post, and two external hosts: Out is 1 (the self link is not a
        // link out) and Ext is 2 on each variant, however many variants there are.
        const self = `/items${new URL(req.url).search}`;
        return html(
          page(
            `Item ${new URL(req.url).searchParams.get("id")} of the page map test site`,
            `<a href="${self}">self</a> <a href="/blog/post/">post</a> <a href="https://ext-a.example/x">a</a> <a href="https://ext-b.example/y">b</a>`
          )
        );
      }
      case "/sitemap.xml":
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
            "",
            "a",
            "b?id=1",
            "dup1",
            "dup2",
            "blog/post/",
            "items?id=1",
            "items?id=2",
            "lonely",
            ...(phase === 2 ? ["fresh"] : []),
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
  h1: string | null;
  headingCount: number | null;
  schemaIds: string[];
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
      "/blog/post/",
      "/dup1",
      "/dup2",
      "/items",
      "/items",
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
    // Seven internal links out (every page but itself and the lonely one, both item variants), one external.
    expect(home.internalOutlinks).toBe(7);
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

  test("pages stored with a trailing slash or a query string still get their link counts (#701)", async () => {
    const map = await asJson();
    const at = (path: string) =>
      map.pages.find((r) => new URL(r.url).pathname === path)!;
    // Linked from the other pages of the nav (and both item pages for the post), however the URL is spelled.
    expect(at("/blog/post/").inlinks).toBe(7);
    expect(at("/b").inlinks).toBe(5);
    expect(at("/blog/post/").internalOutlinks).toBe(7);
    expect(at("/b").internalOutlinks).toBe(7);
    // And the audit's own orphan rule agrees: neither is flagged.
    expect(at("/blog/post/").flags).not.toContain("orphan");
    expect(at("/b").flags).not.toContain("orphan");
  }, 120_000);

  test("query-string variants keep their own out-links and share an in-link count, and a self link is no link (#701)", async () => {
    const map = await asJson();
    const items = map.pages.filter((r) => new URL(r.url).pathname === "/items");
    expect(items).toHaveLength(2);
    for (const item of items) {
      // The post only: the self link is skipped, and the other variant's counts are not added in.
      expect(item.internalOutlinks).toBe(1);
      expect(item.externalOutlinks).toBe(2);
      expect(item.externalDomains).toEqual(["ext-a.example", "ext-b.example"]);
    }
    // The rules key links without the query string, so the variants share one in-link count:
    // the six pages of the nav that link to them, each counted once.
    expect(items.map((r) => r.inlinks)).toEqual([6, 6]);
  }, 120_000);

  test("h1, heading count and JSON-LD ids come from the stored parse", async () => {
    const map = await asJson();
    const home = map.pages.find((r) => new URL(r.url).pathname === "/")!;
    expect(home.h1).toBe("Heading");
    expect(home.headingCount).toBe(1);
    expect(home.schemaIds).toEqual([]);
  }, 120_000);

  test("--missing title, description and schema", async () => {
    expect(paths((await asJson("--missing", "title")).pages)).toEqual(["/a"]);
    expect(paths((await asJson("--missing", "description")).pages)).toEqual([
      "/b",
    ]);
    // No page declares schema.org types.
    expect((await asJson("--missing", "schema")).filtered).toBe(9);
  }, 120_000);

  test("--duplicate title names the pages the audit flags, --section and --page narrow by URL", async () => {
    expect(paths((await asJson("--duplicate", "title")).pages)).toEqual([
      "/dup1",
      "/dup2",
    ]);
    expect(paths((await asJson("--section", "/blog")).pages)).toEqual([
      "/blog/post/",
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
    expect(lines).toHaveLength(10);
    const md = await squirrel("pages", "-f", "markdown", "--section", "/blog");
    expect(md.code).toBe(0);
    expect(md.out).toContain("1 of 9 pages match");
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

  test("csv, markdown and html carry no escape, control or bidi character from a page", async () => {
    for (const format of ["csv", "markdown", "html"]) {
      const r = await squirrel("pages", "-f", format);
      expect(r.code).toBe(0);
      expect(unsafe(r.out)).toEqual([]);
      expect(r.out).toContain("Lonely");
    }
  }, 120_000);

  test("csv neutralises the formula in the description and keeps one record per page", async () => {
    const r = await squirrel("pages", "-f", "csv");
    expect(r.out).toContain("'=cmd|' /C calc'!A0");
    expect(r.out.split("\n").filter((l) => l.length > 0)).toHaveLength(10);
  }, 120_000);

  test("json is valid and keeps the page's own bytes", async () => {
    const map = await asJson();
    const lonely = map.pages.find((r) => new URL(r.url).pathname === "/lonely");
    expect(lonely?.title).toContain("Lonely");
    // The hostile bytes really are in the stored page, so the clean outputs above prove something.
    expect(lonely?.title).toContain(String.fromCharCode(27));
  }, 120_000);
});

describe("squirrel pages -f html", () => {
  test("is a standalone page with the pages as data", async () => {
    const r = await squirrel("pages", "-f", "html");
    expect(r.code).toBe(0);
    expect(r.out.startsWith("<!doctype html>")).toBe(true);
    expect(r.out).toContain('id="pm-data"');
    expect(r.out).toContain("/blog/post");
    const filtered = await squirrel(
      "pages",
      "-f",
      "html",
      "--section",
      "/blog"
    );
    expect(filtered.out).toContain("/blog/post");
    expect(filtered.out).not.toContain("/dup1");
  }, 120_000);
});

describe("squirrel pages --diff", () => {
  beforeAll(async () => {
    phase = 2;
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
      join(scratch, "audit2.json")
    );
    expect([0, 1]).toContain(r.code);
  }, 180_000);

  interface Diff {
    site: string;
    older: { crawlId: string };
    newer: { crawlId: string };
    counts: {
      added: number;
      removed: number;
      changed: number;
      unchanged: number;
    };
    added: Row[];
    removed: Row[];
    changed: Array<{
      url: string;
      changes: Array<{ field: string; before: string; after: string }>;
    }>;
  }
  const diffJson = async (...args: string[]): Promise<Diff> => {
    const r = await squirrel("pages", "--diff", "-f", "json", ...args);
    expect(r.code).toBe(0);
    return JSON.parse(r.out) as Diff;
  };
  const changedPaths = (d: Diff) =>
    d.changed.map((c) => new URL(c.url).pathname).sort();

  test("compares the latest audit with the one before it", async () => {
    const d = await diffJson();
    expect(d.older.crawlId).not.toBe(d.newer.crawlId);
    expect(d.added.map((r) => new URL(r.url).pathname)).toEqual(["/fresh"]);
    expect(changedPaths(d)).toEqual(
      expect.arrayContaining(["/a", "/b", "/dup2"])
    );
    const a = d.changed.find((c) => new URL(c.url).pathname === "/a")!;
    expect(a.changes.find((c) => c.field === "title")).toEqual({
      field: "title",
      before: "",
      after: "Page A now has a title of its own",
    });
    const dup2 = d.changed.find((c) => new URL(c.url).pathname === "/dup2")!;
    expect(dup2.changes.find((c) => c.field === "status")).toEqual({
      field: "status",
      before: "200",
      after: "404",
    });
    expect(d.counts.unchanged).toBeGreaterThan(0);
  }, 120_000);

  test("one --crawl names the newer side, two name both, in either order", async () => {
    const latest = (await asJson()).crawlId;
    const auto = await diffJson();
    const one = await diffJson("--crawl", latest.slice(0, 8));
    expect(one.older.crawlId).toBe(auto.older.crawlId);
    const older8 = auto.older.crawlId.slice(0, 8);
    const two = await diffJson(
      "--crawl",
      latest.slice(0, 8),
      "--crawl",
      older8
    );
    expect(two.older.crawlId).toBe(auto.older.crawlId);
    expect(two.newer.crawlId).toBe(latest);
    const reversed = await diffJson(
      "--crawl",
      older8,
      "--crawl",
      latest.slice(0, 8)
    );
    expect(reversed.newer.crawlId).toBe(latest);
  }, 120_000);

  test("--section narrows both sides; markdown and csv carry the same changes", async () => {
    const d = await diffJson("--section", "/blog");
    expect(d.counts).toMatchObject({ added: 0, removed: 0, changed: 0 });
    const md = await squirrel("pages", "--diff");
    expect(md.code).toBe(0);
    expect(md.out).toContain("# Page map diff: ");
    expect(md.out).toContain("Page A now has a title of its own");
    const csv = await squirrel("pages", "--diff", "-f", "csv");
    expect(csv.out.split("\n")[0]).toBe("kind,url,field,before,after");
    expect(csv.out).toContain("added,");
  }, 120_000);

  test("the diff in every format carries no control or bidi character from a page", async () => {
    for (const format of ["markdown", "csv", "json"]) {
      const r = await squirrel("pages", "--diff", "-f", format);
      expect(r.code).toBe(0);
      if (format !== "json") {
        expect(
          [...r.out].filter((ch) => {
            const c = ch.charCodeAt(0);
            return (
              c === 27 ||
              c === 7 ||
              (c >= 0x80 && c <= 0x9f) ||
              (c >= 0x202a && c <= 0x202e)
            );
          })
        ).toEqual([]);
      }
    }
  }, 120_000);

  test("filters on page state and unsupported formats are usage errors", async () => {
    const missing = await squirrel("pages", "--diff", "--missing", "title");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("cannot be combined with --diff");
    const html = await squirrel("pages", "--diff", "-f", "html");
    expect(html.code).toBe(1);
    expect(html.err).toContain("--diff supports markdown, json, csv");
  }, 120_000);

  test("naming an audit that does not exist is an answer, not a failure", async () => {
    const r = await squirrel("pages", "--diff", "--crawl", "ffffffff");
    expect(r.code).toBe(0);
    expect(r.out).toContain("No audit found");
  }, 120_000);
});
