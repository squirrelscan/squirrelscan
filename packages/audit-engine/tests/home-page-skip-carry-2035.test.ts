// pub#2035: `crawl/home-page-unreachable` skips with `entry-not-fetched` when this audit has no verdict on the
// home page. A stored finding on the home page must stay open (carried), not read as fixed, even when the
// home page is among the crawled URLs (it loaded with an error, or failed for an unknown reason).

import { describe, expect, test } from "bun:test";

import type { FindingState, PageFindingRecord, SitePageRecord } from "@squirrelscan/core-contracts";

import { ENTRY_NOT_FETCHED_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";

import { findingKey } from "../src/merge-core";
import { describeSitePagesContract } from "./helpers/site-pages-contract";
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
    for (const f of findings)
      this.findings.set(findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator), { ...f });
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

const RULE = "crawl/home-page-unreachable";
const CHECK = "home-page-unreachable";
const meta = {
  id: RULE,
  name: "Home Page Unreachable",
  description: "d",
  category: "crawl",
  scope: "site" as const,
  severity: "error" as const,
  weight: 10,
};
const HOME = "https://x.test/";
const OTHER = "https://x.test/about";
const crawled = [HOME, OTHER].map((url) => ({ url, status: 200 }));
const run = (check: object) => ({
  [RULE]: { meta, checks: [{ name: CHECK, pageUrl: HOME, ...check }] } as never,
});

async function rerun(second: object, signal: boolean) {
  const store = new MemStore();
  const first = run({
    status: "fail",
    message: "The home page of x.test failed to load: the server did not answer in time",
  });
  await runCloudSmartAudits({
    store,
    siteKey: "web_1",
    crawlId: "audit_1",
    ruleResults: first,
    pageStatuses: crawled,
    ...(signal ? { resolutionSignal: buildResolutionSignal(first, [HOME, OTHER]) } : {}),
  });
  const next = run(second);
  await runCloudSmartAudits({
    store,
    siteKey: "web_1",
    crawlId: "audit_2",
    ruleResults: next,
    pageStatuses: crawled,
    ...(signal ? { resolutionSignal: buildResolutionSignal(next, [HOME, OTHER]) } : {}),
  });
  return [...store.findings.values()].filter((f) => f.checkName === CHECK).map((f) => f.state);
}

describe("a home page with no verdict this audit keeps its stored finding open (pub#2035)", () => {
  for (const signal of [false, true]) {
    test(`entry-not-fetched skip carries${signal ? " (signal)" : ""}`, async () => {
      expect(
        await rerun(
          {
            status: "skipped",
            skipReason: ENTRY_NOT_FETCHED_SKIP_REASON,
            message: "Not checked: this audit did not fetch the home page",
          },
          signal,
        ),
      ).toEqual(["open"]);
    });

    test(`a pass resolves${signal ? " (signal)" : ""}`, async () => {
      expect(await rerun({ status: "pass", message: "The home page loaded" }, signal)).toEqual([
        "resolved",
      ]);
    });
  }
});

describeSitePagesContract("home-page-skip-carry-2035.test.ts MemStore", () => new MemStore());
