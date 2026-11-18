// repo#2078: the cloud merge refuses a published check naming a page outside the
// run's crawled set, but only once the resolution signal says that set is whole.
// An older producer publishes `fresh`-labelled checks for pages it never fetched,
// and a label is the producer's own word. The signal's list is the only
// independent evidence, and it is evidence only when it was not clipped.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  ResolutionSignal,
  SitePageRecord,
} from "@squirrelscan/core-contracts";

import { findingKey } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import { buildCheckTallies } from "../src/publish-cap";
import { describeSitePagesContract } from "./helpers/site-pages-contract";

class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();

  private key(f: { normalizedUrl: string; ruleId: string; checkName: string; locator: string }) {
    return findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator);
  }

  async getFindings(_siteKey: string, states?: FindingState[]): Promise<PageFindingRecord[]> {
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages(): Promise<SitePageRecord[]> {
    return [...this.pages.values()];
  }
  async upsertFindings(findings: PageFindingRecord[]): Promise<void> {
    for (const f of findings) this.findings.set(this.key(f), { ...f });
  }
  async upsertSitePages(pages: SitePageRecord[]): Promise<void> {
    for (const p of pages) this.pages.set(p.normalizedUrl, { ...p });
  }
  async markPageRemoved(
    siteKey: string,
    normalizedUrl: string,
    crawlId: string,
    lastStatus: number,
  ): Promise<void> {
    this.pages.set(normalizedUrl, {
      siteKey,
      normalizedUrl,
      lastStatus,
      state: "removed",
      lastSeenCrawlId: crawlId,
      lastSeenAt: Date.now(),
    });
    for (const [k, f] of this.findings) {
      if (f.normalizedUrl === normalizedUrl && f.state === "open") {
        this.findings.set(k, { ...f, state: "stale", lastSeenCrawlId: crawlId });
      }
    }
  }
  async markPagesRemoved(
    siteKey: string,
    pages: Array<{ normalizedUrl: string; lastStatus: number }>,
    crawlId: string,
  ): Promise<void> {
    for (const p of pages)
      await this.markPageRemoved(siteKey, p.normalizedUrl, crawlId, p.lastStatus);
  }
  async compactFindings(): Promise<number> {
    return 0;
  }
}

describeSitePagesContract("outside-crawled-refuse-2078.test.ts MemStore", () => new MemStore());

const meta = {
  id: "meta-title",
  name: "Meta Title",
  description: "Pages should have a title",
  category: "core" as const,
  scope: "page" as const,
  severity: "warning" as const,
  weight: 10,
};
const NOW = Date.UTC(2026, 8, 11, 17, 11, 27);

const CRAWLED = Array.from({ length: 4 }, (_, i) => `https://x.test/p/${i}`);
const NEVER = Array.from({ length: 6 }, (_, i) => `https://x.test/never/${i}`);

const warn = (pageUrl: string): CheckResult => ({
  name: "meta-title",
  status: "warn",
  message: "Title is too short",
  pageUrl,
  provenance: "fresh",
});

function run(signal: ResolutionSignal | undefined) {
  const store = new MemStore();
  return runCloudSmartAudits({
    store,
    siteKey: "web_1",
    crawlId: "audit_1",
    ruleResults: { "core/meta-title": { meta, checks: [...CRAWLED, ...NEVER].map(warn) } },
    pageStatuses: [],
    ...(signal ? { resolutionSignal: signal } : {}),
    now: NOW,
  }).then((r) => ({ r, store }));
}

const signal = (extra: Partial<ResolutionSignal>): ResolutionSignal => ({
  crawledUrls: CRAWLED,
  failing: {},
  ...extra,
});

describe("repo#2078: refuse published checks outside a complete crawled set", () => {
  test("a complete list audits only the listed pages", async () => {
    const { r, store } = await run(signal({ crawledUrlsComplete: true }));
    expect(r.coverage.auditedPages).toBe(4);
    expect(r.outsideCrawledChecksDropped).toBe(6);
    expect(r.outsideCrawledPages).toBe(6);
    const pages = (await store.getFindings("web_1")).map((f) => f.normalizedUrl);
    expect(pages.sort()).toEqual([...CRAWLED].sort());
  });

  test("the same publish with the list marked clipped audits the pre-#2078 set", async () => {
    const { r } = await run(signal({ crawledUrlsComplete: false }));
    expect(r.coverage.auditedPages).toBe(10);
    expect(r.outsideCrawledChecksDropped).toBe(0);
  });

  test("no marker, or no signal, leaves behaviour unchanged", async () => {
    for (const s of [signal({}), undefined]) {
      const { r } = await run(s);
      expect(r.coverage.auditedPages).toBe(10);
      expect(r.outsideCrawledChecksDropped).toBe(0);
      expect(r.outsideCrawledPages).toBe(0);
    }
  });
});

// A capped publish carries `checkTallies` counted from every row, refused ones
// included, and the score is taken from those tallies. The refused checks must
// leave the score too, not just the rows.
describe("repo#2078: refused checks leave a capped publish's score", () => {
  function runTallied(complete: boolean) {
    const ruleResults = {
      "core/meta-title": { meta, checks: [...CRAWLED, ...NEVER].map(warn) },
    };
    return runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults,
      checkTallies: buildCheckTallies(ruleResults),
      pageStatuses: [],
      resolutionSignal: signal({ crawledUrlsComplete: complete }),
      now: NOW,
    });
  }

  test("a complete list scores only the crawled pages' checks", async () => {
    const r = await runTallied(true);
    expect(r.outsideCrawledChecksDropped).toBe(NEVER.length);
    const tally = r.scoringTallies?.get("core/meta-title")?.tally;
    expect(tally?.warnings).toBe(CRAWLED.length);
    expect(tally?.warnUnits).toBe(CRAWLED.length);
    expect(r.reportTotals?.warnings).toBe(CRAWLED.length);
  });

  test("a clipped list scores every published check, as before", async () => {
    const r = await runTallied(false);
    expect(r.outsideCrawledChecksDropped).toBe(0);
    const tally = r.scoringTallies?.get("core/meta-title")?.tally;
    expect(tally?.warnUnits).toBe(CRAWLED.length + NEVER.length);
  });
});

// A site-scope rule's check can name a URL that is no crawled page at all:
// `integrity/known-malicious-url` points `pageUrl` at the flagged outbound link
// or at the site's base URL. A whole crawled set says nothing about those, so
// the refusal must leave every site-scope check alone.
describe("repo#2078: site-scope checks are never refused", () => {
  const siteMeta = {
    id: "integrity/known-malicious-url",
    name: "Known Malicious URL",
    description: "Site URLs must not be on a threat feed",
    category: "integrity" as const,
    scope: "site" as const,
    severity: "error" as const,
    weight: 10,
  };
  const SITE_URLS = ["https://evil.example/payload", "https://x.test/"];
  const flagged = (pageUrl: string): CheckResult => ({
    name: "known-malicious-url",
    status: "fail",
    message: "URL is on a threat feed",
    pageUrl,
    provenance: "fresh",
  });

  test("a complete list keeps site-scope checks naming uncrawled URLs", async () => {
    const store = new MemStore();
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {
        "core/meta-title": { meta, checks: [...CRAWLED, ...NEVER].map(warn) },
        "integrity/known-malicious-url": { meta: siteMeta, checks: SITE_URLS.map(flagged) },
      },
      pageStatuses: [],
      resolutionSignal: signal({ crawledUrlsComplete: true }),
      now: NOW,
    });
    // The page rule's uncrawled checks still go.
    expect(r.outsideCrawledChecksDropped).toBe(6);
    expect(r.outsideCrawledPages).toBe(6);
    // Every site-scope check survives into the union the report and score use.
    const site = r.unionRuleResults.get("integrity/known-malicious-url");
    expect(site?.checks.map((c) => c.pageUrl).sort()).toEqual([...SITE_URLS].sort());
  });
});
