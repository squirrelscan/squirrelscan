// repo#2729: a link check that did not run (external link checking off, a crawl
// that did not follow links) is shown as "Not checked" in every format, with the
// reason and what to run instead. Never as a pass, never as an issue, never
// left out so the rule reads as clean.

import { describe, expect, test } from "bun:test";

import {
  CRAWL_CAPPED_SKIP_REASON,
  EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
  EXTERNAL_LINKS_OVER_CAP_SKIP_REASON,
  LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
} from "@squirrelscan/core-contracts";

import { buildEditorSummaryRequest } from "../src/editor-summary";
import { notCheckedLines, notCheckedRules } from "../src/not-checked";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import type { AuditReport, ReportRuleResult } from "../src/types";

function rule(
  id: string,
  name: string,
  severity: ReportRuleResult["meta"]["severity"],
  checks: ReportRuleResult["checks"],
): ReportRuleResult {
  return {
    meta: {
      id,
      name,
      description: `${name} description`,
      category: "links",
      scope: "site",
      severity,
      weight: 5,
    },
    checks,
  };
}

const EXTERNAL_MESSAGE =
  "External link checking was off for this audit, so 3 external link(s) on the audited pages were not checked";
const INTERNAL_MESSAGE =
  "2 of 5 internal link target(s) were not fetched because this audit did not follow links, so they were not checked for broken links";

function quickReport(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-12T10:00:00.000Z",
    totalPages: 3,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {
      "links/broken-external-links": rule(
        "links/broken-external-links",
        "Broken External Links",
        "warning",
        [
          {
            name: "broken-external-links",
            status: "skipped",
            message: EXTERNAL_MESSAGE,
            skipReason: EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
          },
        ],
      ),
      "links/broken-links": rule("links/broken-links", "Broken Links", "error", [
        {
          name: "broken-links",
          status: "skipped",
          message: INTERNAL_MESSAGE,
          skipReason: LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
        },
      ]),
      // Info summary of the same gap: listed once, under the rule that reports it.
      "links/dead-links": rule("links/dead-links", "Dead Links (Cloud)", "info", [
        {
          name: "dead-links",
          status: "skipped",
          message: "External link checking was off for this audit, so external links were not verified",
          skipReason: EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
        },
      ]),
      "core/meta-title": rule("core/meta-title", "Meta Title", "error", [
        { name: "meta-title", status: "pass", message: "Title OK", pageUrl: "https://example.com/" },
      ]),
    },
  };
}

const EXTERNAL_LINE = `Not checked: Broken External Links. ${EXTERNAL_MESSAGE}. Turn external link checks on to check them: in the CLI pass --external-links (or drop --no-external-links, --offline, or external_links.enabled = false); in the cloud they are a website setting.`;
const INTERNAL_LINE = `Not checked: Broken Links. ${INTERNAL_MESSAGE}. Turn internal link checks back on (they are off with --no-internal-links or internal_links.enabled = false), raise internal_links.max_targets, or run a Surface or Full audit, which follows links, to check them.`;

describe("notCheckedRules / notCheckedLines", () => {
  test("one entry per rule, by name, with the reason and a hint; info rules left out", () => {
    expect(notCheckedRules(quickReport()).map((r) => [r.ruleId, r.reason])).toEqual([
      ["links/broken-external-links", EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON],
      ["links/broken-links", LINK_TARGETS_NOT_FETCHED_SKIP_REASON],
    ]);
    expect(notCheckedLines(quickReport())).toEqual([EXTERNAL_LINE, INTERNAL_LINE]);
  });

  test("external links over the audit's limit are not checked, with the limit's hint", () => {
    const report = quickReport();
    const message =
      "40 of 240 external link(s) were not checked: over this audit's limit of 200, which checks the most-linked first";
    report.ruleResults = {
      "links/broken-external-links": rule("links/broken-external-links", "Broken External Links", "warning", [
        { name: "broken-external-links", status: "pass", message: "All 200 external link(s) are working" },
        {
          name: "broken-external-links",
          status: "skipped",
          message,
          skipReason: EXTERNAL_LINKS_OVER_CAP_SKIP_REASON,
        },
      ]),
    };
    expect(notCheckedLines(report)).toEqual([
      `Not checked: Broken External Links. ${message}. Raise the limit with external_links.max_links, or audit more pages, to check them.`,
    ]);
  });

  test("a crawl that stopped at its page cap leaves the inbound-link rules not checked (#1144)", () => {
    const message = "Crawl stopped at its 100-page cap, so an inbound link may sit on a page not crawled";
    const report = {
      ruleResults: {
        "links/orphan-pages": rule("links/orphan-pages", "Orphan Pages", "warning", [
          {
            name: "orphan-pages",
            status: "skipped",
            message,
            skipReason: CRAWL_CAPPED_SKIP_REASON,
          },
        ]),
      },
    };
    expect(notCheckedRules(report)).toEqual([
      expect.objectContaining({
        ruleId: "links/orphan-pages",
        reason: CRAWL_CAPPED_SKIP_REASON,
        message,
        hint: expect.stringContaining("--max-pages"),
      }),
    ]);
  });

  test("other skip reasons are not 'not checked'", () => {
    const report = quickReport();
    report.ruleResults = {
      "content/hidden-text": rule("content/hidden-text", "Hidden text", "warning", [
        { name: "hidden-text", status: "skipped", message: "x", skipReason: "scan-truncated" },
      ]),
    };
    expect(notCheckedRules(report)).toEqual([]);
  });

  test("a rule abandoned for its time budget is shown as not checked, a security rule included (pub#960)", () => {
    const report = quickReport();
    const message = "Rule not evaluated: exceeded its 1000 ms time budget and was abandoned";
    report.ruleResults = {
      "security/leaked-secrets": rule("security/leaked-secrets", "Leaked Secrets", "error", [
        { name: "leaked-secrets", status: "pass", message: "ok", pageUrl: "https://example.com/a" },
        {
          name: "security/leaked-secrets-error",
          status: "skipped",
          message,
          skipReason: "rule-timed-out",
          pageUrl: "https://example.com/b",
          details: { timedOut: true, ruleId: "security/leaked-secrets", budgetMs: 1000, elapsedMs: 1400 },
        },
      ]),
    };
    expect(notCheckedLines(report)).toEqual([
      `Not checked: Leaked Secrets. Leaked Secrets timed out on 1 page (exceeded its 1000 ms time budget). A timed-out rule did not check those pages, so no finding there is not a clean result. Run the audit again, or raise [rules] time_budget_ms if the machine was busy.`,
    ]);
    // The rule and the page count come from the `-timeouts` row when it is there.
    report.ruleResults["security/leaked-secrets"]!.checks.push({
      name: "security/leaked-secrets-timeouts",
      status: "info",
      message: "2 pages not checked",
      details: { timedOut: true, budgetMs: 1000, pagesNotChecked: 2 },
    });
    expect(notCheckedLines(report)[0]).toContain("Leaked Secrets timed out on 2 pages (exceeded its 1000 ms time budget).");
    // Without the summary row (a published report may cut it) the folded skip's
    // own counts still say how many pages.
    const cut = quickReport();
    cut.ruleResults = {
      "security/leaked-secrets": rule("security/leaked-secrets", "Leaked Secrets", "error", [
        {
          name: "security/leaked-secrets-error",
          status: "skipped",
          message,
          skipReason: "rule-timed-out",
          details: { timedOut: true, budgetMs: 1000, occurrences: 20, pagesTruncated: 20 },
        },
      ]),
    };
    expect(notCheckedLines(cut)[0]).toContain("Leaked Secrets timed out on 20 pages");
    // The console and the other formats print it, not only the info row.
    expect(renderText(report)).toContain("Not checked: Leaked Secrets.");
    expect(renderMarkdown(report)).toContain("Leaked Secrets");
  });

  test("no em-dash in the copy", () => {
    for (const line of notCheckedLines(quickReport())) expect(line).not.toContain("—");
  });
});

describe("every format shows it, never as an issue", () => {
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  test("text", () => {
    const out = renderText(quickReport());
    expect(count(out, EXTERNAL_LINE)).toBe(1);
    expect(count(out, INTERNAL_LINE)).toBe(1);
  });

  test("markdown, escaped like any message a published report carries", () => {
    const out = renderMarkdown(quickReport());
    // The lines' only markdown punctuation: the "(s)" plural and the
    // underscore in a config key.
    const escaped = (line: string) =>
      line.replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("_", "\\_");
    expect(count(out, `**${escaped(EXTERNAL_LINE)}**`)).toBe(1);
    expect(count(out, `**${escaped(INTERNAL_LINE)}**`)).toBe(1);
    expect(out).toContain("link\\(s\\)");
  });

  test("html", () => {
    const out = renderHtml(quickReport());
    expect(count(out, EXTERNAL_LINE)).toBe(1);
    expect(count(out, INTERNAL_LINE)).toBe(1);
  });

  test("llm: one not-checked element naming each rule, and no issues", () => {
    const out = renderLlm(quickReport());
    expect(count(out, '<not-checked count="2">')).toBe(1);
    expect(
      count(
        out,
        `<rule id="links/broken-external-links" name="Broken External Links" check="broken-external-links" reason="external-links-not-checked">${EXTERNAL_LINE}</rule>`,
      ),
    ).toBe(1);
    expect(out).toContain('reason="link-targets-not-fetched"');
    expect(out).toContain("<issues/>");
  });

  test("xml: one not-checked element naming each rule", () => {
    const out = renderXml(quickReport());
    expect(count(out, '<not-checked count="2">')).toBe(1);
    expect(count(out, `reason="external-links-not-checked">${EXTERNAL_LINE}</rule>`)).toBe(1);
  });

  test("json: a notChecked list, no issues, nothing scored", () => {
    const parsed = JSON.parse(renderJson(quickReport()));
    expect(parsed.notChecked).toEqual([
      {
        ruleId: "links/broken-external-links",
        name: "Broken External Links",
        check: "broken-external-links",
        reason: EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
        message: EXTERNAL_LINE,
      },
      {
        ruleId: "links/broken-links",
        name: "Broken Links",
        check: "broken-links",
        reason: LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
        message: INTERNAL_LINE,
      },
    ]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.summary.skipped).toBe(0);
  });

  test("a report where every check ran carries none of it", () => {
    const report = quickReport();
    report.ruleResults = { "core/meta-title": report.ruleResults["core/meta-title"]! };
    expect(renderText(report)).not.toContain("Not checked:");
    expect(renderLlm(report)).not.toContain("not-checked");
    expect(JSON.parse(renderJson(report)).notChecked).toBeUndefined();
  });
});

describe("editor summary request (repo#2729)", () => {
  test("names the checks that did not run, so the summary can say so", () => {
    expect(buildEditorSummaryRequest(quickReport()).notChecked).toEqual([
      {
        ruleId: "links/broken-external-links",
        title: "Broken External Links",
        reason: EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
      },
      {
        ruleId: "links/broken-links",
        title: "Broken Links",
        reason: LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
      },
    ]);
  });

  test("absent when every check ran", () => {
    const report = quickReport();
    report.ruleResults = { "core/meta-title": report.ruleResults["core/meta-title"]! };
    expect("notChecked" in buildEditorSummaryRequest(report)).toBe(false);
  });
});
