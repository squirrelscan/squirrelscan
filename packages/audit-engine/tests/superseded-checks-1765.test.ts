// pub#1765: a finding stored under a superseded check name (core/meta-title `meta-title`) is judged by
// its successors on the same page when a later audit resolves it.

import { describe, expect, test } from "bun:test";

import type { CheckResult, FindingState, PageFindingRecord, SitePageRecord } from "@squirrelscan/core-contracts";
import { judgeSuperseded } from "@squirrelscan/core-contracts/resolution";
import { parsePage } from "@squirrelscan/parser";
import { loadAllRules } from "@squirrelscan/rules";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";
import type { ParsedPage } from "@squirrelscan/rules/types";

import { findingKey } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";

class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();
  async getFindings(_k: string, states?: FindingState[]) {
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages() {
    return [...this.pages.values()];
  }
  async upsertFindings(findings: PageFindingRecord[]) {
    for (const f of findings) this.findings.set(findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator), { ...f });
  }
  async upsertSitePages(pages: SitePageRecord[]) {
    for (const p of pages) this.pages.set(p.normalizedUrl, { ...p });
  }
  async markPageRemoved() {}
  async markPagesRemoved() {}
  async compactFindings() {
    return 0;
  }
}

const metaTitleRule = loadAllRules().get("core/meta-title")!;
const SITE = "web_1765";
const NOW = 1_780_000_000_000;
const URL = "https://shop.test/p";
const RULE = "core/meta-title";
const FIXED = "A title of a perfectly fine length here";
const LONG = "Classic trail mix: a generous, hand-mixed blend of nuts, seeds and dried fruit | The Nut Shop";

function titleChecks(title: string): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>x</h1></body></html>`;
  const { checks } = metaTitleRule.run({
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL) as ParsedPage,
    options: {},
  }) as { checks: CheckResult[] };
  return checks.map((c) => ({ ...c, pageUrl: URL }));
}

async function audit(pageChecks: CheckResult[], withNeighbour = false) {
  // A second page that evaluates both successors, so their keys exist in the signal (an absent key resolves everything).
  const other = "https://shop.test/q";
  const checks = withNeighbour ? [...pageChecks, ...titleChecks(FIXED).map((c) => ({ ...c, pageUrl: other }))] : pageChecks;
  const store = new MemStore();
  if (withNeighbour) store.pages.set(other, { siteKey: SITE, normalizedUrl: other, lastStatus: 200, state: "active", lastSeenCrawlId: "a0", lastSeenAt: NOW - 1000 });
  store.pages.set(URL, { siteKey: SITE, normalizedUrl: URL, lastStatus: 200, state: "active", lastSeenCrawlId: "a0", lastSeenAt: NOW - 1000 });
  // The earlier audit stored the title finding under the old name, keyed by the page url (the item id).
  store.findings.set(findingKey(URL, RULE, "meta-title", URL), {
    siteKey: SITE,
    normalizedUrl: URL,
    ruleId: RULE,
    checkName: "meta-title",
    locator: URL,
    status: "warn",
    severity: "error",
    message: "Title too short",
    value: null,
    expected: null,
    payload: null,
    fingerprint: "fp-old",
    firstSeenAt: NOW - 86_400_000,
    lastSeenCrawlId: "a0",
    lastSeenAt: NOW - 86_400_000,
    provenance: "fresh",
    state: "open",
  });
  const ruleResults = { [RULE]: { meta: metaTitleRule.meta, checks } };
  await runCloudSmartAudits({
    store,
    siteKey: SITE,
    crawlId: "a1",
    ruleResults,
    pageStatuses: [],
    resolutionSignal: buildResolutionSignal(ruleResults, withNeighbour ? [URL, other] : [URL]),
    now: NOW,
  });
  return store;
}

const old = (s: MemStore) => s.findings.get(findingKey(URL, RULE, "meta-title", URL))!;

describe("a finding under a superseded check name follows its successors", () => {
  test("every successor passed: the old finding resolves", async () => {
    const store = await audit(titleChecks(FIXED));
    expect(old(store).state).toBe("resolved");
  });

  test("a still-long title: the old row retires and the finding lives on under the new name, keeping its first-seen", async () => {
    const store = await audit(titleChecks(LONG));
    expect(old(store).state).toBe("stale");
    const fresh = store.findings.get(findingKey(URL, RULE, "meta-title-too-long", URL))!;
    expect(fresh.state).toBe("open");
    expect(fresh.status).toBe("warn");
    expect(fresh.message).toContain("Title too long");
    expect(fresh.firstSeenAt).toBe(NOW - 86_400_000);
  });

  test("a successor that was not checked: the old finding is carried, never resolved", async () => {
    const checks = titleChecks(FIXED).map((c) =>
      c.name === "meta-title-too-short" ? ({ ...c, status: "skipped", message: "Skipped" } as CheckResult) : c,
    );
    const store = await audit(checks, true);
    expect(old(store).state).toBe("open");
    expect(old(store).provenance).toBe("carried");
  });
});

describe("judgeSuperseded", () => {
  test("failing beats not-checked beats passed", () => {
    expect(judgeSuperseded(["passed", "passed"])).toBe("resolved");
    expect(judgeSuperseded(["passed", "not-checked"])).toBe("not-checked");
    expect(judgeSuperseded(["not-checked", "failing"])).toBe("failing");
  });
});
