// squirrelscan/repo#3522: text the audited site controls reached the Markdown
// report unescaped, so a page URL like the one below added a link and a remote
// image to the report a reader opens. Each test renders the report and parses
// it with a real CommonMark renderer (Bun.markdown), then asserts that no link
// or image points at the attacker's host.

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { renderMarkdown } from "../src/output/markdown";
import {
  escapeMarkdownDestination,
  escapeMarkdownText,
  markdownCodeSpan,
  markdownLink,
} from "../src/output/markdown-escape";

/** `new URL()` keeps `] ( ) ! [` unencoded in a path: the issue's repro. */
const HOSTILE =
  "https://example.com/a](https://evil.example/x)![i](https://evil.example/p.png)";
const PAYLOAD = "x](https://evil.example/y) ![i](https://evil.example/p.png) <img src=https://evil.example/q>";

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

describe("markdown-escape helpers (#3522)", () => {
  test("escapeMarkdownText escapes link, image, code and HTML syntax and flattens lines", () => {
    expect(escapeMarkdownText("a](b) ![c] `d` <e> &f |g\\h\nnext")).toBe(
      "a\\]\\(b\\) \\!\\[c\\] \\`d\\` \\<e\\> \\&f \\|g\\\\h next",
    );
    // Underscores and asterisks stay readable: they can only emphasise.
    expect(escapeMarkdownText("/my_page*")).toBe("/my_page*");
  });

  test("escapeMarkdownDestination encodes what ends or restructures a destination, not !", () => {
    expect(escapeMarkdownDestination("https://e.com/a b(c)<d>`e`[f]\\g!\n")).toBe(
      "https://e.com/a%20b%28c%29%3Cd%3E%60e%60%5Bf%5D%5Cg!%0A",
    );
  });

  test("markdownLink links only http(s) and root-relative URLs", () => {
    expect(markdownLink("/a", "https://example.com/a")).toBe("[/a](https://example.com/a)");
    expect(markdownLink("/a", "/a")).toBe("[/a](/a)");
    expect(markdownLink("x", "javascript:alert(1)")).toBe("x");
    expect(markdownLink("x", "//evil.example/x")).toBe("x");
  });

  test("markdownCodeSpan fences past the longest backtick run", () => {
    expect(markdownCodeSpan("6.4")).toBe("`6.4`");
    expect(markdownCodeSpan("a``b")).toBe("```a``b```");
    expect(markdownCodeSpan("`x")).toBe("`` `x ``");
  });
});
