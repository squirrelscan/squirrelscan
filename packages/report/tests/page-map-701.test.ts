// The page map (#701): filters, and the csv, markdown and json renderers.

import { describe, expect, test } from "bun:test";

import {
  PAGE_MAP_COLUMNS,
  cleanText,
  csvSafeText,
  escapeJsonUnsafe,
  urlCell,
  filterPageMap,
  hasPageMapFilters,
  pageMapMeta,
  renderPageMapCsv,
  renderPageMapJson,
  renderPageMapMarkdown,
  type PageMapRow,
} from "../src/page-map";

function row(over: Partial<PageMapRow> = {}): PageMapRow {
  return {
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    depth: 0,
    canonical: null,
    noindex: false,
    title: "Home",
    titleLength: 4,
    description: "A page",
    descriptionLength: 6,
    h1Count: 1,
    h1: "Heading",
    headingCount: 1,
    wordCount: 120,
    schemaTypes: ["WebSite"],
    schemaIds: ["https://example.com/#website"],
    inlinks: 3,
    internalOutlinks: 5,
    externalOutlinks: 1,
    externalDomains: ["other.example"],
    loadTimeMs: 120,
    lastModified: null,
    flags: [],
    ...over,
  };
}

const rows: PageMapRow[] = [
  row(),
  row({ url: "https://example.com/blog/a", title: null, titleLength: 0, flags: ["title"] }),
  row({
    url: "https://example.com/blog/b",
    description: "",
    descriptionLength: 0,
    h1Count: 0,
    flags: ["duplicate-title", "h1"],
  }),
  row({ url: "https://example.com/blogger", schemaTypes: [], flags: ["no-schema"] }),
  row({
    url: "https://example.com/long",
    titleLength: 90,
    descriptionLength: 200,
    flags: ["duplicate-description", "orphan"],
  }),
];
const urls = (list: PageMapRow[]) => list.map((r) => new URL(r.url).pathname);

describe("filterPageMap", () => {
  test("no filters is every page, and hasPageMapFilters says so", () => {
    expect(hasPageMapFilters({})).toBe(false);
    expect(filterPageMap(rows, {})).toHaveLength(rows.length);
  });

  test("--missing title, description, h1 and schema, any of several", () => {
    expect(urls(filterPageMap(rows, { missing: ["title"] }))).toEqual(["/blog/a"]);
    expect(urls(filterPageMap(rows, { missing: ["description"] }))).toEqual(["/blog/b"]);
    expect(urls(filterPageMap(rows, { missing: ["h1"] }))).toEqual(["/blog/b"]);
    expect(urls(filterPageMap(rows, { missing: ["schema"] }))).toEqual(["/blogger"]);
    expect(urls(filterPageMap(rows, { missing: ["title", "schema"] }))).toEqual([
      "/blog/a",
      "/blogger",
    ]);
  });

  test("a row with no stored h1 count is not missing an h1", () => {
    expect(filterPageMap([row({ h1Count: null })], { missing: ["h1"] })).toHaveLength(0);
  });

  test("--duplicate reads the audit's flags", () => {
    expect(urls(filterPageMap(rows, { duplicate: ["title"] }))).toEqual(["/blog/b"]);
    expect(urls(filterPageMap(rows, { duplicate: ["description"] }))).toEqual(["/long"]);
    expect(urls(filterPageMap(rows, { duplicate: ["title", "description"] }))).toEqual([
      "/blog/b",
      "/long",
    ]);
  });

  test("--too-long is a title over 75 or a description over 160", () => {
    expect(urls(filterPageMap(rows, { tooLong: true }))).toEqual(["/long"]);
    expect(
      filterPageMap([row({ titleLength: 75, descriptionLength: 160 })], { tooLong: true }),
    ).toHaveLength(0);
    expect(filterPageMap([row({ titleLength: 76 })], { tooLong: true })).toHaveLength(1);
    expect(filterPageMap([row({ descriptionLength: 161 })], { tooLong: true })).toHaveLength(1);
  });

  test("--orphan reads the audit's orphan flag", () => {
    expect(urls(filterPageMap(rows, { orphan: true }))).toEqual(["/long"]);
  });

  test("--section is a path prefix on a segment boundary", () => {
    expect(urls(filterPageMap(rows, { section: "/blog" }))).toEqual(["/blog/a", "/blog/b"]);
    expect(urls(filterPageMap(rows, { section: "blog/" }))).toEqual(["/blog/a", "/blog/b"]);
    expect(filterPageMap(rows, { section: "/" })).toHaveLength(rows.length);
  });

  test("--page is a URL substring, any of several", () => {
    expect(urls(filterPageMap(rows, { page: ["long"] }))).toEqual(["/long"]);
    expect(urls(filterPageMap(rows, { page: ["blogger", "long"] }))).toEqual(["/blogger", "/long"]);
  });

  test("filters combine: every group must match", () => {
    expect(urls(filterPageMap(rows, { section: "/blog", missing: ["h1"] }))).toEqual(["/blog/b"]);
    expect(filterPageMap(rows, { section: "/blog", orphan: true })).toHaveLength(0);
  });
});

describe("renderPageMapCsv", () => {
  test("a header of every column, one line per page, lists joined by a space", () => {
    const lines = renderPageMapCsv([
      row({ externalDomains: ["a.example", "b.example"], flags: ["orphan", "h1"] }),
    ])
      .trim()
      .split("\n");
    expect(lines[0]).toBe(PAGE_MAP_COLUMNS.join(","));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("a.example b.example");
    expect(lines[1]).toContain("orphan h1");
  });

  test("quotes commas and quotes, makes a newline a space, and neutralises formulas from an audited page", () => {
    const csv = renderPageMapCsv([row({ title: '=HYPERLINK("x"),\nb', description: "+cmd" })]);
    expect(csv).toContain(`"'=HYPERLINK(""x""), b"`);
    expect(csv).toContain(",'+cmd,");
  });
});

describe("renderPageMapMarkdown", () => {
  const meta = pageMapMeta(
    { id: "0123456789abcdef", baseUrl: "https://example.com", startedAt: 1_000 },
    5,
  );

  test("a table with a row per page and the audit named", () => {
    const md = renderPageMapMarkdown(rows, meta);
    expect(md).toContain("# Page map: ");
    expect(md).toContain("5 pages, from audit `01234567`.");
    expect(md.split("\n").filter((l) => l.startsWith("| `https://")).length).toBe(5);
  });

  test("says how many of the pages match a filter", () => {
    expect(renderPageMapMarkdown(rows.slice(0, 2), meta)).toContain("2 of 5 pages match");
  });

  test("a cell from an audited page cannot break the table or inject markup", () => {
    const md = renderPageMapMarkdown(
      [row({ title: "a | b\n# heading", description: "<script>x</script> *bold*" })],
      meta,
    );
    const dataLine = md.split("\n").find((l) => l.startsWith("| `https://"))!;
    // Pipes escaped, one line, no live tag.
    expect(dataLine).toContain("a \\| b # heading");
    expect(dataLine).toContain("\\<script>");
    expect(dataLine).not.toMatch(/(^|[^\\])<script>/);
    expect(md.split("\n").filter((l) => l.startsWith("| `https://"))).toHaveLength(1);
  });
});

describe("renderPageMapJson", () => {
  test("carries the audit, both counts and the rows", () => {
    const meta = pageMapMeta(
      { id: "abc", baseUrl: "https://example.com", startedAt: Date.UTC(2026, 9, 31) },
      5,
    );
    const json = JSON.parse(renderPageMapJson(rows.slice(0, 2), meta)) as Record<string, unknown>;
    expect(json).toMatchObject({
      site: "https://example.com",
      crawlId: "abc",
      startedAt: "2026-10-31T00:00:00.000Z",
      total: 5,
      filtered: 2,
    });
    expect((json.pages as unknown[]).length).toBe(2);
  });
});

// Every value of a row comes from an audited site, and these outputs reach a terminal, a spreadsheet
// or a viewer: a page must not be able to move the cursor, clear the screen, plant a hyperlink,
// reorder text, run a formula or break a table.
describe("hostile page values (#701)", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const hostile = {
    title: `T${ESC}[2J${ESC}[1;1HFORGED${ESC}]8;;https://evil.example${BEL}click${ESC}]8;;${BEL}\u009b31m\u202egnp.exe\u2066x\u2069\nnext line`,
    description: `=cmd|' /C calc'!A0`,
    url: `https://example.com/p${ESC}[2J\u009b0m\u202e/x`,
    finalUrl: `https://example.com/+SUM(1)`,
    canonical: "@SUM(1)",
  };
  const rows = [row(hostile)];
  const meta = pageMapMeta(
    { id: "abc", baseUrl: `https://e.test/${ESC}[2J\u202e`, startedAt: 1 },
    1,
  );
  const unsafe = (text: string) =>
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

  test("cleanText removes escapes, C1 controls, bidi overrides and line breaks; keeps ordinary text", () => {
    expect(unsafe(cleanText(hostile.title))).toEqual([]);
    expect(cleanText(hostile.title)).toContain("FORGED");
    expect(cleanText(hostile.title)).not.toContain("\n");
    expect(cleanText("plain, ordinary text \u00e9\u4e2d")).toBe(
      "plain, ordinary text \u00e9\u4e2d",
    );
    expect(cleanText(null)).toBe("");
  });

  test("csvSafeText prefixes a formula start after any leading whitespace, and cleans first", () => {
    for (const value of [
      "=1+1",
      "+1",
      "-1",
      "@SUM(1)",
      '  =HYPERLINK("x")',
      "\t=x",
      "\r\n=x",
      `${ESC}=x`,
    ]) {
      expect(csvSafeText(value).trimStart().startsWith("'")).toBe(true);
    }
    expect(csvSafeText("normal =text")).toBe("normal =text");
    expect(csvSafeText("a-b")).toBe("a-b");
  });

  test("csv: no control or bidi character, and no cell starts a formula", () => {
    const csv = renderPageMapCsv(rows);
    expect(unsafe(csv)).toEqual([]);
    const cells = csv.split("\n")[1]!;
    expect(cells).toContain("'=cmd|' /C calc'!A0");
    expect(cells).toContain("'@SUM(1)");
    // One header line and one row: the newline in the title did not start a record.
    expect(csv.trim().split("\n")).toHaveLength(2);
  });

  test("markdown: one row per page, no control or bidi character, no live HTML", () => {
    const md = renderPageMapMarkdown(rows, meta);
    expect(unsafe(md)).toEqual([]);
    expect(md.split("\n").filter((l) => l.startsWith("| `https://"))).toHaveLength(1);
    expect(md).not.toMatch(/(^|[^\\])<[a-z]/i);
  });

  test("json keeps the values as they are and is valid", () => {
    const json = JSON.parse(renderPageMapJson(rows, meta)) as { pages: Array<{ title: string }> };
    expect(json.pages[0]!.title).toBe(hostile.title);
  });
});

describe("review fixes (#701)", () => {
  const meta = pageMapMeta({ id: "abc", baseUrl: "https://example.com", startedAt: 1 }, 1);

  test("a pipe in a URL cannot end the table cell: every row has the same number of unescaped pipes", () => {
    const md = renderPageMapMarkdown(
      [row({ url: "https://example.com/p|pipe|injected|cells|x" }), row()],
      meta,
    );
    const lines = md.split("\n").filter((l) => l.startsWith("| `https://"));
    expect(lines).toHaveLength(2);
    const unescapedPipes = (line: string) => line.match(/(?<!\\)\|/g)?.length;
    expect(unescapedPipes(lines[0]!)).toBe(unescapedPipes(lines[1]!));
    expect(urlCell("https://e.test/a|b")).toBe("`https://e.test/a\\|b`");
  });

  test("json escapes DEL, C1 controls, bidi and separators as \\uXXXX and stays the same value", () => {
    const title = "a\u007fb\u009bc\u202ed\u2028e\u2066f\u200bg\u061ch";
    const out = renderPageMapJson([row({ title })], meta);
    for (const ch of title
      .slice(1)
      .split("")
      .filter((c) => c.charCodeAt(0) > 0x7e))
      expect(out).not.toContain(ch);
    expect(out).toContain("\\u009b");
    expect(out).toContain("\\u202e");
    expect((JSON.parse(out) as { pages: Array<{ title: string }> }).pages[0]!.title).toBe(title);
    expect(escapeJsonUnsafe('{"a":"plain \u00e9\u4e2d"}')).toBe('{"a":"plain \u00e9\u4e2d"}');
  });

  test("--missing only judges pages that answered below 400 and were parsed", () => {
    const rows = [
      row({ url: `${"https://example.com"}/ok`, title: null, schemaTypes: [] }),
      row({
        url: "https://example.com/gone",
        status: 404,
        title: null,
        schemaTypes: [],
        wordCount: null,
      }),
      row({ url: "https://example.com/doc.pdf", title: null, schemaTypes: [], wordCount: null }),
    ];
    expect(filterPageMap(rows, { missing: ["title"] }).map((r) => r.url)).toEqual([
      "https://example.com/ok",
    ]);
    expect(filterPageMap(rows, { missing: ["schema"] }).map((r) => r.url)).toEqual([
      "https://example.com/ok",
    ]);
  });

  test("--section and --page ignore case and match percent-encoded paths", () => {
    const rows = [
      row({ url: "https://example.com/caf%C3%A9/Menu" }),
      row({ url: "https://example.com/other" }),
    ];
    expect(filterPageMap(rows, { section: "/café" }).map((r) => r.url)).toEqual([
      "https://example.com/caf%C3%A9/Menu",
    ]);
    expect(filterPageMap(rows, { section: "/CAF%C3%A9" })).toHaveLength(1);
    expect(filterPageMap(rows, { page: ["MENU"] })).toHaveLength(1);
    expect(filterPageMap(rows, { page: ["café/menu"] })).toHaveLength(1);
  });

  test("cleanText removes invisible characters", () => {
    expect(cleanText(`a\u200bb${String.fromCodePoint(0xe0041)}c\ufeffd`)).toBe("abcd");
  });

  test("csv carries the h1, heading count and schema id columns", () => {
    const csv = renderPageMapCsv([
      row({
        h1: "Main, heading",
        headingCount: 4,
        schemaIds: ["https://e.test/#a", "https://e.test/#b"],
      }),
    ]);
    expect(csv.split("\n")[0]).toContain(
      ",h1Count,h1,headingCount,wordCount,schemaTypes,schemaIds,",
    );
    expect(csv).toContain('"Main, heading",4,');
    expect(csv).toContain("https://e.test/#a https://e.test/#b");
  });
});
