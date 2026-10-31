// Comparing two page maps (#701), and the standalone HTML table.

import { describe, expect, test } from "bun:test";

import { PAGE_MAP_DIFF_FIELDS, diffPageMaps, renderPageMapDiffCsv, renderPageMapDiffJson, renderPageMapDiffMarkdown } from "../src/page-map-diff";
import { PAGE_MAP_HTML_ROW_CAP, renderPageMapHtml } from "../src/page-map-html";
import { pageMapMeta, type PageMapRow } from "../src/page-map";

function row(url: string, over: Partial<PageMapRow> = {}): PageMapRow {
  return {
    url,
    finalUrl: url,
    status: 200,
    depth: 1,
    canonical: null,
    noindex: false,
    title: "A title",
    titleLength: 7,
    description: "A description",
    descriptionLength: 13,
    h1Count: 1,
    wordCount: 100,
    schemaTypes: [],
    inlinks: 1,
    internalOutlinks: 1,
    externalOutlinks: 0,
    externalDomains: [],
    loadTimeMs: 10,
    lastModified: null,
    flags: [],
    ...over,
  };
}

const E = "https://example.com";
const older = [row(`${E}/a`, { title: null, titleLength: 0, flags: ["title"] }), row(`${E}/b`), row(`${E}/gone`), row(`${E}/same`)];
const newer = [row(`${E}/a`, { title: "Now it has a title", titleLength: 18 }), row(`${E}/b`, { status: 404, flags: ["h1", "title"] }), row(`${E}/new`), row(`${E}/same`, { inlinks: 99, wordCount: 5, loadTimeMs: 900 })];

describe("diffPageMaps", () => {
  const diff = diffPageMaps(older, newer);

  test("pages added, removed and changed, sorted by URL", () => {
    expect(diff.added.map((r) => r.url)).toEqual([`${E}/new`]);
    expect(diff.removed.map((r) => r.url)).toEqual([`${E}/gone`]);
    expect(diff.changed.map((c) => c.url)).toEqual([`${E}/a`, `${E}/b`]);
    expect(diff.unchanged).toBe(1);
  });

  test("reports each field that differs, before and after", () => {
    const a = diff.changed.find((c) => c.url === `${E}/a`)!;
    expect(a.changes).toEqual([
      { field: "title", before: "", after: "Now it has a title" },
      { field: "flags", before: "title", after: "" },
    ]);
    const b = diff.changed.find((c) => c.url === `${E}/b`)!;
    expect(b.changes.map((c) => c.field)).toEqual(["status", "flags"]);
    // A list compares as a set, so a reorder is no change.
    expect(b.changes.find((c) => c.field === "flags")).toMatchObject({ after: "h1, title" });
  });

  test("counts that move with every crawl are not compared", () => {
    expect(diff.changed.some((c) => c.url === `${E}/same`)).toBe(false);
    for (const noisy of ["inlinks", "wordCount", "loadTimeMs", "internalOutlinks", "lastModified"]) {
      expect(PAGE_MAP_DIFF_FIELDS as readonly string[]).not.toContain(noisy);
    }
  });

  test("a list reordered is not a change", () => {
    const d = diffPageMaps([row(`${E}/x`, { flags: ["a", "b"], schemaTypes: ["X", "Y"] })], [row(`${E}/x`, { flags: ["b", "a"], schemaTypes: ["Y", "X"] })]);
    expect(d.changed).toHaveLength(0);
    expect(d.unchanged).toBe(1);
  });

  test("identical maps: nothing added, removed or changed", () => {
    const d = diffPageMaps(older, older);
    expect([d.added.length, d.removed.length, d.changed.length, d.unchanged]).toEqual([0, 0, 0, 4]);
  });
});

describe("page map diff renderers", () => {
  const diff = diffPageMaps(older, newer);
  const meta = { site: E, older: { crawlId: "11111111aaaa", startedAt: Date.UTC(2026, 9, 1) }, newer: { crawlId: "22222222bbbb", startedAt: Date.UTC(2026, 9, 31) } };

  test("json carries both audits, the counts and the three lists", () => {
    const json = JSON.parse(renderPageMapDiffJson(diff, meta)) as Record<string, unknown>;
    expect(json).toMatchObject({ site: E, counts: { added: 1, removed: 1, changed: 2, unchanged: 1 } });
    expect((json.older as { startedAt: string }).startedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  test("markdown names the audits and lists changes, additions and removals", () => {
    const md = renderPageMapDiffMarkdown(diff, meta);
    expect(md).toContain("`11111111`");
    expect(md).toContain("1 added, 1 removed, 2 changed, 1 unchanged");
    expect(md).toContain("## Changed");
    expect(md).toContain("Now it has a title");
    expect(md).toContain("## Added");
    expect(md).toContain("## Removed");
  });

  test("markdown for no differences says so; a value from a page cannot break the table", () => {
    expect(renderPageMapDiffMarkdown(diffPageMaps(older, older), meta)).toContain("No page was added, removed or changed.");
    const evil = diffPageMaps([row(`${E}/x`, { title: "a" })], [row(`${E}/x`, { title: "x | y\n<script>z</script>" })]);
    const md = renderPageMapDiffMarkdown(evil, meta);
    const line = md.split("\n").find((l) => l.includes("| title |"))!;
    expect(line).toContain("x \\| y");
    expect(line).not.toMatch(/(^|[^\\])<script>/);
  });

  test("csv has a row per change, addition and removal, with the formula guard", () => {
    const csv = renderPageMapDiffCsv(diffPageMaps([row(`${E}/x`, { title: "a" })], [row(`${E}/x`, { title: "=SUM(1)" }), row(`${E}/y`)])).trim().split("\n");
    expect(csv[0]).toBe("kind,url,field,before,after");
    expect(csv).toContain(`changed,${E}/x,title,a,'=SUM(1)`);
    expect(csv).toContain(`added,${E}/y,,,`);
  });
});

describe("renderPageMapHtml", () => {
  const meta = pageMapMeta({ id: "0123456789abcdef", baseUrl: E, startedAt: 1_000 }, 4);

  test("a complete offline document with the data as escaped JSON", () => {
    const html = renderPageMapHtml(older, meta);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<script type="application/json" id="pm-data">');
    expect(html).toContain("<title>Page map: https://example.com</title>");
    expect(html).not.toMatch(/https?:\/\/(cdn|unpkg|fonts)/);
    expect(html).not.toMatch(/<link[^>]+href=/i);
  });

  test("titles from audited pages cannot end the data script or inject markup", () => {
    const html = renderPageMapHtml([row(`${E}/x`, { title: "</script><img src=x onerror=alert(1)>", description: "<!-- x -->" })], meta);
    const data = html.slice(html.indexOf('id="pm-data">') + 13, html.indexOf("</script>", html.indexOf('id="pm-data">')));
    expect(data).not.toContain("<");
    expect(data).not.toContain(">");
    expect(html.match(/<script/g)?.length).toBe(2);
    expect(html).not.toContain("<img src=x");
    expect(JSON.parse(data).rows[0].title).toBe("</script><img src=x onerror=alert(1)>");
  });

  test("the site name is escaped in the title and heading", () => {
    const html = renderPageMapHtml([], pageMapMeta({ id: "abc", baseUrl: 'https://e.test/"><script>x</script>', startedAt: 1 }, 0));
    expect(html).not.toContain('"><script>x');
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  test("rows past the cap are cut and the page says so", () => {
    const many = Array.from({ length: PAGE_MAP_HTML_ROW_CAP + 5 }, (_, i) => row(`${E}/p${i}`));
    const html = renderPageMapHtml(many, pageMapMeta({ id: "abc", baseUrl: E, startedAt: 1 }, many.length));
    expect(html).toContain(`Showing the first ${PAGE_MAP_HTML_ROW_CAP} of ${many.length} matching pages`);
    const data = JSON.parse(html.slice(html.indexOf('id="pm-data">') + 13, html.indexOf("</script>", html.indexOf('id="pm-data">'))));
    expect(data.rows).toHaveLength(PAGE_MAP_HTML_ROW_CAP);
    expect(data.total).toBe(many.length);
  });

  test("the script reaches the DOM through textContent only", () => {
    const html = renderPageMapHtml(older, meta);
    expect(html).not.toContain("innerHTML");
    expect(html).toContain("textContent");
  });
});

// The diff and the HTML table print values from audited pages too (#701).
describe("hostile page values in the diff and the HTML table", () => {
  const ESC = String.fromCharCode(27);
  const unsafe = (text: string): string[] =>
    [...text].filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 27 || c === 7 || (c >= 0x80 && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    });
  const evilTitle = `T${ESC}[2J${ESC}]8;;https://evil.example\u0007x\u009b31m\u202eabc\nline`;
  const evilUrl = `https://example.com/p${ESC}[1;1H\u202e`;
  const before = [row(evilUrl, { title: "a" })];
  const after = [row(evilUrl, { title: evilTitle, description: "=cmd|' /C calc'!A0" }), row(`${E}/new${ESC}[2J`, { title: evilTitle })];
  const meta = { site: `https://e.test/${ESC}[2J`, older: { crawlId: "1", startedAt: 1 }, newer: { crawlId: "2", startedAt: 2 } };

  test("diff markdown and csv carry no control or bidi character, and csv guards formulas", () => {
    const diff = diffPageMaps(before, after);
    expect(unsafe(renderPageMapDiffMarkdown(diff, meta))).toEqual([]);
    const csv = renderPageMapDiffCsv(diff);
    expect(unsafe(csv)).toEqual([]);
    expect(csv).toContain("'=cmd|' /C calc'!A0");
    expect(csv.trim().split("\n").length).toBe(1 + diff.changed.flatMap((c) => c.changes).length + diff.added.length);
  });

  test("the diff JSON keeps the bytes and is valid", () => {
    const json = JSON.parse(renderPageMapDiffJson(diffPageMaps(before, after), meta)) as { changed: Array<{ changes: Array<{ after: string }> }> };
    expect(json.changed[0]!.changes.find((c) => c.after.includes("evil.example"))).toBeDefined();
  });

  test("the HTML table carries no control or bidi character in its data or its heading", () => {
    const html = renderPageMapHtml(after, pageMapMeta({ id: "abc", baseUrl: meta.site, startedAt: 1 }, 2));
    expect(unsafe(html)).toEqual([]);
    // The text survives, only its control and bidi characters are gone.
    expect(html).toContain("evil.example");
  });
});
