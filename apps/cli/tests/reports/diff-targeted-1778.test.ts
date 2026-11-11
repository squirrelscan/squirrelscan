// pub#1778: targeted audits in `squirrel report --diff`: header findings that gained `details.pageUrl` read as
// unchanged, and a targeted slim export (`report --input`) stays targeted.

import type { RuleCheckDecl } from "@squirrelscan/rules";

import { describe, expect, test } from "bun:test";

import type {
  AuditReport,
  CheckResult,
  ReportRuleResult,
} from "../../src/types";

import { convertSlimReport } from "../../src/controllers/report";
import { diffReports } from "../../src/reports/diff";
import { generateDiffLlm } from "../../src/reports/diff/output";
import { renderDiffMarkdown } from "../../src/reports/diff/output/markdown";
import { renderDiffText } from "../../src/reports/diff/output/text";

const BASE = "https://example.com";
const A = `${BASE}/a`;
const B = `${BASE}/b`;

const rule = (
  id: string,
  checks: CheckResult[],
  scope: "page" | "site" = "page"
): ReportRuleResult => ({
  meta: {
    id,
    name: id,
    description: id,
    category: "core",
    scope,
    severity: "error",
    weight: 5,
  },
  checks,
});

const report = (
  ruleResults: Record<string, ReportRuleResult>,
  opts: { baseUrl?: string; pages?: string[]; id?: string } = {}
): AuditReport =>
  ({
    crawlId: opts.id ?? "c",
    baseUrl: opts.baseUrl ?? BASE,
    timestamp: "2026-11-12T00:00:00.000Z",
    totalPages: (opts.pages ?? [A, B]).length,
    passed: 0,
    warnings: 0,
    failed: 0,
    siteChecks: [],
    pages: (opts.pages ?? [A, B]).map((url) => ({ url })),
    summary: {},
    ruleResults,
  }) as unknown as AuditReport;

const fail = (name: string, page: string): CheckResult => ({
  name,
  status: "fail",
  message: `${name} on ${page}`,
  pageUrl: page,
});
const pass = (name: string): CheckResult => ({
  name,
  status: "pass",
  message: "ok",
});
const skipped = (
  name: string,
  skipReason: string,
  pageUrl?: string
): CheckResult => ({
  name,
  status: "skipped",
  message: "skipped",
  skipReason,
  ...(pageUrl ? { pageUrl } : {}),
});

const RULE = "core/charset";
const reasonOf = (d: ReturnType<typeof diffReports>) =>
  d.notCompared?.map((n) => [n.reason, n.detail]) ?? [];

// #1778: hsts and x-frame-options findings now say which page the header was read from, in their details.
describe("a header finding that gained details.pageUrl (#1778 review)", () => {
  const HSTS = "security/hsts";
  const row = (details?: Record<string, unknown>): CheckResult => ({
    name: "hsts-missing",
    status: "warn",
    message: "Missing Strict-Transport-Security header",
    ...(details ? { details } : {}),
  });
  const at = (c: CheckResult) => report({ [HSTS]: rule(HSTS, [c], "site") });

  test("an old-shape report against a new-shape one reads unchanged: nothing fixed, added or changed", () => {
    const d = diffReports(at(row()), at(row({ pageUrl: `${BASE}/about/` })));
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.changed).toHaveLength(0);
    expect(d.notCompared).toBeUndefined();
  });

  test("and the other way round", () => {
    const d = diffReports(at(row({ pageUrl: `${BASE}/about/` })), at(row()));
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.changed).toHaveLength(0);
  });
});

// #1778: a targeted export read back with `report --input` stays targeted.
describe("a targeted slim export compared with a full audit (#1778 review)", () => {
  const CSP = "security/csp";
  const slimTargeted = (extraMeta: Record<string, unknown> = {}) =>
    convertSlimReport({
      meta: {
        version: "1",
        baseUrl: BASE,
        timestamp: "2026-11-12T00:00:00.000Z",
        totalPages: 1,
        targeted: { requested: 1, audited: 1, unaudited: [], digest: "abc123" },
        ...extraMeta,
      },
      score: { overall: 90, grade: "A", categories: [] },
      summary: { passed: 1, warnings: 0, failed: 0 },
      issues: [],
      rules: [
        { ruleId: CSP, status: "ran", scope: { origin: BASE, targeted: true } },
      ],
    } as never);
  const full = () =>
    report({
      [CSP]: rule(
        CSP,
        [{ name: "csp-missing", status: "warn", message: "No CSP" }],
        "site"
      ),
    });

  test("the export keeps meta.targeted (with its digest) and the rule's targeted scope", () => {
    const r = slimTargeted();
    expect(r.scanScope?.targeted).toMatchObject({
      requested: 1,
      audited: 1,
      digest: "abc123",
    });
    expect(r.slimSource?.rules?.[0]?.scope).toEqual({
      origin: BASE,
      targeted: true,
    });
  });

  test("a whole-site finding with no page is not compared, never fixed", () => {
    const d = diffReports(full(), slimTargeted());
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["targeted-run", undefined]]);
  });

  test("a malformed meta.targeted is dropped, and an ordinary export has none", () => {
    expect(
      slimTargeted({ targeted: { requested: "x", audited: 1 } }).scanScope
        ?.targeted
    ).toBeUndefined();
    expect(
      slimTargeted({
        targeted: { requested: 1, audited: 1, digest: "NOT HEX!" },
      }).scanScope?.targeted
    ).not.toHaveProperty("digest");
  });
});
