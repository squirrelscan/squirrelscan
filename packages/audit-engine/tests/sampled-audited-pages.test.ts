// squirrelscan/repo#2067: on a SAMPLED publish, `coverage.auditedPages` counted
// only the pages the payload evidenced (a check's `pageUrl`, or `pageStatuses`).
// A page crawled clean whose every check was clipped from the publish sample
// (#1167) appeared nowhere, so it was not counted as audited, got no `site_pages`
// row, and was billed as not audited (the page charge reads this count, #2406).
//
// The payloads here go through the producer's own publish transformation
// (`foldOverflowChecks` → `sampleChecksForPublish`, plus `buildResolutionSignal`
// over the unsampled results), so the clipping is the real one, not a hand-built
// imitation of it.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { foldOverflowChecks, sampleChecksForPublish } from "@squirrelscan/rules/fold";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";

import { findingKey } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import { calculateHealthScore } from "../src/scoring";
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
  }
  async markPagesRemoved(
    siteKey: string,
    pages: Array<{ normalizedUrl: string; lastStatus: number }>,
    crawlId: string,
  ): Promise<void> {
    for (const p of pages) {
      await this.markPageRemoved(siteKey, p.normalizedUrl, crawlId, p.lastStatus);
    }
  }
  async compactFindings(): Promise<number> {
    return 0;
  }
}

const meta = (id: string) => ({
  id,
  name: id,
  description: id,
  category: "content" as const,
  scope: "page" as const,
  severity: "warning" as const,
  weight: 10,
});

const SITE = "https://big.test";
const page = (i: number) => `${SITE}/p/${i}`;

/** 600 crawled pages; the last one is a 404. */
const CRAWLED = Array.from({ length: 600 }, (_, i) => page(i));
const GONE = page(599);
const LIVE = CRAWLED.filter((u) => u !== GONE);

function check(name: string, url: string, status: CheckResult["status"]): CheckResult {
  return { name, status, message: status === "pass" ? "ok" : `${name} ${status}`, pageUrl: url };
}

/**
 * The unsampled rule results a CLI run of {@link CRAWLED} produces: every live
 * page gets one check per rule. `meta-description` fails on `descFails` pages,
 * `title` on `titleFails`; everything else passes.
 */
function fullResults(descFails: Set<string>, titleFails: Set<string>) {
  return {
    "meta-description": {
      meta: meta("meta-description"),
      checks: LIVE.map((u) => check("has-description", u, descFails.has(u) ? "fail" : "pass")),
    },
    title: {
      meta: meta("title"),
      checks: LIVE.map((u) => check("has-title", u, titleFails.has(u) ? "warn" : "pass")),
    },
  };
}

/** The publish transformation: fold over-cap rules, sample every check, build the signal first. */
function samplePayload(full: ReturnType<typeof fullResults>) {
  const resolutionSignal = buildResolutionSignal(full, CRAWLED);
  const ruleResults: Record<string, { meta: ReturnType<typeof meta>; checks: CheckResult[] }> =
    {};
  for (const [ruleId, r] of Object.entries(full)) {
    ruleResults[ruleId] = {
      meta: r.meta,
      checks: sampleChecksForPublish(foldOverflowChecks(r.checks)),
    };
  }
  return {
    ruleResults,
    resolutionSignal,
    pageStatuses: [{ url: GONE, status: 404 }],
  };
}

/** Pages a sampled payload evidences: a check's pageUrl or an aggregate's retained pages. */
function evidencedPages(payload: ReturnType<typeof samplePayload>): Set<string> {
  const out = new Set<string>();
  for (const r of Object.values(payload.ruleResults)) {
    for (const c of r.checks) {
      if (c.pageUrl) out.add(c.pageUrl);
      for (const p of c.pages ?? []) out.add(p);
    }
  }
  return out;
}

async function publish(
  store: MemStore,
  crawlId: string,
  payload: ReturnType<typeof samplePayload>,
  opts: { signal?: boolean } = {},
) {
  return runCloudSmartAudits({
    store,
    siteKey: "web_big",
    crawlId,
    ruleResults: payload.ruleResults,
    pageStatuses: payload.pageStatuses,
    ...(opts.signal === false ? {} : { resolutionSignal: payload.resolutionSignal }),
    now: 1_780_000_000_000,
  });
}

describe("sampled publish counts every crawled page as audited (#2067)", () => {
  // 20 pages fail meta-description, all inside the fail sample; title passes
  // everywhere. The pass aggregates keep the first 100 pages each, so pages past
  // ~120 appear in no check at all.
  const descFails = new Set(LIVE.slice(0, 20));
  const payload = samplePayload(fullResults(descFails, new Set()));
  const evidenced = evidencedPages(payload);
  const clipped = LIVE.filter((u) => !evidenced.has(u));

  test("the fixture really clips: M < N pages carry any retained check", () => {
    expect(payload.resolutionSignal!.crawledUrls.length).toBe(600);
    expect(evidenced.size).toBeLessThan(LIVE.length);
    expect(clipped.length).toBeGreaterThan(400);
  });

  test("auditedPages = pagesCrawled − removed, knownPages ≥ auditedPages", async () => {
    const r = await publish(new MemStore(), "audit_1", payload);
    expect(r.coverage.auditedPages).toBe(CRAWLED.length - 1);
    expect(r.coverage.knownPages).toBeGreaterThanOrEqual(r.coverage.auditedPages);
    expect(r.coverage.knownPages).toBe(LIVE.length);
    expect(r.removedPages).toBe(1);
  });

  test("before the fix the count was the evidenced pages only (the payload without its signal)", async () => {
    // A publish without the signal is what the merge counted from before: the
    // pages the payload names. That is the M of the bug.
    const r = await publish(new MemStore(), "audit_1", payload, { signal: false });
    expect(r.coverage.auditedPages).toBe(evidenced.size);
    expect(r.coverage.auditedPages).toBeLessThan(LIVE.length);
  });

  test("a clipped clean page gets an active site_pages row stamped with this run", async () => {
    const store = new MemStore();
    await publish(store, "audit_1", payload);
    for (const url of clipped) {
      const row = store.pages.get(url);
      expect(row?.state).toBe("active");
      expect(row?.lastSeenCrawlId).toBe("audit_1");
      expect(row?.lastStatus).toBe(200);
    }
    expect(store.pages.get(GONE)?.state).toBe("removed");
  });

  test("the health score is unchanged: identical to the same payload scored without the new rows", async () => {
    const fixed = await publish(new MemStore(), "audit_1", payload);
    const before = await publish(new MemStore(), "audit_1", payload, { signal: false });
    expect(calculateHealthScore({ results: fixed.unionRuleResults })).toEqual(
      calculateHealthScore({ results: before.unionRuleResults }),
    );
    // No clipped page slipped into the carried denominator on a first audit.
    for (const r of fixed.unionRuleResults.values()) expect(r.syntheticPassCount).toBeUndefined();
  });

  test("a re-audit whose clipped pages already had rows keeps their synthetic pass", async () => {
    // Rows for every live page, as an earlier complete-store audit leaves them,
    // and no open findings. Before #2067 these clipped pages were carried pages
    // with a synthetic pass each; they still are.
    const seed = async () => {
      const store = new MemStore();
      await store.upsertSitePages(
        LIVE.map((normalizedUrl) => ({
          siteKey: "web_big",
          normalizedUrl,
          lastStatus: 200,
          state: "active" as const,
          lastSeenCrawlId: "audit_0",
          lastSeenAt: 1_770_000_000_000,
        })),
      );
      return store;
    };
    const fixed = await publish(await seed(), "audit_1", payload);
    const before = await publish(await seed(), "audit_1", payload, { signal: false });
    for (const ruleId of ["meta-description", "title"]) {
      expect(fixed.unionRuleResults.get(ruleId)!.syntheticPassCount).toBe(clipped.length);
    }
    expect(calculateHealthScore({ results: fixed.unionRuleResults })).toEqual(
      calculateHealthScore({ results: before.unionRuleResults }),
    );
    expect(fixed.coverage.auditedPages).toBe(LIVE.length);
  });
});

describe("on the NEXT publish, a clipped page counts only with all of its evidence (#2067)", () => {
  // 150 pages fail meta-description, so its fail aggregate is itself clipped to
  // 100: 50 failing pages appear in no check. Title passes everywhere.
  const descFails = new Set(LIVE.slice(0, 150));
  const payload = samplePayload(fullResults(descFails, new Set()));
  const evidenced = evidencedPages(payload);
  const clipped = LIVE.filter((u) => !evidenced.has(u));
  const clippedFailing = clipped.filter((u) => descFails.has(u));
  const clippedClean = clipped.filter((u) => !descFails.has(u));

  test("fixture: some failing pages are clipped from every sample", () => {
    expect(clippedFailing.length).toBeGreaterThan(0);
    expect(clippedClean.length).toBeGreaterThan(0);
  });

  test("clipped clean pages pass; clipped failing pages with no carried finding count for nothing", async () => {
    const store = new MemStore();
    const first = await publish(store, "audit_1", payload);
    // First publish: no clipped page had a row, so none is a carried page.
    expect(first.unionRuleResults.get("meta-description")!.syntheticPassCount).toBeUndefined();

    // Every crawled page now has a row; the same crawl is published again. A
    // clipped failing page's fail is in no check, so crediting its title pass
    // would count its passes without its fails: it is left out entirely.
    const second = await publish(store, "audit_2", payload);
    expect(second.coverage.auditedPages).toBe(LIVE.length);
    for (const ruleId of ["meta-description", "title"]) {
      expect(second.unionRuleResults.get(ruleId)!.syntheticPassCount).toBe(clippedClean.length);
    }
  });

  test("a warning counts as failing too", async () => {
    const titleWarns = new Set(LIVE.slice(0, 150));
    const warnPayload = samplePayload(fullResults(new Set(), titleWarns));
    const warnClipped = LIVE.filter((u) => !evidencedPages(warnPayload).has(u));
    const store = new MemStore();
    await publish(store, "audit_1", warnPayload);
    const second = await publish(store, "audit_2", warnPayload);
    expect(second.unionRuleResults.get("title")!.syntheticPassCount).toBe(
      warnClipped.filter((u) => !titleWarns.has(u)).length,
    );
  });

  test("a site failing a check on every page scores the same on every publish", async () => {
    // The real-site shape: a template problem on every page, so every clipped
    // page fails something and none can be scored from the payload.
    const everywhere = samplePayload(fullResults(new Set(LIVE.slice(0, 20)), new Set(LIVE)));
    const store = new MemStore();
    const first = await publish(store, "audit_1", everywhere);
    const second = await publish(store, "audit_2", everywhere);
    expect(calculateHealthScore({ results: second.unionRuleResults })).toEqual(
      calculateHealthScore({ results: first.unionRuleResults }),
    );
    expect(second.coverage.auditedPages).toBe(LIVE.length);
  });

  test("a page no check evaluated (blocked, non-HTML) is audited but never credited", async () => {
    // Pages 580-598 produce no check at all: they are crawled, so they count as
    // audited and get a row, and on the next publish they still pass nothing.
    const silent = new Set(LIVE.slice(580));
    const full = fullResults(new Set(), new Set());
    for (const r of Object.values(full)) {
      r.checks = r.checks.filter((c) => !silent.has(c.pageUrl!));
    }
    const silentPayload = samplePayload(full);
    const store = new MemStore();
    const first = await publish(store, "audit_1", silentPayload);
    expect(first.coverage.auditedPages).toBe(LIVE.length);
    for (const url of silent) expect(store.pages.get(url)?.state).toBe("active");

    const second = await publish(store, "audit_2", silentPayload);
    const clippedEvaluated = LIVE.filter(
      (u) => !silent.has(u) && !evidencedPages(silentPayload).has(u),
    );
    expect(clippedEvaluated.length).toBeGreaterThan(0);
    expect(second.unionRuleResults.get("title")!.syntheticPassCount).toBe(
      clippedEvaluated.length,
    );
  });

  test("a clipped page with a carried finding keeps its passes, as before #2067", async () => {
    // One clipped failing page carries a meta-description finding from an
    // earlier audit: its fail is replayed, so its other rules still pass.
    const store = new MemStore();
    await publish(store, "audit_1", payload);
    const kept = clippedFailing[0]!;
    await store.upsertFindings([
      {
        siteKey: "web_big",
        normalizedUrl: kept,
        ruleId: "meta-description",
        checkName: "has-description",
        locator: "",
        status: "fail",
        severity: "warning",
        message: "has-description fail",
        fingerprint: "fp",
        firstSeenAt: 1_770_000_000_000,
        lastSeenCrawlId: "audit_0",
        lastSeenAt: 1_770_000_000_000,
        provenance: "fresh",
        state: "open",
      },
    ]);
    const second = await publish(store, "audit_2", payload);
    expect(second.coverage.carriedFindings).toBe(1);
    expect(second.unionRuleResults.get("title")!.syntheticPassCount).toBe(clippedClean.length + 1);
    expect(second.unionRuleResults.get("meta-description")!.syntheticPassCount).toBe(
      clippedClean.length,
    );
    const replayed = second.unionRuleResults
      .get("meta-description")!
      .checks.filter((c) => c.pageUrl === kept);
    expect(replayed.map((c) => c.status)).toEqual(["fail"]);
  });
});

describe("query pages: a query-blind hash speaks only for an uncrawled spelling (#2067)", () => {
  const Q = `${SITE}/q?id=1`;
  const BASE = `${SITE}/q`;
  const OTHER = `${SITE}/a`;
  const KEY = "meta-description|has-description";
  const hash = (u: string) => resolutionUrlHash(u);

  async function storeWithRow() {
    const store = new MemStore();
    await store.upsertSitePages([
      {
        siteKey: "web_big",
        normalizedUrl: Q,
        lastStatus: 200,
        state: "active",
        lastSeenCrawlId: "audit_0",
        lastSeenAt: 1_770_000_000_000,
      },
    ]);
    return store;
  }

  test("`/q` failing does not drop the pass of a clean, clipped `/q?id=1`", async () => {
    const r = await runCloudSmartAudits({
      store: await storeWithRow(),
      siteKey: "web_big",
      crawlId: "audit_1",
      ruleResults: {
        "meta-description": {
          meta: meta("meta-description"),
          checks: [
            check("has-description", BASE, "fail"),
            check("has-description", OTHER, "pass"),
          ],
        },
      },
      pageStatuses: [],
      resolutionSignal: { crawledUrls: [BASE, Q, OTHER], failing: { [KEY]: [hash(BASE)] } },
    });
    expect(r.unionRuleResults.get("meta-description")!.syntheticPassCount).toBe(1);
  });

  test("an older publisher's query-blind hash still marks `/q?id=1` failing when `/q` was not crawled", async () => {
    const r = await runCloudSmartAudits({
      store: await storeWithRow(),
      siteKey: "web_big",
      crawlId: "audit_1",
      ruleResults: {
        "meta-description": {
          meta: meta("meta-description"),
          checks: [check("has-description", OTHER, "pass")],
        },
      },
      pageStatuses: [],
      resolutionSignal: { crawledUrls: [Q, OTHER], failing: { [KEY]: [hash(BASE)] } },
    });
    expect(r.unionRuleResults.get("meta-description")!.syntheticPassCount).toBeUndefined();
  });
});

describeSitePagesContract("sampled-audited-pages.test.ts MemStore", () => new MemStore());
