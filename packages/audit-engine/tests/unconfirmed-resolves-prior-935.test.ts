// pub#935: since pub#921 the a11y hidden-control rules report a control that a
// `<style>` rule may hide as a `<check>-unconfirmed` warn row in place of the
// `<check>` fail. A page whose only finding moved from `<check>` to
// `<check>-unconfirmed` never reported `<check>` this run, so the resolution
// signal listed it as not evaluated for `<check>` and the merge carried the
// previous audit's fail forever, beside the new unconfirmed warn.
//
// An unconfirmed row says the rule evaluated `<check>` on that page and found
// nothing it could confirm: the prior fail resolves. A page the rule did not
// evaluate at all still carries.
//
// Real rules on the issue's fixture (two pages loading an external stylesheet),
// then the merge as the cloud runs it, with the signal both publish producers
// build.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { createRunner } from "@squirrelscan/rules";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { findingKey } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import { describeSitePagesContract } from "./helpers/site-pages-contract";

class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();

  async getFindings(_siteKey: string, states?: FindingState[]): Promise<PageFindingRecord[]> {
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages(): Promise<SitePageRecord[]> {
    return [...this.pages.values()];
  }
  async upsertFindings(findings: PageFindingRecord[]): Promise<void> {
    for (const f of findings) {
      this.findings.set(findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator), { ...f });
    }
  }
  async upsertSitePages(pages: SitePageRecord[]): Promise<void> {
    for (const p of pages) this.pages.set(p.normalizedUrl, { ...p });
  }
  async markPageRemoved(): Promise<void> {}
  async markPagesRemoved(): Promise<void> {}
  async compactFindings(): Promise<number> {
    return 0;
  }
}

describeSitePagesContract("unconfirmed-resolves-prior-935.test.ts MemStore", () => new MemStore());

const A = "https://example.com/a";
const B = "https://example.com/b";
const C = "https://example.com/c";
const HEAD = '<link rel="stylesheet" href="/site.css"><style>.drawer{display:none}</style>';

/** Rule, its base check, page A's markup (a control a style rule may hide), page B's (named). */
const CASES: Array<[string, string, string, string]> = [
  [
    "a11y/aria-command-name",
    "aria-command-name",
    '<div class="drawer"><span role="button" tabindex="0"></span></div>',
    '<span role="button" tabindex="0" aria-label="Open"></span>',
  ],
  [
    "a11y/button-name",
    "button-name",
    '<div class="drawer"><button></button></div>',
    "<button>Open</button>",
  ],
  [
    "a11y/aria-input-field-name",
    "aria-input-field-name",
    '<div class="drawer"><div role="textbox"></div></div>',
    '<div role="textbox" aria-label="Search"></div>',
  ],
  [
    "a11y/aria-labels",
    "aria-buttons",
    '<div class="drawer"><button></button></div>',
    "<button>Open</button>",
  ],
  [
    "a11y/form-labels",
    "form-labels",
    '<div class="drawer"><input type="text" name="q"></div>',
    '<label>Search <input type="text" name="q"></label>',
  ],
  [
    "a11y/aria-dialog-name",
    "aria-dialog-name",
    '<div class="drawer" role="dialog"><p>x</p></div>',
    '<div role="dialog" aria-label="Menu"><p>x</p></div>',
  ],
  [
    "a11y/aria-dialog-name",
    "dialog-name",
    '<dialog open class="drawer"><p>x</p></dialog>',
    '<dialog open aria-label="Menu"><p>x</p></dialog>',
  ],
  [
    "a11y/aria-hidden-focus",
    "aria-hidden-focus",
    '<div aria-hidden="true"><div class="drawer"><button>x</button></div></div>',
    '<div aria-hidden="true"><p>x</p></div>',
  ],
];

const pageMeta = (id: string) => ({
  id,
  name: id,
  description: id,
  category: "a11y" as const,
  scope: "page" as const,
  severity: "error" as const,
  weight: 10,
});

/** The checks the CURRENT rule emits on one page of the fixture. */
async function ruleChecks(ruleId: string, url: string, body: string): Promise<CheckResult[]> {
  const runner = createRunner({ rule_options: {}, rules: { enable: [ruleId] } });
  const html = `<!doctype html><html lang="en"><head><title>t</title>${HEAD}</head><body><main>${body}</main></body></html>`;
  const page = { url, html, statusCode: 200, loadTime: 0, headers: {} };
  const result = await runner.runPageRules(page, {
    baseUrl: "https://example.com",
    pages: [page],
    robotsTxt: null,
    sitemaps: null,
  });
  return result.checks.map((check) => ({ ...check, pageUrl: url }));
}

const fail = (name: string, url: string): CheckResult => ({
  name,
  status: "fail",
  message: `${name} failed`,
  pageUrl: url,
});
const pass = (name: string, url: string): CheckResult => ({
  name,
  status: "pass",
  message: "ok",
  pageUrl: url,
});

/**
 * Run 1 (the rules before pub#921): `check` fails on A and C, passes on B. Run 2
 * (the current rules): A emits only `<check>-unconfirmed`, B passes, and C is
 * crawled but the rule says nothing about it. Returns run 2's open and resolved
 * findings for the base check.
 */
async function rerun(ruleId: string, check: string, aBody: string, bBody: string) {
  const store = new MemStore();
  const meta = pageMeta(ruleId);
  const statuses = [A, B, C].map((url) => ({ url, status: 200 }));
  await runCloudSmartAudits({
    store,
    siteKey: "web_935",
    crawlId: "audit_1",
    ruleResults: { [ruleId]: { meta, checks: [fail(check, A), pass(check, B), fail(check, C)] } },
    pageStatuses: statuses,
  });

  const current = [
    ...(await ruleChecks(ruleId, A, aBody)),
    ...(await ruleChecks(ruleId, B, bBody)),
  ];
  // The fixture is what the issue describes: A only unconfirmed, B passing.
  expect(current.filter((c) => c.pageUrl === A).map((c) => `${c.name}:${c.status}`)).toEqual([
    `${check}-unconfirmed:warn`,
  ]);
  expect(current.filter((c) => c.pageUrl === B).map((c) => `${c.name}:${c.status}`)).toEqual([
    `${check}:pass`,
  ]);

  const ruleResults = { [ruleId]: { meta, checks: current } };
  await runCloudSmartAudits({
    store,
    siteKey: "web_935",
    crawlId: "audit_2",
    ruleResults,
    pageStatuses: statuses,
    resolutionSignal: buildResolutionSignal(ruleResults, [A, B, C]),
  });
  const of = async (state: FindingState) =>
    (await store.getFindings("web_935", [state]))
      .filter((f) => f.ruleId === ruleId && f.checkName === check)
      .map((f) => f.normalizedUrl)
      .sort();
  return {
    open: await of("open"),
    resolved: await of("resolved"),
    unconfirmed: (await store.getFindings("web_935", ["open"]))
      .filter((f) => f.checkName === `${check}-unconfirmed`)
      .map((f) => f.normalizedUrl),
  };
}

describe("a finding that became unconfirmed resolves its prior fail (pub#935)", () => {
  for (const [ruleId, check, aBody, bBody] of CASES) {
    test(`${ruleId} ${check}: A's prior fail resolves, C (not evaluated) still carries`, async () => {
      const { open, resolved, unconfirmed } = await rerun(ruleId, check, aBody, bBody);
      expect(resolved).toEqual([normalizePageUrl(A)]);
      expect(open).toEqual([normalizePageUrl(C)]);
      expect(unconfirmed).toEqual([normalizePageUrl(A)]);
    });
  }

  // The other way round: a control that was unconfirmed and is now named. The
  // page reports the base check passing and no unconfirmed row, so the prior
  // unconfirmed warn resolves too, while the not-evaluated page still carries.
  test("a prior unconfirmed warn resolves once the control is named", async () => {
    const [ruleId, check, aBody, bBody] = CASES[0]!;
    const store = new MemStore();
    const meta = pageMeta(ruleId);
    const statuses = [A, B, C].map((url) => ({ url, status: 200 }));
    const first = [
      ...(await ruleChecks(ruleId, A, aBody)),
      ...(await ruleChecks(ruleId, B, aBody)),
    ];
    await runCloudSmartAudits({
      store,
      siteKey: "web_935b",
      crawlId: "audit_1",
      ruleResults: {
        [ruleId]: { meta, checks: [...first, ...(await ruleChecks(ruleId, C, aBody))] },
      },
      pageStatuses: statuses,
    });
    // Run 2: A's control is named; B still unconfirmed; C emits nothing.
    const second = [
      ...(await ruleChecks(ruleId, A, bBody)),
      ...(await ruleChecks(ruleId, B, aBody)),
    ];
    const ruleResults = { [ruleId]: { meta, checks: second } };
    await runCloudSmartAudits({
      store,
      siteKey: "web_935b",
      crawlId: "audit_2",
      ruleResults,
      pageStatuses: statuses,
      resolutionSignal: buildResolutionSignal(ruleResults, [A, B, C]),
    });
    const unconfirmed = async (state: FindingState) =>
      (await store.getFindings("web_935b", [state]))
        .filter((f) => f.checkName === `${check}-unconfirmed`)
        .map((f) => f.normalizedUrl)
        .sort();
    expect(await unconfirmed("resolved")).toEqual([normalizePageUrl(A)]);
    expect(await unconfirmed("open")).toEqual([normalizePageUrl(B), normalizePageUrl(C)].sort());
  });

  test("the signal lists A as evaluated, and C as not evaluated, for the base check", async () => {
    const [ruleId, check, aBody, bBody] = CASES[0]!;
    const checks = [
      ...(await ruleChecks(ruleId, A, aBody)),
      ...(await ruleChecks(ruleId, B, bBody)),
    ];
    const signal = buildResolutionSignal({ [ruleId]: { checks } }, [A, B, C])!;
    const notEvaluated = signal.notEvaluated?.[`${ruleId}|${check}`] ?? [];
    const hash = (url: string) => resolutionUrlHash(normalizePageUrl(url));
    expect(notEvaluated).not.toContain(hash(A));
    expect(notEvaluated).toContain(hash(C));
    expect(signal.failing[`${ruleId}|${check}`]).toEqual([]);
  });
});
