// #1031 (prod shape): a page that was CRAWLED this run still holds old open rows of a rule
// whose check now reports its items as `<check>-unconfirmed` (a style may hide them).
// Nothing resolves the old `form-labels` fail rows: the check emits no `form-labels`
// result for the page, so they are carried run after run, coverage shows no carried count
// on the audited page and `knownPages = auditedPages`.

import { describe, expect, test } from "bun:test";

import type { FindingState, PageFindingRecord, SitePageRecord } from "@squirrelscan/core-contracts";

import { buildResolutionSignal } from "@squirrelscan/rules/resolution";

import { findingKey } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";

class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();
  async getFindings(_s: string, states?: FindingState[]): Promise<PageFindingRecord[]> {
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages(): Promise<SitePageRecord[]> {
    return [...this.pages.values()];
  }
  async upsertFindings(findings: PageFindingRecord[]): Promise<void> {
    for (const f of findings) this.findings.set(findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator), { ...f });
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

const RULE = "a11y/form-labels";
const meta = { id: RULE, name: "Form labels", description: "d", category: "a11y", scope: "page" as const, severity: "error" as const, weight: 5 };
const P = "https://x.test/";
const Q = "https://x.test/other";
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `input-${i}` }));

const run = (checks: object[]) => ({ [RULE]: { meta, checks } as never });
const status = (store: MemStore) => [...store.findings.values()].map((f) => `${f.checkName}:${f.state}`);

describe("a fresh info result on a re-crawled page resolves the old fail rows (#1031)", () => {
  const crawled = [P, Q].map((url) => ({ url, status: 200 }));

  async function rerun(fresh: object[], signal: boolean) {
    const store = new MemStore();
    const first = run([
      { name: "form-labels", status: "fail", message: "50 form input(s) without labels", pageUrl: P, items: items(50) },
      { name: "form-labels", status: "pass", message: "ok", pageUrl: Q },
    ]);
    await runCloudSmartAudits({ store, siteKey: "web_1", crawlId: "audit_1", ruleResults: first, pageStatuses: crawled, ...(signal ? { resolutionSignal: buildResolutionSignal(first, [P, Q]) } : {}) });
    const second = run(fresh);
    const r = await runCloudSmartAudits({ store, siteKey: "web_1", crawlId: "audit_2", ruleResults: second, pageStatuses: crawled, ...(signal ? { resolutionSignal: buildResolutionSignal(second, [P, Q]) } : {}) });
    const open = await store.getFindings("web_1", ["open"]);
    return { open: open.filter((f) => f.checkName === "form-labels"), coverage: r.coverage };
  }

  for (const signal of [false, true]) {
    test(`"No form inputs found" (info, no items) resolves them${signal ? " with the resolution signal" : ""}`, async () => {
      const { open, coverage } = await rerun(
        [
          { name: "form-labels", status: "info", message: "No form inputs found", pageUrl: P },
          { name: "form-labels", status: "pass", message: "ok", pageUrl: Q },
        ],
        signal,
      );
      expect(open.length).toBe(0);
      expect(coverage.carriedFindings).toBe(0);
    });

    test(`the rule emitting only a different check on the page resolves them${signal ? " with the resolution signal" : ""}`, async () => {
      const { open } = await rerun(
        [
          { name: "form-labels-other", status: "info", message: "x", pageUrl: P },
          { name: "form-labels", status: "pass", message: "ok", pageUrl: Q },
        ],
        signal,
      );
      expect(open.length).toBe(0);
    });
  }

  for (const signal of [false, true]) {
    test(`control: a check explicitly skipped on the page still carries${signal ? " (signal)" : ""}, and coverage names the page`, async () => {
      const { open, coverage } = await rerun(
        [
          { name: "form-labels", status: "skipped", message: "not evaluated", skipReason: "no_data", pageUrl: P },
          { name: "form-labels", status: "pass", message: "ok", pageUrl: Q },
        ],
        signal,
      );
      expect(open.length).toBe(50);
      expect(coverage.carriedFindings).toBe(50);
      expect(coverage.pagesWithStaleCarry).toBe(1);
    });
  }

  test("coverage omits pagesWithStaleCarry when every re-crawled page resolved", async () => {
    const { coverage } = await rerun(
      [
        { name: "form-labels", status: "info", message: "No form inputs found", pageUrl: P },
        { name: "form-labels", status: "pass", message: "ok", pageUrl: Q },
      ],
      true,
    );
    expect("pagesWithStaleCarry" in coverage).toBe(false);
  });

  // An `info` that says "could not judge" is marked inconclusive by its rule and is no evidence the page is clean.
  for (const signal of [false, true]) {
    test(`an inconclusive info (could not judge) carries the old fail${signal ? " (signal)" : ""}; a plain info resolves it`, async () => {
      const inconclusive = await rerun(
        [
          { name: "form-labels", status: "info", message: "Content too short for analysis", pageUrl: P, details: { inconclusive: true } },
          { name: "form-labels", status: "pass", message: "ok", pageUrl: Q },
        ],
        signal,
      );
      expect(inconclusive.open.length).toBe(50);
      const plain = await rerun(
        [
          { name: "form-labels", status: "info", message: "No form inputs found", pageUrl: P },
          { name: "form-labels", status: "pass", message: "ok", pageUrl: Q },
        ],
        signal,
      );
      expect(plain.open.length).toBe(0);
    });

  }

    test("an inconclusive info on a DIFFERENT check of the rule does not make the page clean for the first (signal)", async () => {
      const r = await rerun(
        [
          { name: "form-labels-other", status: "info", message: "unreadable", pageUrl: P, details: { inconclusive: true } },
          { name: "form-labels", status: "pass", message: "ok", pageUrl: Q },
        ],
        true,
      );
      expect(r.open.length).toBe(50);
    });

  test("a scan-truncated check on the page still carries, whatever else the rule said there", async () => {
    const r = await rerun(
      [
        { name: "form-labels", status: "skipped", message: "scan stopped", skipReason: "scan-truncated", pageUrl: P },
        { name: "form-labels-other", status: "pass", message: "ok", pageUrl: P },
        { name: "form-labels", status: "pass", message: "ok", pageUrl: Q },
      ],
      true,
    );
    expect(r.open.length).toBe(50);
    // And the signal itself says so (pins the signal fix, not the local merge's skipped-row collector):
    // the page is in the truncated check's notEvaluated set although the rule passed another check there.
    const signal = buildResolutionSignal(
      run([
        { name: "form-labels", status: "skipped", message: "scan stopped", skipReason: "scan-truncated", pageUrl: P },
        { name: "form-labels-other", status: "pass", message: "ok", pageUrl: P },
        { name: "form-labels", status: "pass", message: "ok", pageUrl: Q },
      ]),
      [P, Q],
    )!;
    expect(signal.notEvaluated?.[`${RULE}|form-labels`]).toHaveLength(1);
  });
});
