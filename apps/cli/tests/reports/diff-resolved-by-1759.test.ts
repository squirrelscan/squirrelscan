// pub#1759 (b): a baseline finding on a page that now redirects (a #1762 redirect row) or answers 404/410 is
// removed with the reason named, instead of "page not crawled": the audit looked, and the page is gone from its URL.

import { describe, expect, test } from "bun:test";

import type {
  AuditReport,
  CheckResult,
  ReportRuleResult,
} from "../../src/types";

import { diffReports } from "../../src/reports/diff";
import { generateDiffLlm } from "../../src/reports/diff/output";
import { renderDiffMarkdown } from "../../src/reports/diff/output/markdown";
import { renderDiffText } from "../../src/reports/diff/output/text";

const BASE = "https://example.com";
const A = `${BASE}/a`;
const OLD = `${BASE}/old`;
const GONE = `${BASE}/gone`;
const RULE = "core/charset";

const rule: ReportRuleResult = {
  meta: {
    id: RULE,
    name: RULE,
    description: RULE,
    category: "core",
    scope: "page",
    severity: "error",
    weight: 5,
  },
  checks: [],
};
const fail = (page: string): CheckResult => ({
  name: "charset",
  status: "fail",
  message: `charset on ${page}`,
  pageUrl: page,
});
const report = (
  checks: CheckResult[],
  extra: Record<string, unknown> = {},
  pages: string[] = [A]
): AuditReport =>
  ({
    crawlId: "c",
    baseUrl: BASE,
    timestamp: "2026-11-12T00:00:00.000Z",
    totalPages: pages.length,
    passed: 0,
    warnings: 0,
    failed: 0,
    siteChecks: [],
    pages: pages.map((url) => ({ url })),
    summary: {},
    ruleResults: { [RULE]: { ...rule, checks } },
    ...extra,
  }) as unknown as AuditReport;

const baseline = () =>
  report([fail(A), fail(OLD), fail(GONE)], {}, [A, OLD, GONE]);
// Current: /a is still failing; /old and /gone left the pages list.
const current = (extra: Record<string, unknown>) => report([fail(A)], extra);

describe("report --diff names why a finding on a changed page is gone (#1759)", () => {
  test("a 301 page is removed with its destination, not page-not-crawled", () => {
    const d = diffReports(
      baseline(),
      current({
        redirects: [
          { url: OLD, finalUrl: `${BASE}/new`, status: 301, hops: 1 },
        ],
      })
    );
    const row = d.removed.find((i) => i.target.id === OLD);
    expect(row?.resolvedBy).toEqual({
      kind: "redirected",
      status: 301,
      to: `${BASE}/new`,
    });
    expect(d.notCompared?.map((n) => n.detail)).toEqual([GONE]);
  });

  test("a 410 and a 404 name the status", () => {
    const d = diffReports(
      baseline(),
      current({
        unstoredPages: [
          { url: GONE, outcome: "error", reason: "http-410" },
          { url: OLD, outcome: "error", reason: "http-404" },
        ],
      })
    );
    const by = (id: string) =>
      d.removed.find((i) => i.target.id === id)?.resolvedBy;
    expect(by(GONE)).toEqual({ kind: "removed", status: 410 });
    expect(by(OLD)).toEqual({ kind: "removed", status: 404 });
    expect(d.notCompared ?? []).toEqual([]);
  });

  test("other unstored reasons stay not compared, and a finding fixed on its page carries no reason", () => {
    const d = diffReports(
      baseline(),
      current({
        unstoredPages: [{ url: OLD, outcome: "error", reason: "http-500" }],
      })
    );
    expect(d.removed.every((i) => i.resolvedBy === undefined)).toBe(true);
    expect(d.notCompared?.map((n) => n.detail).sort()).toEqual(
      [GONE, OLD].sort()
    );
    const fixed = diffReports(
      report([fail(A), fail(OLD)], {}, [A, OLD]),
      report([fail(A)], {}, [A, OLD])
    );
    expect(fixed.removed[0]?.resolvedBy).toBeUndefined();
  });

  test("a destination with | and backticks cannot break the markdown row, and control characters never print", () => {
    const evil = `${BASE}/a|b\`c\`|d\u001b[31mred\u0007`;
    const d = diffReports(
      baseline(),
      current({
        redirects: [{ url: OLD, finalUrl: evil, status: 301, hops: 1 }],
      })
    );
    const md = renderDiffMarkdown(d);
    const row = md.split("\n").find((l) => l.includes(OLD))!;
    // the row keeps its five cells: six pipes with the outer ones, every `|` of the destination escaped
    expect(row.replace(/\\./g, "").split("|").length - 1).toBe(6);
    expect(row).toContain("a\\|b\\`c\\`\\|d");
    expect(md).not.toContain("\u001b");
    expect(renderDiffText(d)).not.toContain("\u001b");
    expect(renderDiffText(d)).toContain("red");
  });

  test("every format says it", () => {
    const d = diffReports(
      baseline(),
      current({
        redirects: [
          { url: OLD, finalUrl: `${BASE}/new`, status: 301, hops: 1 },
        ],
        unstoredPages: [{ url: GONE, outcome: "error", reason: "http-410" }],
      })
    );
    const text = renderDiffText(d);
    expect(text).toContain(`resolved: now redirects to ${BASE}/new (301)`);
    expect(text).toContain("resolved: now returns 410");
    expect(renderDiffMarkdown(d)).toContain(
      `(resolved: now redirects to ${BASE}/new (301))`
    );
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    try {
      generateDiffLlm(d);
    } finally {
      process.stdout.write = write;
    }
    const llm = chunks.join("");
    expect(llm).toContain(
      '<resolved-by kind="redirected" status="301" to="https://example.com/new"/>'
    );
    expect(llm).toContain('<resolved-by kind="removed" status="410"/>');
    expect(JSON.stringify(d.removed)).toContain('"resolvedBy"');
  });
});
