// #1778: a targeted run runs some site rules (security headers, links) over the listed pages only. A finding
// from an earlier full audit is fixed only when a listed page shows it gone. One that names no page (a header
// read off the full audit's entry page) is never called fixed by a targeted run, whatever the listed pages say.

import { describe, expect, test } from "bun:test";

import type {
  AuditReport,
  CheckResult,
  ReportRuleResult,
} from "../../src/types";

import { diffReports } from "../../src/reports/diff";
import { notComparedRows } from "../../src/reports/diff/not-compared";

const BASE = "https://example.com";
const HOME = `${BASE}/`;
const A = `${BASE}/a`;
const B = `${BASE}/b`;

const rule = (id: string, checks: CheckResult[]): ReportRuleResult => ({
  meta: {
    id,
    name: id,
    description: id,
    category: "security",
    scope: "site",
    severity: "warning",
    weight: 5,
  },
  checks,
});

const report = (
  ruleResults: Record<string, ReportRuleResult>,
  opts: { pages: string[]; targeted?: boolean }
): AuditReport =>
  ({
    crawlId: "c",
    baseUrl: BASE,
    timestamp: "2026-11-20T00:00:00.000Z",
    totalPages: opts.pages.length,
    passed: 0,
    warnings: 0,
    failed: 0,
    siteChecks: [],
    pages: opts.pages.map((url) => ({ url })),
    summary: {},
    ruleResults,
    ...(opts.targeted
      ? {
          scanScope: {
            targeted: {
              requested: opts.pages.length,
              audited: opts.pages.length,
              unaudited: [],
            },
          },
        }
      : {}),
  }) as unknown as AuditReport;

const HSTS = "security/hsts";
const ROBOTS = "crawl/robots-txt";
const missing: CheckResult = {
  name: "hsts-missing",
  status: "warn",
  message: "Missing Strict-Transport-Security header",
};
const ok = (pages?: string[]): CheckResult => ({
  name: "hsts",
  status: "pass",
  message: "HSTS configured correctly",
  ...(pages ? { pages } : {}),
});

const fullBaseline = () =>
  report({ [HSTS]: rule(HSTS, [missing]) }, { pages: [HOME, A, B] });

describe("report --diff after a targeted run (#1778)", () => {
  test("a pageless site finding from a full audit is not compared, never fixed, by a targeted run", () => {
    // The targeted run judged /a, which sends the header; the full audit read the home page, which did not.
    const d = diffReports(
      fullBaseline(),
      report({ [HSTS]: rule(HSTS, [ok([A])]) }, { pages: [A], targeted: true })
    );
    expect(d.removed).toHaveLength(0);
    expect(d.summary.removed).toBe(0);
    expect(d.notCompared?.map((n) => n.reason)).toEqual(["targeted-run"]);
    expect(notComparedRows(d).map((r) => r.text)).toEqual([
      "the current audit was targeted and the issue names no page it audited",
    ]);
  });

  test("control: the same report as an ordinary audit calls it fixed", () => {
    const d = diffReports(
      fullBaseline(),
      report({ [HSTS]: rule(HSTS, [ok()]) }, { pages: [HOME, A, B] })
    );
    expect(d.removed).toHaveLength(1);
    expect(d.notCompared).toBeUndefined();
  });

  test("a finding on a listed page is compared: gone there means fixed", () => {
    const baseline = report(
      { [HSTS]: rule(HSTS, [{ ...missing, pages: [A, B] }]) },
      { pages: [HOME, A, B] }
    );
    const d = diffReports(
      baseline,
      report({ [HSTS]: rule(HSTS, [ok([A])]) }, { pages: [A], targeted: true })
    );
    // /a was listed and now sends the header: fixed. /b was not listed: not compared.
    expect(d.removed.map((i) => i.target.id)).toEqual([A]);
    expect(d.notCompared?.map((n) => [n.reason, n.detail])).toEqual([
      ["page-not-crawled", B],
    ]);
  });

  test("robots.txt is fetched by every run, so its pageless finding is still compared", () => {
    const baseline = report(
      {
        [ROBOTS]: rule(ROBOTS, [
          {
            name: "robots-txt-exists",
            status: "fail",
            message: "No robots.txt",
          },
        ]),
      },
      { pages: [HOME, A] }
    );
    const d = diffReports(
      baseline,
      report(
        {
          [ROBOTS]: rule(ROBOTS, [
            { name: "robots-txt-exists", status: "pass", message: "ok" },
          ]),
        },
        { pages: [A], targeted: true }
      )
    );
    expect(d.removed).toHaveLength(1);
    expect(d.notCompared).toBeUndefined();
  });
});
