// pub#1748: `squirrel report --diff` calls a finding fixed only when its rule ran over the same scope in both
// audits and the current report no longer has it. Everything else that is gone is "not compared".

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
const baseline = () =>
  report({ [RULE]: rule(RULE, [fail("charset", A)]) }, { id: "base" });

const reasonOf = (d: ReturnType<typeof diffReports>) =>
  d.notCompared?.map((n) => [n.reason, n.detail]) ?? [];

describe("report --diff: fixed needs the rule to have run over the same scope (#1748)", () => {
  test("the rule ran again and no longer reports it: fixed", () => {
    const d = diffReports(
      baseline(),
      report({ [RULE]: rule(RULE, [pass("charset")]) })
    );
    expect(d.removed).toHaveLength(1);
    expect(d.summary.removed).toBe(1);
    expect(d.notCompared).toBeUndefined();
    expect(d.summary.notCompared).toBeUndefined();
  });

  test("still present: not removed, not not-compared", () => {
    const d = diffReports(
      baseline(),
      report({ [RULE]: rule(RULE, [fail("charset", A)]) })
    );
    expect(d.removed).toHaveLength(0);
    expect(d.notCompared).toBeUndefined();
  });

  test("the rule did not run (no result at all): not compared, not fixed", () => {
    const d = diffReports(baseline(), report({}));
    expect(d.removed).toHaveLength(0);
    expect(d.summary.removed).toBe(0);
    expect(reasonOf(d)).toEqual([["rule-not-run", undefined]]);
    expect(d.summary.notCompared).toBe(1);
  });

  test("the rule was skipped (a targeted run): not compared, with the coded reason", () => {
    const d = diffReports(
      baseline(),
      report({ [RULE]: rule(RULE, [skipped("charset", "targeted-run")]) })
    );
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["rule-skipped", "targeted-run"]]);
  });

  test("the rule timed out: not compared", () => {
    const d = diffReports(
      baseline(),
      report({ [RULE]: rule(RULE, [skipped("charset", "rule-timed-out")]) })
    );
    expect(reasonOf(d)).toEqual([["rule-timed-out", undefined]]);
  });

  test("the page was not crawled in the current audit: not compared", () => {
    const d = diffReports(
      baseline(),
      report({ [RULE]: rule(RULE, [pass("charset")]) }, { pages: [B] })
    );
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["page-not-crawled", A]]);
  });

  test("the rule skipped that page (a noindex page): not compared", () => {
    const d = diffReports(
      baseline(),
      report({
        [RULE]: rule(RULE, [pass("charset"), skipped("charset", "noindex", A)]),
      })
    );
    expect(reasonOf(d)).toEqual([["rule-skipped-on-page", A]]);
  });

  test("an item's source pages are all needed: one uncrawled page leaves it not compared", () => {
    const withItem = report(
      {
        "links/broken-links": rule("links/broken-links", [
          {
            name: "broken-links",
            status: "fail",
            message: "1 broken",
            items: [{ id: `${BASE}/gone`, sourcePages: [A, B] }],
          },
        ]),
      },
      { id: "base" }
    );
    const later = (pages: string[]) =>
      report(
        {
          "links/broken-links": rule("links/broken-links", [
            pass("broken-links"),
          ]),
        },
        { pages }
      );
    expect(diffReports(withItem, later([A, B])).removed).toHaveLength(1);
    expect(reasonOf(diffReports(withItem, later([A])))).toEqual([
      ["page-not-crawled", B],
    ]);
  });

  test("the two audits are of different sites: not compared", () => {
    const d = diffReports(
      baseline(),
      report(
        { [RULE]: rule(RULE, [pass("charset")]) },
        { baseUrl: "https://other.example", pages: [A, B] }
      )
    );
    expect(reasonOf(d)).toEqual([["different-scope", undefined]]);
  });

  test("a finding the baseline only carried from an older audit is not compared", () => {
    const carried = report({
      [RULE]: rule(RULE, [{ ...fail("charset", A), provenance: "carried" }]),
    });
    const d = diffReports(
      carried,
      report({ [RULE]: rule(RULE, [pass("charset")]) })
    );
    expect(reasonOf(d)).toEqual([["rule-not-run-in-baseline", undefined]]);
  });
});

describe("the declared problem to clean linkage is the evidence (#1741)", () => {
  const SECRETS = "security/leaked-secrets";
  const decls: ReadonlyMap<string, readonly RuleCheckDecl[]> = new Map([
    [
      SECRETS,
      [
        { name: "leaked-secrets-critical", outcome: "problem" },
        { name: "leaked-secrets-unfetched", outcome: "skipped" },
        {
          name: "leaked-secrets",
          outcome: "clean",
          clears: ["leaked-secrets-critical"],
        },
      ] satisfies RuleCheckDecl[],
    ],
  ]);
  const before = report(
    {
      [SECRETS]: rule(
        SECRETS,
        [
          {
            name: "leaked-secrets-critical",
            status: "fail",
            message: "key",
          },
        ],
        "site"
      ),
    },
    { id: "base" }
  );

  test("the clean check that supersedes the problem check: fixed", () => {
    const d = diffReports(
      before,
      report({ [SECRETS]: rule(SECRETS, [pass("leaked-secrets")], "site") }),
      { checkDecls: decls }
    );
    expect(d.removed.map((i) => i.checkName)).toEqual([
      "leaked-secrets-critical",
    ]);
  });

  test("the rule answered with a declared not-checked check and no clean check: not compared", () => {
    const d = diffReports(
      before,
      report({
        [SECRETS]: rule(
          SECRETS,
          [
            {
              name: "leaked-secrets-unfetched",
              status: "info",
              message: "1 script could not be read",
            },
          ],
          "site"
        ),
      }),
      { checkDecls: decls }
    );
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["not-evaluated", undefined]]);
  });
});

describe("the not-compared group is in every diff format and out of the removed count", () => {
  const d = diffReports(
    baseline(),
    report({ [RULE]: rule(RULE, [skipped("charset", "targeted-run")]) })
  );

  test("JSON carries the group and the count; removed stays zero", () => {
    const json = d as unknown as {
      summary: { removed: number; notCompared: number };
      notCompared: Array<{
        reason: string;
        detail: string;
        issue: { ruleId: string };
      }>;
    };
    // generateDiffJson prints JSON.stringify of this object, so the key is in the output.
    expect(JSON.stringify(d)).toContain('"notCompared"');
    expect(json.summary.removed).toBe(0);
    expect(json.summary.notCompared).toBe(1);
    expect(json.notCompared[0]).toMatchObject({
      reason: "rule-skipped",
      detail: "targeted-run",
      issue: { ruleId: RULE },
    });
  });

  test("text lists it under its own heading, apart from REMOVED", () => {
    const text = renderDiffText(d);
    expect(text).toContain("Not compared: 1");
    expect(text).toContain("NOT COMPARED (not counted as fixed)");
    expect(text).toContain(
      "the rule was skipped in the current audit (targeted-run)"
    );
    expect(text.indexOf("REMOVED")).toBeLessThan(text.indexOf("NOT COMPARED"));
    expect(text).toMatch(/REMOVED\n\(none\)/);
  });

  test("markdown has a Not compared section with the reason", () => {
    const md = renderDiffMarkdown(d);
    expect(md).toContain("1 not compared");
    expect(md).toContain("## Not compared (not counted as fixed)");
    expect(md).toContain(
      "the rule was skipped in the current audit (targeted-run)"
    );
  });

  test("the llm format has a not-compared element and a summary count", () => {
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
    const xml = chunks.join("");
    expect(xml).toContain('not-compared="1"');
    expect(xml).toContain('<not-compared-issue reason="rule-skipped"');
  });

  test("a diff with nothing not compared has no such group or count", () => {
    const clean = diffReports(
      baseline(),
      report({ [RULE]: rule(RULE, [pass("charset")]) })
    );
    expect(renderDiffText(clean)).not.toContain("NOT COMPARED");
    expect(renderDiffMarkdown(clean)).not.toContain("Not compared");
    expect(JSON.stringify(clean)).not.toContain("notCompared");
  });
});

// #1772: a link that moves between `broken-links` and `broken-links-sitewide` is the same finding under another
// name: never fixed, never a new one, and a link fixed outright is still fixed.
describe("a link that moves between the content and the site-wide check (#1772)", () => {
  const LINKS = "links/broken-links";
  const link = `${BASE}/gone`;
  const row = (name: string, status: "fail" | "pass"): CheckResult =>
    status === "fail"
      ? {
          name,
          status,
          message: "1 broken internal link(s)",
          items: [{ id: link, sourcePages: [A, B] }],
        }
      : { name, status, message: "ok" };
  const at = (checks: CheckResult[]) =>
    report({ [LINKS]: rule(LINKS, checks, "site") });

  test("content to site-wide: one change, not fixed and not added", () => {
    const d = diffReports(
      at([row("broken-links", "fail")]),
      at([row("broken-links-sitewide", "fail")])
    );
    expect(d.removed).toHaveLength(0);
    expect(d.added).toHaveLength(0);
    expect(d.changed).toHaveLength(1);
  });

  test("site-wide to content: the same", () => {
    const d = diffReports(
      at([row("broken-links-sitewide", "fail")]),
      at([row("broken-links", "fail")])
    );
    expect(d.removed).toHaveLength(0);
    expect(d.added).toHaveLength(0);
    expect(d.changed).toHaveLength(1);
  });

  test("a content link fixed outright is fixed, though the site-wide check emitted no row", () => {
    const d = diffReports(
      at([row("broken-links", "fail")]),
      at([row("broken-links", "pass")])
    );
    expect(d.removed).toHaveLength(1);
    expect(d.notChecked).toBeUndefined();
    expect(d.notCompared).toBeUndefined();
  });
});

// A pageless skip row of the issue's own check is a coverage gap of that check: the finding may be among the links
// that were not checked, so its absence is not a fix.
describe("a coverage gap in the issue's own check (#1748 review)", () => {
  const EXT = "links/broken-external-links";
  const LINKS_RULE = "links/broken-links";
  const x = "https://dead.example-live.net/x";
  const y = "https://dead.example-live.net/y";
  const failOn = (name: string, id: string, pages = [A]): CheckResult => ({
    name,
    status: "fail",
    message: "1 broken",
    items: [{ id, sourcePages: pages }],
  });
  const gap = (name: string, skipReason: string): CheckResult => ({
    name,
    status: "skipped",
    message: "not checked",
    skipReason,
  });
  const at = (ruleId: string, checks: CheckResult[]) =>
    report({ [ruleId]: rule(ruleId, checks, "site") });

  test("an external link past the cap is not compared, never fixed", () => {
    const d = diffReports(
      at(EXT, [failOn("broken-external-links", x)]),
      at(EXT, [
        failOn("broken-external-links", y),
        gap("broken-external-links", "external-links-over-cap"),
      ])
    );
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["rule-skipped", "external-links-over-cap"]]);
  });

  test("the same when the external check ran out of time", () => {
    const d = diffReports(
      at(EXT, [failOn("broken-external-links", x)]),
      at(EXT, [
        failOn("broken-external-links", y),
        gap("broken-external-links", "external-links-out-of-time"),
      ])
    );
    expect(reasonOf(d)).toEqual([
      ["rule-skipped", "external-links-out-of-time"],
    ]);
  });

  test("internal link targets that were not fetched are not compared", () => {
    const d = diffReports(
      at(LINKS_RULE, [failOn("broken-links", `${BASE}/gone`)]),
      at(LINKS_RULE, [
        failOn("broken-links", `${BASE}/other`),
        gap("broken-links", "link-targets-not-fetched"),
      ])
    );
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["rule-skipped", "link-targets-not-fetched"]]);
  });

  test("the peer check's gap counts: a site-wide finding with the content check's gap is not compared", () => {
    const d = diffReports(
      at(LINKS_RULE, [failOn("broken-links-sitewide", `${BASE}/gone`)]),
      at(LINKS_RULE, [
        failOn("broken-links", `${BASE}/other`),
        gap("broken-links", "link-targets-not-fetched"),
      ])
    );
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["rule-skipped", "link-targets-not-fetched"]]);
  });

  test("control: a gap in another check of the rule does not hold a fix back", () => {
    const d = diffReports(
      at(LINKS_RULE, [failOn("broken-links", `${BASE}/gone`)]),
      at(LINKS_RULE, [
        { name: "broken-links", status: "pass", message: "ok" },
        gap("refused-links", "link-targets-not-fetched"),
      ])
    );
    expect(d.removed).toHaveLength(1);
  });
});

// A report rebuilt from `report --input` holds a sample of each check's pages and no passing rows.
describe("a current side rebuilt from a slim JSON export (#1748 review)", () => {
  const issue = (affectedPages: string[], hasMore?: boolean) => ({
    ruleId: "core/charset",
    name: "core/charset",
    description: "",
    domain: "core",
    severity: "error" as const,
    checks: [
      {
        name: "charset",
        status: "fail" as const,
        message: "missing",
        affectedPages,
        ...(hasMore === undefined ? {} : { affectedPagesHasMore: hasMore }),
      },
    ],
  });
  const slim = (issues: ReturnType<typeof issue>[], rules?: unknown[]) =>
    convertSlimReport({
      meta: {
        version: "1",
        baseUrl: BASE,
        timestamp: "2026-11-12T00:00:00.000Z",
        totalPages: 2,
      },
      score: { overall: 80, grade: "B", categories: [] },
      summary: { passed: 0, warnings: 0, failed: 1 },
      issues,
      ...(rules ? { rules } : {}),
    } as never);
  const baseline = () =>
    report({ [RULE]: rule(RULE, [fail("charset", B)]) }, { id: "base" });
  const ran = [{ ruleId: RULE, status: "ran", scope: { pages: 2 } }];

  test("an export with no `rules` list cannot show anything fixed", () => {
    const d = diffReports(baseline(), slim([issue([A], false)]));
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["sampled-report", undefined]]);
  });

  test("a check whose page sample was cut cannot show a page fixed", () => {
    const d = diffReports(baseline(), slim([issue([A], true)], ran));
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["sampled-report", undefined]]);
  });

  test("an export that lists the check whole and says the rule ran can show a fix", () => {
    const d = diffReports(baseline(), slim([issue([A], false)], ran));
    expect(d.removed).toHaveLength(1);
  });
});

// #1778: a targeted audit runs the site rules that can be judged from the listed pages. A finding that names a
// page is compared by that page; one that names none is about the whole site and a targeted run cannot speak for it.
describe("a targeted current audit against a full baseline (#1778)", () => {
  const SITE_RULE = "security/csp";
  const withTargeted = (r: AuditReport): AuditReport =>
    ({
      ...r,
      scanScope: {
        origin: "cli",
        pagesCrawled: 1,
        capped: false,
        targeted: { requested: 1, audited: 1, unaudited: [] },
      },
    }) as unknown as AuditReport;
  const siteRule = (checks: CheckResult[]) => rule(SITE_RULE, checks, "site");

  test("a whole-site finding with no page is not compared, never fixed", () => {
    const before = report({
      [SITE_RULE]: siteRule([
        { name: "csp-missing", status: "fail", message: "no CSP" },
      ]),
    });
    const now = withTargeted(
      report({
        [SITE_RULE]: siteRule([
          { name: "csp-present", status: "pass", message: "ok" },
        ]),
      })
    );
    const d = diffReports(before, now);
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["targeted-run", undefined]]);
  });

  test("a finding that names its page is compared by that page: a listed page resolves, an unlisted one is not compared", () => {
    const named = (page: string): CheckResult => ({
      name: "broken-links",
      status: "fail",
      message: "1 broken",
      items: [{ id: `${BASE}/gone`, sourcePages: [page] }],
    });
    const links = (checks: CheckResult[]) => ({
      "links/broken-links": rule("links/broken-links", checks, "site"),
    });
    const clean: CheckResult = {
      name: "broken-links",
      status: "pass",
      message: "ok",
    };
    const now = withTargeted(report(links([clean]), { pages: [A] }));
    expect(diffReports(report(links([named(A)])), now).removed).toHaveLength(1);
    const d = diffReports(report(links([named(B)])), now);
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["page-not-crawled", B]]);
  });

  test("two targeted reports over the same list are compared; over different lists they are not (#1778 review)", () => {
    const tgt = (r: AuditReport, digest?: string): AuditReport =>
      ({
        ...r,
        scanScope: {
          origin: "cli",
          pagesCrawled: 1,
          capped: false,
          targeted: {
            requested: 1,
            audited: 1,
            unaudited: [],
            ...(digest ? { digest } : {}),
          },
        },
      }) as unknown as AuditReport;
    const missing = () =>
      report({
        [SITE_RULE]: siteRule([
          { name: "csp-missing", status: "fail", message: "x" },
        ]),
      });
    const present = () =>
      report({
        [SITE_RULE]: siteRule([
          { name: "csp-present", status: "pass", message: "ok" },
        ]),
      });
    // [/a] then [/a]: the same page judged twice, so the fix is real.
    expect(
      diffReports(tgt(missing(), "aaa"), tgt(present(), "aaa")).removed
    ).toHaveLength(1);
    // [/a] then [/b]: csp-missing was read off /a, the pass off /b: nothing is fixed.
    const other = diffReports(tgt(missing(), "aaa"), tgt(present(), "bbb"));
    expect(other.removed).toHaveLength(0);
    expect(reasonOf(other)).toEqual([["targeted-run", undefined]]);
    // A report from before the digest cannot show the lists match.
    expect(diffReports(tgt(missing()), tgt(present())).removed).toHaveLength(0);
  });

  test("a site-rule item with no source page is not compared either (#1778 review)", () => {
    const SECRETS = "security/leaked-secrets";
    const before = report({
      [SECRETS]: rule(
        SECRETS,
        [
          {
            name: "leaked-secrets-high",
            status: "fail",
            message: "1 secret",
            items: [{ id: "AKIA…" }],
          },
        ],
        "site"
      ),
    });
    const now = withTargeted(
      report({
        [SECRETS]: rule(
          SECRETS,
          [{ name: "leaked-secrets", status: "pass", message: "ok" }],
          "site"
        ),
      })
    );
    const d = diffReports(before, now);
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["targeted-run", undefined]]);
  });
});

// #1778: a targeted run emits the link checks too, so one that hits the external cap must not fix a baseline link.
describe("a targeted run that hits the external link cap (#1778)", () => {
  const EXT = "links/broken-external-links";
  const x = "https://dead.example-live.net/x";
  test("a baseline broken external link is not fixed by a targeted run that left links unchecked", () => {
    const before = report({
      [EXT]: rule(
        EXT,
        [
          {
            name: "broken-external-links",
            status: "fail",
            message: "1 broken",
            items: [{ id: x, sourcePages: [A] }],
          },
        ],
        "site"
      ),
    });
    const now = report({
      [EXT]: rule(
        EXT,
        [
          {
            name: "broken-external-links",
            status: "fail",
            message: "1 broken",
            items: [
              { id: "https://dead.example-live.net/y", sourcePages: [A] },
            ],
          },
          {
            name: "broken-external-links",
            status: "skipped",
            message: "over the cap",
            skipReason: "external-links-over-cap",
          },
        ],
        "site"
      ),
    });
    const targeted = {
      ...now,
      scanScope: {
        origin: "cli",
        pagesCrawled: 1,
        capped: false,
        targeted: { requested: 1, audited: 1, unaudited: [] },
      },
    } as unknown as AuditReport;
    const d = diffReports(before, targeted);
    expect(d.removed).toHaveLength(0);
    expect(reasonOf(d)).toEqual([["rule-skipped", "external-links-over-cap"]]);
  });
});

// #1780: eleven per-crawler rows became one wildcard row.
describe("per-crawler rows that became one wildcard row (#1780)", () => {
  const AI = "ax/ai-crawlers";
  const warnRow = (name: string, ids: string[]): CheckResult => ({
    name,
    status: "warn",
    message: "blocked",
    items: ids.map((id) => ({ id })),
  });
  const at = (checks: CheckResult[]) =>
    report({ [AI]: rule(AI, checks, "site") });

  test("the old rows are one change into the new row: nothing fixed, one finding not added", () => {
    const before = at([
      warnRow("ai-answer-access", ["OAI-SearchBot", "ChatGPT-User"]),
      warnRow("archive-crawler-access", ["CCBot"]),
    ]);
    const now = at([
      warnRow("ai-crawlers-wildcard-blocked", ["User-agent: *"]),
    ]);
    const d = diffReports(before, now);
    expect(d.removed).toHaveLength(0);
    expect(d.added).toHaveLength(0);
    expect(d.changed).toHaveLength(1);
  });

  test("only a crawler the wildcard row lists continues in it: one allowed by name is fixed (#1780 review)", () => {
    const before = at([
      warnRow("ai-answer-access", ["OAI-SearchBot", "ChatGPT-User"]),
    ]);
    const wildcard: CheckResult = {
      name: "ai-crawlers-wildcard-blocked",
      status: "warn",
      message: "blocked",
      items: [{ id: "User-agent: *", meta: { crawlers: ["OAI-SearchBot"] } }],
    };
    const d = diffReports(before, at([wildcard]));
    expect(d.removed.map((i) => i.target.id)).toEqual(["ChatGPT-User"]);
    expect(d.changed).toHaveLength(1);
    expect(d.added).toHaveLength(0);
  });

  test("control: the wildcard is gone, so the old rows are fixed", () => {
    const before = at([
      warnRow("ai-answer-access", ["OAI-SearchBot", "ChatGPT-User"]),
    ]);
    const now = at([
      { name: "ai-crawler-access", status: "info", message: "all allowed" },
    ]);
    expect(diffReports(before, now).removed).toHaveLength(2);
  });
});
