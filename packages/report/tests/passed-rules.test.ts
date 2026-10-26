// --include-passed: the rules that passed, listed after the issues in every
// format. Off by default, where every format renders exactly as before.

import { describe, expect, test } from "bun:test";
import type { AuditReport, ReportRuleResult } from "../src/types";
import { listPassedRules, passedRuleScope } from "../src/grouping";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";

type Check = ReportRuleResult["checks"][number];

const pass = (pageUrl?: string): Check => ({ name: "c", status: "pass", message: "ok", pageUrl });
const warn = (pageUrl: string): Check => ({ name: "c", status: "warn", message: "meh", pageUrl });
const info = (pageUrl: string): Check => ({ name: "c", status: "info", message: "fyi", pageUrl });

function rule(
  id: string,
  category: string,
  checks: Check[],
  weight = 5,
  scope: "page" | "site" = "page",
): ReportRuleResult {
  return {
    meta: { id, name: `Name of ${id}`, description: "", category, scope, severity: "error", weight },
    checks,
  };
}

function report(ruleResults: Record<string, ReportRuleResult>): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-01T00:00:00.000Z",
    totalPages: 2,
    passed: 4,
    warnings: 1,
    failed: 0,
    ruleResults,
  };
}

const RULES = {
  "core/canonical": rule("core/canonical", "core", [
    pass("https://example.com/"),
    pass("https://example.com/about"),
    // The same page twice counts once.
    pass("https://example.com/about"),
  ]),
  "crawl/robots-txt": rule("crawl/robots-txt", "crawl", [pass()], 5, "site"),
  "content/word-count": rule("content/word-count", "content", [
    pass("https://example.com/"),
    warn("https://example.com/about"),
  ]),
  "perf/info-only": rule("perf/info-only", "perf", [info("https://example.com/")]),
};

describe("listPassedRules", () => {
  test("keeps rules with a pass and no warn or fail", () => {
    const ids = listPassedRules(RULES).map((r) => r.id);
    expect(ids).toContain("core/canonical");
    expect(ids).toContain("crawl/robots-txt");
    expect(ids).not.toContain("content/word-count");
    expect(ids).not.toContain("perf/info-only");
  });

  test("counts distinct pages, and 0 for a site-scope rule", () => {
    const byId = Object.fromEntries(listPassedRules(RULES).map((r) => [r.id, r]));
    expect(byId["core/canonical"].pages).toBe(2);
    expect(byId["crawl/robots-txt"].pages).toBe(0);
    expect(passedRuleScope(byId["core/canonical"])).toBe("2 pages");
    expect(passedRuleScope(byId["crawl/robots-txt"])).toBe("site-wide");
    expect(passedRuleScope({ ...byId["core/canonical"], pages: 1 })).toBe("1 page");
  });

  test("site-wide comes from the rule's scope, not from missing pageUrls", () => {
    const rules = listPassedRules({
      "core/no-urls": rule("core/no-urls", "core", [pass(), pass()]),
      "crawl/robots-txt": RULES["crawl/robots-txt"],
    });
    const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
    expect(byId["core/no-urls"].scope).toBe("page");
    expect(passedRuleScope(byId["core/no-urls"])).toBe("pages not recorded");
    expect(byId["crawl/robots-txt"].scope).toBe("site");
    expect(passedRuleScope(byId["crawl/robots-txt"])).toBe("site-wide");
  });

  test("names the category and orders by weight within it", () => {
    const rules = listPassedRules({
      "core/light": rule("core/light", "core", [pass("https://example.com/")], 2),
      "core/heavy": rule("core/heavy", "core", [pass("https://example.com/")], 9),
    });
    expect(rules.map((r) => r.id)).toEqual(["core/heavy", "core/light"]);
    expect(rules[0].categoryName).toBe("Core SEO");
  });

  test("no pass rows, no passed rules", () => {
    expect(listPassedRules({})).toEqual([]);
  });
});

describe("renderers", () => {
  const r = report(RULES);

  test("off by default: output is unchanged", () => {
    expect(renderMarkdown(r, { includePassed: false })).toBe(renderMarkdown(r));
    expect(renderText(r, { includePassed: false })).toBe(renderText(r));
    expect(renderJson(r, { includePassed: false })).toBe(renderJson(r));
    expect(renderLlm(r, { includePassed: false })).toBe(renderLlm(r));
    expect(renderXml(r, { includePassed: false })).toBe(renderXml(r));
    expect(renderHtml(r, { includePassed: false })).toBe(renderHtml(r));
    expect(renderHtml(r)).not.toContain('id="passed"');
    expect(renderHtml(r)).not.toContain('href="#passed"');
  });

  test("markdown", () => {
    const md = renderMarkdown(r, { includePassed: true });
    expect(md).toContain("## Passed");
    expect(md).toContain("| Name of core/canonical `core/canonical` | Core SEO | 2 pages |");
    expect(md).toContain("site-wide");
    expect(md.slice(md.indexOf("## Passed"))).not.toContain("content/word-count");
  });

  test("text", () => {
    const text = renderText(r, { includePassed: true });
    expect(text).toContain("PASSED (2 rules)");
    expect(text).toContain("[CORE SEO]");
    expect(text).toContain("  core/canonical - Name of core/canonical (2 pages)");
  });

  test("json", () => {
    const json = JSON.parse(renderJson(r, { includePassed: true }));
    expect(json.passedRules).toContainEqual({
      ruleId: "core/canonical",
      name: "Name of core/canonical",
      category: "Core SEO",
      scope: "page",
      pages: 2,
    });
    expect(json.passedRules).toHaveLength(2);
    expect(JSON.parse(renderJson(r)).passedRules).toBeUndefined();
  });

  test("llm and xml", () => {
    expect(renderLlm(r, { includePassed: true })).toContain(
      '<rule id="core/canonical" name="Name of core/canonical" category="Core SEO" scope="page" pages="2"/>',
    );
    const xml = renderXml(r, { includePassed: true });
    expect(xml).toContain('<passed count="2">');
    expect(xml).toContain(
      '<rule id="crawl/robots-txt" category="Crawlability" scope="site" pages="0">',
    );
  });

  test("html: one closed section after the findings, a row per rule", () => {
    const html = renderHtml(r, { includePassed: true });
    const at = html.indexOf('<section id="passed">');
    const section = html.slice(at, html.indexOf("</section>", at));
    expect(at).toBeGreaterThan(html.indexOf('<section id="findings">'));
    expect(html).toContain('href="#passed"');
    expect(section).toContain("2 rules passed with no issues");
    expect(section).toContain('data-passed-rule="core/canonical"');
    expect(section).toContain("Name of core/canonical");
    expect(section).toContain("2 pages");
    expect(section).toContain("site-wide");
    expect(section).not.toContain("content/word-count");
    // Closed until the reader opens it.
    expect(section).not.toContain('open=""');
  });

  test("html: a page rule whose passes carry no page is not site-wide", () => {
    const html = renderHtml(report({ "core/no-urls": rule("core/no-urls", "core", [pass()]) }), {
      includePassed: true,
    });
    const section = html.slice(html.indexOf('<section id="passed">'));
    expect(section).toContain("pages not recorded");
    expect(section).not.toContain("site-wide");
  });

  test("html: rule text is escaped, nothing remote is loaded, the stylesheet is unchanged", () => {
    const hostile = rule("core/x", "core", [pass("https://example.com/")]);
    hostile.meta.name = '<img src="https://evil.test/x.png" onerror="alert(1)">';
    const plain = report({ "core/x": hostile });
    const html = renderHtml(plain, { includePassed: true });
    expect(html).not.toContain('<img src="https://evil.test');
    expect(html).toContain("&lt;img src=");
    const remote = (s: string) => ["<img", "<link", "<script src"].map((t) => s.split(t).length);
    expect(remote(html)).toEqual(remote(renderHtml(plain)));
    const styles = (s: string) => s.slice(s.indexOf("<style"), s.indexOf("</head>"));
    expect(styles(html)).toBe(styles(renderHtml(plain)));
  });

  test.each(["failed", "blocked"] as const)("a %s run lists no passed rules in any format", (status) => {
    const run = { ...r, status };
    const on = { includePassed: true };
    expect(renderHtml(run, on)).not.toContain('id="passed"');
    expect(renderMarkdown(run, on)).not.toContain("## Passed");
    expect(renderText(run, on)).not.toContain("PASSED");
    expect(JSON.parse(renderJson(run, on)).passedRules).toBeUndefined();
    expect(renderLlm(run, on)).not.toContain("<passed");
    expect(renderXml(run, on)).not.toContain("<passed");
  });

  test("nothing passed: no section, even when asked", () => {
    const none = report({ "content/word-count": RULES["content/word-count"] });
    expect(renderMarkdown(none, { includePassed: true })).not.toContain("## Passed");
    expect(renderText(none, { includePassed: true })).not.toContain("PASSED");
    expect(JSON.parse(renderJson(none, { includePassed: true })).passedRules).toBeUndefined();
    expect(renderHtml(none, { includePassed: true })).not.toContain('id="passed"');
    expect(renderHtml(none, { includePassed: true })).not.toContain('href="#passed"');
  });
});
