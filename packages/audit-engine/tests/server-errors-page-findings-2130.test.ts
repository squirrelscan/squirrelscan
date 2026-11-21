// crawl/server-errors per-page findings (#2130): each 5xx page is stored and resolved on its own,
// and a page the crawl did not fetch this audit keeps its open finding.

import type {
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";

import { crawl } from "@squirrelscan/rules";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";
import { describe, expect, test } from "bun:test";

const serverErrorsRule = crawl.serverErrorsRule;

import { findingKey } from "../src/merge-core";
import {
  runCloudSmartAudits,
  type SmartAuditStore,
} from "../src/merge-promise";
import { describeSitePagesContract } from "./helpers/site-pages-contract";

class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();
  async getFindings(
    _s: string,
    states?: FindingState[]
  ): Promise<PageFindingRecord[]> {
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages(): Promise<SitePageRecord[]> {
    return [...this.pages.values()];
  }
  async upsertFindings(findings: PageFindingRecord[]): Promise<void> {
    for (const f of findings)
      this.findings.set(
        findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator),
        { ...f }
      );
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

const RULE = "crawl/server-errors";
const A = "https://x.test/a";
const B = "https://x.test/b";
const C = "https://x.test/c";

function audit(
  pages: Array<{ url: string; statusCode: number }>,
  extras: Record<string, unknown> = {}
) {
  const ctx = {
    page: { url: A, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    options: {},
    site: {
      baseUrl: "https://x.test/",
      pages: pages.map((p) => ({ ...p, parsed: {} })),
      ...extras,
    },
  };
  const { checks } = serverErrorsRule.run(ctx as never) as { checks: object[] };
  return { [RULE]: { meta: serverErrorsRule.meta, checks } as never };
}

async function publish(
  store: MemStore,
  crawlId: string,
  pages: Array<{ url: string; statusCode: number }>,
  extras = {}
) {
  const results = audit(pages, extras);
  await runCloudSmartAudits({
    store,
    siteKey: "web_1",
    crawlId,
    ruleResults: results,
    pageStatuses: pages.map((p) => ({ url: p.url, status: p.statusCode })),
    resolutionSignal: buildResolutionSignal(
      results,
      pages.map((p) => p.url)
    ),
  });
  return (await store.getFindings("web_1", ["open"]))
    .filter((f) => f.ruleId === RULE)
    .map((f) => f.normalizedUrl)
    .sort();
}

describe("crawl/server-errors page findings (#2130)", () => {
  test("two 5xx pages store as two findings; the page that recovers resolves while the other stays open", async () => {
    const store = new MemStore();
    expect(
      await publish(store, "audit_1", [
        { url: A, statusCode: 500 },
        { url: B, statusCode: 503 },
        { url: C, statusCode: 200 },
      ])
    ).toEqual([A, B]);
    expect(
      await publish(store, "audit_2", [
        { url: A, statusCode: 200 },
        { url: B, statusCode: 503 },
        { url: C, statusCode: 200 },
      ])
    ).toEqual([B]);
  });

  test("a prior finding on a page not fetched this audit stays open on a capped crawl", async () => {
    const store = new MemStore();
    await publish(store, "audit_1", [
      { url: A, statusCode: 500 },
      { url: B, statusCode: 200 },
    ]);
    const open = await publish(
      store,
      "audit_2",
      [{ url: B, statusCode: 200 }],
      { crawlLimits: { pagesCrawled: 1, maxPages: 1 } }
    );
    expect(open).toEqual([A]);
  });

  test("a prior finding on a page the crawl failed to fetch stays open", async () => {
    const store = new MemStore();
    await publish(store, "audit_1", [
      { url: A, statusCode: 500 },
      { url: B, statusCode: 200 },
    ]);
    const open = await publish(
      store,
      "audit_2",
      [{ url: B, statusCode: 200 }],
      { failedFetches: 1 }
    );
    expect(open).toEqual([A]);
  });
});

describeSitePagesContract(
  "server-errors-page-findings-2130.test.ts MemStore",
  () => new MemStore()
);
