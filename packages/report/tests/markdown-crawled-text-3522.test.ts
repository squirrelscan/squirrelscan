// squirrelscan/repo#3522: text the audited site controls reached the Markdown
// report unescaped, so a page URL like the one below added a link and a remote
// image to the report a reader opens. Each test renders the report and parses
// it with a real CommonMark renderer (Bun.markdown), then asserts that no link
// or image points at the attacker's host.

import { describe, expect, test } from "bun:test";

import type { AuditReport, EntityMap, ReportRuleResult } from "../src/types";
import { renderMarkdown } from "../src/output/markdown";
import { renderEntityDiffMarkdown } from "../src/entities-diff";
import {
  escapeHtmlText,
  escapeMarkdownCell,
  escapeMarkdownDestination,
  escapeMarkdownText,
  markdownCodeSpan,
  markdownLink,
} from "../src/output/markdown-escape";

/** `new URL()` keeps `] ( ) ! [` unencoded in a path: the issue's repro. */
const HOSTILE =
  "https://example.com/a](https://evil.example/x)![i](https://evil.example/p.png)";
const PAYLOAD =
  "x](https://evil.example/y) [t](https://evil.example/z) ![i](https://evil.example/p.png) <img src=https://evil.example/q>";

function baseReport(extra: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-27T00:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 1,
    failed: 0,
    ruleResults: {},
    ...extra,
  };
}

function rule(checks: ReportRuleResult["checks"]): Record<string, ReportRuleResult> {
  return {
    "links/broken-links": {
      meta: {
        id: "links/broken-links",
        name: "Broken links",
        description: "desc",
        category: "links",
        scope: "site",
        severity: "warning",
        weight: 5,
      },
      checks,
    },
  };
}

/** The rendered HTML's links and images that point at the attacker's host. */
function hostileTargets(markdown: string): string[] {
  const html = Bun.markdown.html(markdown);
  return Array.from(html.matchAll(/(?:href|src)="(https?:\/\/evil\.example[^"]*)"/g), (m) => m[1]!);
}

describe("crawled text in the Markdown report is inert (#3522)", () => {
  test("the repro URL really does inject when left raw", () => {
    // Guards the test itself: the page list's old line, with the path as the
    // label, does add the attacker's link and image under this renderer.
    const raw = hostileTargets(`- [${new URL(HOSTILE).pathname}](${HOSTILE})`);
    expect(raw).toContain("https://evil.example/x");
    expect(raw).toContain("https://evil.example/p.png");
  });

  test("a check's page list renders the hostile page as one link to itself", () => {
    const md = renderMarkdown(
      baseReport({ ruleResults: rule([{ name: "broken", status: "warn", message: "m", pages: [HOSTILE] }]) }),
    );
    expect(hostileTargets(md)).toEqual([]);
    const html = Bun.markdown.html(md);
    // Still a working link to the audited page, its path shown as text.
    expect(html).toContain('href="https://example.com/a%5D%28https://evil.example/x%29!%5Bi%5D%28https://evil.example/p.png%29"');
  });

  test("item rows: a URL item, a plain label and its source pages", () => {
    const md = renderMarkdown(
      baseReport({
        ruleResults: rule([
          {
            name: "broken",
            status: "warn",
            message: "m",
            items: [
              { id: HOSTILE, label: PAYLOAD, sourcePages: [HOSTILE] },
              { id: "resource-key", label: PAYLOAD },
            ],
          },
        ]),
      }),
    );
    expect(hostileTargets(md)).toEqual([]);
    expect(Bun.markdown.html(md)).not.toContain("<img src=https://evil.example");
  });

  test("a partial audit's reason cannot open a link, an image or a new block", () => {
    const md = renderMarkdown(
      baseReport({
        status: "partial",
        statusReason: `Crawl stopped at ${PAYLOAD}\n\n# Injected heading`,
        healthScore: { overall: 80, categories: [] },
      }),
    );
    expect(hostileTargets(md)).toEqual([]);
    expect(Bun.markdown.html(md)).not.toContain("<h1>Injected heading</h1>");
  });

  test("the base URL line", () => {
    const md = renderMarkdown(baseReport({ baseUrl: HOSTILE }));
    expect(hostileTargets(md)).toEqual([]);
  });

  test("the scan line drops a generator version that is not a version", () => {
    const md = renderMarkdown(
      baseReport({
        generatorVersion: `0.0.1 ${PAYLOAD}`,
        scanScope: { origin: "cli", pagesCrawled: 1, capped: false },
      }),
    );
    expect(hostileTargets(md)).toEqual([]);
    expect(md).toContain("Scan: 1 page crawled from the CLI.");
  });

  test("a well-formed generator version still prints", () => {
    const md = renderMarkdown(
      baseReport({
        generatorVersion: "0.0.137-beta.1",
        scanScope: { origin: "cli", pagesCrawled: 1, capped: false },
      }),
    );
    expect(md).toContain("Scan: 1 page crawled from the CLI v0.0.137-beta.1.");
  });

  test("a detected technology version cannot break out of its code span", () => {
    const md = renderMarkdown(
      baseReport({
        technologies: {
          items: [
            {
              id: "wordpress",
              name: "WordPress",
              category: "cms",
              version: `6\` ${PAYLOAD} \``,
              confidence: "high",
              detectedBy: "meta:generator",
            },
          ],
          added: [],
          removed: [],
          firstScan: true,
        },
      }),
    );
    expect(hostileTargets(md)).toEqual([]);
  });
});

describe("sinks the first pass missed (#3522 review)", () => {
  test("a check's message and name, in the table and the page-list summary", () => {
    const md = renderMarkdown(
      baseReport({
        ruleResults: rule([
          {
            name: `misspelled ${PAYLOAD}`,
            status: "warn",
            message: `Blocked by ad blockers: ${PAYLOAD}`,
            pages: ["https://example.com/a"],
          },
        ]),
      }),
    );
    expect(hostileTargets(md)).toEqual([]);
    expect(Bun.markdown.html(md)).not.toContain("<img src=https://evil.example");
  });

  test("a plain item label cannot open a heading, a rule or a nested list", () => {
    const md = renderMarkdown(
      baseReport({
        ruleResults: rule([
          {
            name: "broken",
            status: "warn",
            message: "m",
            items: [
              { id: "k1", label: "# Fake heading" },
              { id: "k2", label: "---" },
              { id: "k3", label: "1. nested" },
            ],
          },
        ]),
      }),
    );
    const html = Bun.markdown.html(md);
    // Each label is its own list item's plain text, not a block inside it.
    expect(html).toContain("<li># Fake heading</li>");
    expect(html).toContain("<li>---</li>");
    expect(html).toContain("<li>1. nested</li>");
    expect(html).not.toContain("<ol>");
  });

  test("a technology's name and its logo's alt text", () => {
    const md = renderMarkdown(
      baseReport({
        technologies: {
          items: [
            {
              id: "wordpress",
              name: `WP" onerror="x ${PAYLOAD}`,
              category: "cms",
              version: null,
              confidence: "high",
              detectedBy: "meta:generator",
              icon: "wordpress",
            },
          ],
          added: [],
          removed: [],
          firstScan: true,
        },
      }),
    );
    expect(hostileTargets(md)).toEqual([]);
    // The quote cannot close the alt attribute and add one of its own.
    expect(md).toContain('alt="WP&quot; onerror=&quot;x ');
    expect(Bun.markdown.html(md)).not.toMatch(/<img[^>]*\sonerror="/);
  });

  test("the site profile's title", () => {
    const md = renderMarkdown(
      baseReport({
        siteMetadata: {
          siteType: "blog",
          title: PAYLOAD,
          isYMYL: false,
          isLocalBusiness: false,
          hasOwnershipVerified: false,
          confidence: "high",
        },
      }),
    );
    expect(hostileTargets(md)).toEqual([]);
  });

  test("the entity section: names, ids, conflicting values and the property code span", () => {
    const map: EntityMap = {
      format: "squirrelscan/entity-map",
      version: 1,
      site: "https://example.com/",
      generatedAt: "2026-10-27T00:00:00.000Z",
      summary: {
        nodeCount: 1,
        edgeCount: 0,
        danglingCount: 0,
        pagesTotal: 1,
        pagesWithoutEntities: 0,
        nodesWithStableId: 1,
        stableIdShare: 1,
        pageLocalCount: 0,
        nodesWithoutIdCount: 0,
        conflictCount: 1,
        countsByType: { Organization: 1 },
      },
      nodes: [
        {
          key: "id:x",
          id: `https://example.com/#${PAYLOAD}`,
          types: [`Organization ${PAYLOAD}`],
          name: PAYLOAD,
          properties: { name: PAYLOAD },
          occurrences: 2,
          pages: ["https://example.com/a"],
          morePages: 0,
          conflicts: [
            {
              property: `url\` ${PAYLOAD} \``,
              values: [
                { value: PAYLOAD, pages: ["https://example.com/a"], morePages: 0 },
                { value: "b", pages: ["https://example.com/b"], morePages: 0 },
              ],
            },
          ],
          danglingRefs: 0,
          pageLocal: false,
        },
      ],
      edges: [],
      pages: [],
    };
    const md = renderMarkdown(baseReport({ entityMap: map }));
    expect(md).toContain("## Entities");
    expect(hostileTargets(md)).toEqual([]);
  });
});

/** Blank lines end a raw HTML block, so whatever follows parses as Markdown again. */
const BLOCK_BREAK = "x\n\n![i](https://evil.example/p.png)\n\n[t](https://evil.example/x)";

describe("line breaks inside raw HTML (#3522 review round 2)", () => {
  test("a check name with blank lines cannot end the <summary> HTML block", () => {
    const md = renderMarkdown(
      baseReport({
        ruleResults: rule([
          {
            name: BLOCK_BREAK,
            status: "warn",
            message: "m",
            pages: ["https://example.com/a"],
            items: [{ id: "k", label: "l" }],
          },
        ]),
      }),
    );
    expect(hostileTargets(md)).toEqual([]);
  });

  test("a technology name with blank lines cannot end the logo's HTML", () => {
    const md = renderMarkdown(
      baseReport({
        technologies: {
          items: [
            {
              id: "wordpress",
              name: BLOCK_BREAK,
              category: "cms",
              version: null,
              confidence: "high",
              detectedBy: "meta:generator",
              icon: "wordpress",
            },
          ],
          added: [],
          removed: [],
          firstScan: true,
        },
      }),
    );
    expect(hostileTargets(md)).toEqual([]);
  });

  test("the entity diff's property code span keeps its cell and its text", () => {
    const side = { site: "https://example.com/", generatedAt: "2026-10-27T00:00:00.000Z", nodeCount: 1, pagesTotal: 1 };
    const md = renderEntityDiffMarkdown({
      format: "squirrelscan/entity-map-diff",
      version: 1,
      generatedAt: "2026-10-27T00:00:00.000Z",
      older: side,
      newer: side,
      added: [],
      removed: [],
      notCrawled: [],
      gainedId: [],
      lostId: [],
      occurrenceDeltas: [],
      newConflicts: [
        { key: "k", name: PAYLOAD, property: `url\` | ${PAYLOAD}` },
        // A value that already holds `\|` must not split its cell either.
        { key: "k2", name: "second", property: "a\\|b" },
      ],
      resolvedConflicts: [],
      newDangling: [],
      resolvedDangling: [],
      summaryDelta: {},
      pagesOnlyInOlder: [],
      pagesOnlyInNewer: [],
    });
    expect(hostileTargets(md)).toEqual([]);
    // The pipe stayed inside the property's cell: the row still has two cells.
    const rows = Bun.markdown.html(md).split("</tr>");
    const row = rows.find((r) => r.includes("<code>url`")) ?? "";
    expect(row.match(/<td>/g)).toHaveLength(2);
    expect(row).toContain("<code>url` \u00a6 x](https://evil.example/y)");
    const backslashed = rows.find((r) => r.includes("<code>a")) ?? "";
    expect(backslashed.match(/<td>/g)).toHaveLength(2);
    expect(backslashed).toContain("<code>a\\\u00a6b</code>");
  });
});

describe("markdown-escape helpers (#3522)", () => {
  test("ordinary message text stays readable: parentheses, bangs, > and a bare & are not escaped", () => {
    const message = "Title is 72 characters (recommended: 30-60) on 3 pages! nav > a, R&D, 5 > 3";
    expect(escapeMarkdownText(message)).toBe(message);
    expect(escapeMarkdownCell(message)).toBe(message);
  });

  test("an entity-shaped & and a leading > are still escaped", () => {
    expect(escapeMarkdownText("&#x5D;")).toBe("\\&#x5D;");
    expect(escapeMarkdownText("> quote")).toBe("\\> quote");
  });

  test("escapeMarkdownText escapes link, image, code and HTML syntax and flattens lines", () => {
    expect(escapeMarkdownText("a](b) ![c] `d` <e> &f |g\\h\nnext")).toBe(
      "a\\](b) !\\[c\\] \\`d\\` \\<e> &f \\|g\\\\h next",
    );
    // Underscores and asterisks stay readable: they can only emphasise.
    expect(escapeMarkdownText("/my_page*")).toBe("/my_page*");
    // A leading block marker is escaped.
    expect(escapeMarkdownText("# h")).toBe("\\# h");
    expect(escapeMarkdownText("12. x")).toBe("12\\. x");
  });

  test("escapeMarkdownDestination encodes what ends or restructures a destination, not !", () => {
    expect(escapeMarkdownDestination("https://e.com/a b(c)<d>`e`[f]\\g!\n")).toBe(
      "https://e.com/a%20b%28c%29%3Cd%3E%60e%60%5Bf%5D%5Cg!%0A",
    );
    // An entity-shaped `&` is kept as typed; a query separator stays readable.
    expect(escapeMarkdownDestination("https://e.com/?a=1&b=2&amp;c")).toBe(
      "https://e.com/?a=1&b=2\\&amp;c",
    );
  });

  test("markdownLink links only http(s) and root-relative URLs", () => {
    expect(markdownLink("/a", "https://example.com/a")).toBe("[/a](https://example.com/a)");
    expect(markdownLink("/a", "/a")).toBe("[/a](/a)");
    expect(markdownLink("x", "javascript:alert(1)")).toBe("x");
    expect(markdownLink("x", "//evil.example/x")).toBe("x");
  });

  test("escapeHtmlText escapes markup and flattens line breaks", () => {
    expect(escapeHtmlText(`a"b'<c>&\n\nd`)).toBe("a&quot;b&#39;&lt;c&gt;&amp; d");
  });

  test("markdownCodeSpan fences past the longest backtick run", () => {
    expect(markdownCodeSpan("6.4")).toBe("`6.4`");
    expect(markdownCodeSpan("a``b")).toBe("```a``b```");
    expect(markdownCodeSpan("`x")).toBe("`` `x ``");
  });
});
