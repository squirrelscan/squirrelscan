// squirrelscan/repo#2658: the merge fed the COMPACT resolution signal (decoded
// server-side) must decide exactly what it decides on the original #1185 signal,
// and when the compact signal's byte budget gives something up, the loss must
// only ever keep a finding open, never close one that still fails.
//
// Payloads go through the producer's own publish transformation (fold → sample,
// with the signal built over the unsampled results), so the clipping is real.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  ResolutionSignal,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { decodeResolutionSignal } from "@squirrelscan/core-contracts/resolution";
import { foldOverflowChecks, sampleChecksForPublish } from "@squirrelscan/rules/fold";
import {
  buildCompactResolutionSignal,
  buildPublishResolution,
  buildResolutionSignal,
} from "@squirrelscan/rules/resolution";
import { normalizePageUrl } from "@squirrelscan/utils/url";

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
      lastSeenAt: 1,
    });
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

describeSitePagesContract("compact-resolution-merge.test.ts MemStore", () => new MemStore());

const SITE_KEY = "web_compact";
const NOW = 1_780_000_000_000;

const meta = (id: string) => ({
  id,
  name: id,
  description: id,
  category: "content" as const,
  scope: "page" as const,
  severity: "warning" as const,
  weight: 10,
});

type Full = Record<string, { meta: ReturnType<typeof meta>; checks: CheckResult[] }>;

const check = (name: string, url: string, status: CheckResult["status"]): CheckResult => ({
  name,
  status,
  message: status === "pass" ? "ok" : `${name} ${status}`,
  pageUrl: url,
});

/**
 * The unsampled results of one run over `urls`: `desc` fails where `descFails`,
 * `title` warns where `titleFails`, `ttfb` has no timing data (skipped) on every
 * seventh page, and `rare` fails on `rareFails` only.
 */
function fullResults(
  urls: string[],
  fails: { desc: Set<string>; title?: Set<string>; rare?: Set<string> },
): Full {
  return {
    "meta-description": {
      meta: meta("meta-description"),
      checks: urls.map((u) => check("has-description", u, fails.desc.has(u) ? "fail" : "pass")),
    },
    title: {
      meta: meta("title"),
      checks: urls.map((u) => check("has-title", u, fails.title?.has(u) ? "warn" : "pass")),
    },
    "perf/ttfb": {
      meta: meta("perf/ttfb"),
      checks: urls.map((u, i) => check("ttfb", u, i % 7 === 3 ? "skipped" : "pass")),
    },
    rare: {
      meta: meta("rare"),
      checks: urls.map((u) => check("rare", u, fails.rare?.has(u) ? "fail" : "pass")),
    },
  };
}

function samplePayload(full: Full, crawled: string[], signal: ResolutionSignal | undefined) {
  const ruleResults: Full = {};
  for (const [ruleId, r] of Object.entries(full)) {
    ruleResults[ruleId] = {
      meta: r.meta,
      checks: sampleChecksForPublish(foldOverflowChecks(r.checks)),
    };
  }
  return { ruleResults, resolutionSignal: signal, crawled };
}

function prior(url: string, ruleId: string, checkName: string, locator = ""): PageFindingRecord {
  return {
    siteKey: SITE_KEY,
    normalizedUrl: url,
    ruleId,
    checkName,
    locator,
    status: "fail",
    severity: "warning",
    message: `${checkName} fail`,
    value: null,
    expected: null,
    payload: null,
    fingerprint: `fp-${url}-${checkName}`,
    firstSeenAt: NOW - 86_400_000,
    lastSeenCrawlId: "audit_0",
    lastSeenAt: NOW - 86_400_000,
    provenance: "fresh",
    state: "open",
  };
}

/** A store holding an earlier audit: every page known, open findings on `priors`. */
async function seededStore(pages: string[], priors: PageFindingRecord[]): Promise<MemStore> {
  const store = new MemStore();
  await store.upsertSitePages(
    pages.map((normalizedUrl) => ({
      siteKey: SITE_KEY,
      normalizedUrl,
      lastStatus: 200,
      state: "active" as const,
      lastSeenCrawlId: "audit_0",
      lastSeenAt: NOW - 86_400_000,
    })),
  );
  await store.upsertFindings(priors);
  return store;
}

async function publish(store: MemStore, payload: ReturnType<typeof samplePayload>) {
  return runCloudSmartAudits({
    store,
    siteKey: SITE_KEY,
    crawlId: "audit_1",
    ruleResults: payload.ruleResults,
    pageStatuses: [],
    ...(payload.resolutionSignal ? { resolutionSignal: payload.resolutionSignal } : {}),
    now: NOW,
  });
}

const stateOf = (store: MemStore, url: string, ruleId: string, checkName: string, locator = "") => {
  const f = store.findings.get(findingKey(url, ruleId, checkName, locator));
  return f ? `${f.state}:${f.provenance}` : "missing";
};

describe("the compact signal decides exactly what the original one does", () => {
  for (const count of [50, 500, 600]) {
    test(`${count} pages: same resolutions, carries, coverage and score`, async () => {
      const urls = Array.from({ length: count }, (_, i) => `https://site.test/catalog/item-${i}`);
      const desc = new Set(urls.filter((_, i) => i % 5 === 0));
      const title = new Set(urls.filter((_, i) => i % 9 === 0));
      const full = fullResults(urls, { desc, title });
      // An earlier audit left findings everywhere: some pages have since been
      // fixed, some still fail, some were not evaluated this time (ttfb skips),
      // and some are pages this run did not crawl at all.
      const uncrawled = Array.from({ length: 20 }, (_, i) => `https://site.test/old/${i}`);
      const priors = [
        ...urls
          .filter((_, i) => i % 2 === 0)
          .map((u) => prior(u, "meta-description", "has-description")),
        ...urls.filter((_, i) => i % 3 === 0).map((u) => prior(u, "title", "has-title")),
        ...urls
          .filter((_, i) => i % 7 === 3 || i % 4 === 0)
          .map((u) => prior(u, "perf/ttfb", "ttfb")),
        ...uncrawled.map((u) => prior(u, "meta-description", "has-description")),
      ];
      const known = [...urls, ...uncrawled];

      const legacySignal = buildResolutionSignal(full, urls)!;
      const compactSignal = await decodeResolutionSignal(buildCompactResolutionSignal(full, urls)!);
      const legacyStore = await seededStore(known, priors);
      const compactStore = await seededStore(known, priors);
      const legacy = await publish(legacyStore, samplePayload(full, urls, legacySignal));
      const compact = await publish(compactStore, samplePayload(full, urls, compactSignal));

      expect([...compactStore.findings.entries()].sort()).toEqual(
        [...legacyStore.findings.entries()].sort(),
      );
      expect([...compactStore.pages.entries()].sort()).toEqual(
        [...legacyStore.pages.entries()].sort(),
      );
      expect(compact.coverage).toEqual(legacy.coverage);
      expect(calculateHealthScore({ results: compact.unionRuleResults })).toEqual(
        calculateHealthScore({ results: legacy.unionRuleResults }),
      );
      // Not vacuous: the signal resolved fixed pages and carried the rest.
      const states = [...compactStore.findings.values()].map((f) => f.state);
      expect(states).toContain("resolved");
      expect(states).toContain("open");
    });
  }
});

/**
 * 600 short URLs and 200 cheap all-pass rules, with `desc` failing on a random
 * half of the pages: the one key that costs a bit a page whatever the encoding.
 * Just under the whole signal's size, the builder drops `desc` and keeps every
 * page listed.
 */
async function droppedKeyScenario() {
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0) / 2 ** 32;
  const urls = Array.from({ length: 600 }, (_, i) => `https://s.test/${i}`);
  const desc = new Set(urls.filter(() => random() < 0.5));
  const full = fullResults(urls, { desc });
  for (let r = 0; r < 200; r++) {
    full[`clean-${r}`] = {
      meta: meta(`clean-${r}`),
      checks: [
        { name: "c", status: "pass", message: "ok", pages: urls, details: { aggregated: true } },
      ],
    };
  }
  const whole = JSON.stringify(buildCompactResolutionSignal(full, urls)).length;
  const signal = await decodeResolutionSignal(
    buildCompactResolutionSignal(full, urls, whole - 60)!,
  );
  const payload = samplePayload(full, urls, signal);
  const descChecks = payload.ruleResults["meta-description"]!.checks;
  return {
    urls,
    desc,
    full,
    signal,
    payload,
    sampled: new Set(descChecks.flatMap((c) => c.pages ?? [])),
    failSample: new Set(
      descChecks.filter((c) => c.status === "fail").flatMap((c) => c.pages ?? []),
    ),
  };
}

/**
 * 600 long, distinct URLs: they do not fit in 8 KB, so the builder clips the
 * list to a crawl-order prefix. `lateFailing` is a page past that prefix that
 * still fails `desc` and was clipped from desc's published sample; `rare` fails
 * on it alone (and evaluates no other page), with `rareItems` items, so the
 * sampled payload still names it.
 */
async function clippedListScenario(rareItems = 0) {
  const urls = Array.from(
    { length: 600 },
    (_, i) =>
      `https://news.test/2024/${1 + (i % 12)}/${(i * 7919) % 9973}/${(i * 104_729).toString(36)}-${(i * 31).toString(16)}-story`,
  );
  const desc = new Set(urls.filter((_, i) => i % 3 === 0));
  const descSample = new Set(
    samplePayload(fullResults(urls, { desc }), urls, undefined).ruleResults[
      "meta-description"
    ]!.checks.flatMap((c) => c.pages ?? []),
  );
  const lateFailing = urls.findLast((u) => desc.has(u) && !descSample.has(u))!;
  const full = fullResults(urls, { desc });
  // One per-page check, so publish keeps it as it is (no fold, no page sample)
  // and clips only its items.
  const items = Array.from({ length: rareItems }, (_, i) => ({ id: `item-${i}`, label: `#${i}` }));
  full.rare!.checks = [
    { ...check("rare", lateFailing, "fail"), ...(rareItems > 0 ? { items } : {}) },
  ];
  const signal = await decodeResolutionSignal(buildCompactResolutionSignal(full, urls, 8 * 1024)!);
  return { urls, desc, descSample, lateFailing, full, signal, listed: new Set(signal.crawledUrls) };
}

describe("what the byte budget gives up only ever keeps findings open", () => {
  test("a key the budget dropped resolves nothing, even on pages the sample clipped", async () => {
    const { urls, desc, full, signal, payload, sampled } = await droppedKeyScenario();
    const key = "meta-description|has-description";
    // The scenario is what it claims: every page listed, `desc` dropped.
    expect(signal.crawledComplete).toBeUndefined();
    expect(signal.failing[key]).toBeUndefined();
    expect(signal.truncated).toContain(key);

    const stillFailing = urls.find((u) => desc.has(u) && !sampled.has(u))!;
    const nowClean = urls.find((u) => !desc.has(u) && !sampled.has(u))!;
    expect(stillFailing).toBeDefined();
    expect(nowClean).toBeDefined();
    const priors = [stillFailing, nowClean].map((u) =>
      prior(u, "meta-description", "has-description"),
    );

    const store = await seededStore(urls, priors);
    await publish(store, payload);
    expect(stateOf(store, stillFailing, "meta-description", "has-description")).toBe(
      "open:carried",
    );
    expect(stateOf(store, nowClean, "meta-description", "has-description")).toBe("open:carried");

    // Control: with the key kept, the clean page resolves. Dropping it costs
    // that resolution (until a later run), and nothing else.
    const control = await seededStore(urls, priors);
    await publish(control, samplePayload(full, urls, buildResolutionSignal(full, urls)));
    expect(stateOf(control, stillFailing, "meta-description", "has-description")).toBe(
      "open:carried",
    );
    expect(stateOf(control, nowClean, "meta-description", "has-description")).toBe(
      "resolved:fresh",
    );
  });

  test("a dropped key keeps an item open on a page the sample kept but whose items it clipped", async () => {
    // The page is in desc's published sample, so the payload says it still fails;
    // a folded aggregate's item list is a sample, so an item missing from it is
    // no evidence the item is gone. With the key dropped, no signal says either.
    const { urls, full, payload, failSample } = await droppedKeyScenario();
    const page = urls.find((u) => failSample.has(u))!;
    const priors = [prior(page, "meta-description", "has-description", "gone-or-clipped")];
    const store = await seededStore(urls, priors);
    await publish(store, payload);
    expect(stateOf(store, page, "meta-description", "has-description", "gone-or-clipped")).toBe(
      "open:carried",
    );
    // The original signal reaches the same verdict from the other side.
    const control = await seededStore(urls, priors);
    await publish(control, samplePayload(full, urls, buildResolutionSignal(full, urls)));
    expect(stateOf(control, page, "meta-description", "has-description", "gone-or-clipped")).toBe(
      "open:carried",
    );
  });

  test("a clipped page list speaks for listed pages only, and still counts every page", async () => {
    const { urls, desc, descSample, lateFailing, full, signal, listed } =
      await clippedListScenario();
    expect(urls.indexOf(lateFailing)).toBeGreaterThan(500);
    expect(signal.crawledComplete).toBe(false);
    expect(signal.crawledCount).toBe(600);
    expect(listed.has(normalizePageUrl(lateFailing))).toBe(false);
    const listedClean = urls.find((u) => listed.has(normalizePageUrl(u)) && !desc.has(u))!;
    // Clean now, unlisted, and in neither of desc's published samples (a page
    // the pass sample kept is evidence of its own, and resolves either way).
    const unlistedClean = urls.findLast(
      (u) => !listed.has(normalizePageUrl(u)) && !desc.has(u) && !descSample.has(u),
    )!;

    const payload = samplePayload(full, urls, signal);
    const priors = [lateFailing, listedClean, unlistedClean].map((u) =>
      prior(u, "meta-description", "has-description"),
    );
    const store = await seededStore(urls, priors);
    const result = await publish(store, payload);

    // Still failing, unlisted, clipped from the sample: carried, never resolved.
    expect(stateOf(store, lateFailing, "meta-description", "has-description")).toBe("open:carried");
    // A listed page the signal shows clean: resolved, as with the whole list.
    expect(stateOf(store, listedClean, "meta-description", "has-description")).toBe(
      "resolved:fresh",
    );
    // An unlisted clean page has no evidence either way: carried until a later run.
    expect(stateOf(store, unlistedClean, "meta-description", "has-description")).toBe(
      "open:carried",
    );
    // The audited count (and the bill read off it) does not drop with the list.
    expect(result.coverage.auditedPages).toBe(600);
  });

  test("an unlisted page keeps an item its clipped item list left out", async () => {
    // 200 items on the page, 50 published: item-199 may still be there.
    const { urls, lateFailing, full, signal, listed } = await clippedListScenario(200);
    expect(listed.has(normalizePageUrl(lateFailing))).toBe(false);
    const payload = samplePayload(full, urls, signal);
    const published = payload.ruleResults.rare!.checks.find((c) => c.pageUrl === lateFailing)!;
    expect(published.items!.length).toBeLessThan(200);
    const priors = [prior(lateFailing, "rare", "rare", "item-199")];

    const store = await seededStore(urls, priors);
    await publish(store, payload);
    expect(stateOf(store, lateFailing, "rare", "rare", "item-199")).toBe("open:carried");
    const control = await seededStore(urls, priors);
    await publish(control, samplePayload(full, urls, buildResolutionSignal(full, urls)));
    expect(stateOf(control, lateFailing, "rare", "rare", "item-199")).toBe("open:carried");
  });

  test("an unlisted page keeps a whole-check finding while the check still fails there", async () => {
    // This run lists items for the page; the prior finding predates them (no
    // locator), so nothing supersedes it, and the page still fails the check.
    const { urls, lateFailing, full, signal, listed } = await clippedListScenario(200);
    expect(listed.has(normalizePageUrl(lateFailing))).toBe(false);
    const priors = [prior(lateFailing, "rare", "rare")];
    const store = await seededStore(urls, priors);
    await publish(store, samplePayload(full, urls, signal));
    expect(stateOf(store, lateFailing, "rare", "rare")).toBe("open:carried");
    const control = await seededStore(urls, priors);
    await publish(control, samplePayload(full, urls, buildResolutionSignal(full, urls)));
    expect(stateOf(control, lateFailing, "rare", "rare")).toBe("open:carried");
  });

  test("off a clipped list, a skipped check stays open and only a pass resolves", async () => {
    // `probe` ran on two pages past the list, as per-page rows the publish keeps
    // whole: no data on one (skipped), a pass on the other. With no sample to
    // guard either, the payload's word is all there is.
    const { urls, full } = await clippedListScenario();
    const skippedPage = urls.at(-1)!;
    const passedPage = urls.at(-2)!;
    full.probe = {
      meta: meta("probe"),
      checks: [check("probe", skippedPage, "skipped"), check("probe", passedPage, "pass")],
    };
    const signal = await decodeResolutionSignal(
      buildCompactResolutionSignal(full, urls, 8 * 1024)!,
    );
    const listed = new Set(signal.crawledUrls);
    expect(signal.crawledComplete).toBe(false);
    expect(listed.has(normalizePageUrl(skippedPage))).toBe(false);
    expect(listed.has(normalizePageUrl(passedPage))).toBe(false);

    const priors = [prior(skippedPage, "probe", "probe"), prior(passedPage, "probe", "probe")];
    const store = await seededStore(urls, priors);
    await publish(store, samplePayload(full, urls, signal));
    expect(stateOf(store, skippedPage, "probe", "probe")).toBe("open:carried");
    expect(stateOf(store, passedPage, "probe", "probe")).toBe("resolved:fresh");
    // The whole original signal decides the same, from its not-evaluated set.
    const control = await seededStore(urls, priors);
    await publish(control, samplePayload(full, urls, buildResolutionSignal(full, urls)));
    expect(stateOf(control, skippedPage, "probe", "probe")).toBe("open:carried");
    expect(stateOf(control, passedPage, "probe", "probe")).toBe("resolved:fresh");
  });

  test("removed pages pageStatuses had to clip are still removed and not counted as audited", async () => {
    const urls = Array.from(
      { length: 600 },
      (_, i) => `https://shop.test/products/${i}-${"widget-".repeat(20)}${i * 7}`,
    );
    const live = urls.slice(0, 100);
    const gone = urls.slice(100);
    const full = fullResults(live, { desc: new Set(live.filter((_, i) => i % 5 === 0)) });
    const out = buildPublishResolution(
      full,
      urls.map((url, i) => ({ url, statusCode: i < 100 ? 200 : 404 })),
    );
    // The scenario is what it claims: most removed pages are past the clip.
    expect(out.pageStatuses!.length).toBeLessThan(gone.length / 2);
    const signal = await decodeResolutionSignal(out.resolutionSignalCompact!);
    const priors = gone.map((u) => prior(u, "meta-description", "has-description"));

    const run = async (
      pageStatuses: Array<{ url: string; status: number }>,
      resolutionSignal: ResolutionSignal,
    ) => {
      const store = await seededStore(urls, priors);
      const payload = samplePayload(full, live, resolutionSignal);
      const result = await runCloudSmartAudits({
        store,
        siteKey: SITE_KEY,
        crawlId: "audit_1",
        ruleResults: payload.ruleResults,
        pageStatuses,
        resolutionSignal,
        now: NOW,
      });
      return { store, result };
    };
    const compact = await run(out.pageStatuses!, signal);
    const legacy = await run(
      gone.map((url) => ({ url, status: 404 })),
      buildResolutionSignal(full, urls)!,
    );
    for (const { store, result } of [compact, legacy]) {
      expect(result.coverage.auditedPages).toBe(100);
      expect(result.removedPages).toBe(500);
      // `markPagesRemoved` is what stales a removed page's findings, in the
      // same transaction (this test store records the page only).
      for (const u of gone) expect(store.pages.get(u)?.state).toBe("removed");
    }
  });

  test("off a clipped list, a pass does not outweigh a failing row for the same check", async () => {
    // A rule may report one check name more than once on a page. Here `rare`
    // both fails (200 items, 50 published) and passes on the same late page.
    const { urls, lateFailing, full } = await clippedListScenario(200);
    full.rare!.checks.push(check("rare", lateFailing, "pass"));
    const signal = await decodeResolutionSignal(
      buildCompactResolutionSignal(full, urls, 8 * 1024)!,
    );
    expect(new Set(signal.crawledUrls).has(normalizePageUrl(lateFailing))).toBe(false);
    const priors = [prior(lateFailing, "rare", "rare", "item-199")];
    const store = await seededStore(urls, priors);
    await publish(store, samplePayload(full, urls, signal));
    expect(stateOf(store, lateFailing, "rare", "rare", "item-199")).toBe("open:carried");
  });

  test("off a clipped list, a pass does not outweigh a failing sample that left the page out", async () => {
    // `dual` fails on pages 0-549 and passes on 480-599, so pages 480-549 do
    // both. Each status folds into a sampled aggregate: pick a late page the
    // pass sample kept and the fail sample dropped.
    const { urls, full } = await clippedListScenario();
    full.dual = {
      meta: meta("dual"),
      checks: [
        ...urls.slice(0, 550).map((u) => check("dual", u, "fail")),
        ...urls.slice(480).map((u) => check("dual", u, "pass")),
      ],
    };
    const signal = await decodeResolutionSignal(
      buildCompactResolutionSignal(full, urls, 8 * 1024)!,
    );
    const listed = new Set(signal.crawledUrls);
    const payload = samplePayload(full, urls, signal);
    const samples = (status: string) =>
      new Set(
        payload.ruleResults.dual!.checks.filter((c) => c.status === status).flatMap((c) => c.pages ?? []),
      );
    const passSample = samples("pass");
    const failSample = samples("fail");
    const page = urls
      .slice(480, 550)
      .find((u) => passSample.has(u) && !failSample.has(u) && !listed.has(normalizePageUrl(u)));
    expect(page).toBeDefined();
    const priors = [prior(page!, "dual", "dual")];
    const store = await seededStore(urls, priors);
    await publish(store, payload);
    expect(stateOf(store, page!, "dual", "dual")).toBe("open:carried");
    const control = await seededStore(urls, priors);
    await publish(control, samplePayload(full, urls, buildResolutionSignal(full, urls)));
    expect(stateOf(control, page!, "dual", "dual")).toBe("open:carried");
  });

  test("off a clipped list, the rule's noindex verdict still resolves", async () => {
    // The runner's noindex gate: nothing the rule reports applies to the page,
    // which the signal reads as clean for every check of the rule.
    const { urls, full } = await clippedListScenario();
    const page = urls.at(-1)!;
    full.gated = {
      meta: meta("gated"),
      checks: [
        {
          name: "gated",
          status: "skipped",
          message: "noindex",
          pageUrl: page,
          skipReason: "noindex",
          details: { foldKey: "noindex" },
        },
        check("gated", urls[0]!, "pass"),
      ],
    };
    const signal = await decodeResolutionSignal(
      buildCompactResolutionSignal(full, urls, 8 * 1024)!,
    );
    expect(new Set(signal.crawledUrls).has(normalizePageUrl(page))).toBe(false);
    const priors = [prior(page, "gated", "other-check")];
    const store = await seededStore(urls, priors);
    await publish(store, samplePayload(full, urls, signal));
    expect(stateOf(store, page, "gated", "other-check")).toBe("resolved:fresh");
    const control = await seededStore(urls, priors);
    await publish(control, samplePayload(full, urls, buildResolutionSignal(full, urls)));
    expect(stateOf(control, page, "gated", "other-check")).toBe("resolved:fresh");
  });

  test("a clipped list's audited count leaves out removed pages the merge cannot name", async () => {
    // The last 100 pages 404'd. The payload still names every page (two small
    // per-page rules, kept whole), pageStatuses was clipped to 10 of the 404s,
    // and most 404s are off the list.
    const { urls, full } = await clippedListScenario();
    const gone = urls.slice(500);
    full.probeA = { meta: meta("probeA"), checks: urls.slice(0, 300).map((u) => check("a", u, "pass")) };
    full.probeB = { meta: meta("probeB"), checks: urls.slice(300).map((u) => check("b", u, "pass")) };
    const signal = await decodeResolutionSignal(
      buildCompactResolutionSignal(
        full,
        urls,
        8 * 1024,
        gone.map((url) => ({ url, status: 404 })),
      )!,
    );
    expect(signal.crawledComplete).toBe(false);
    expect(signal.removedCount).toBe(100);
    const store = await seededStore(urls, []);
    const result = await runCloudSmartAudits({
      store,
      siteKey: SITE_KEY,
      crawlId: "audit_1",
      ruleResults: samplePayload(full, urls, signal).ruleResults,
      pageStatuses: gone.slice(0, 10).map((url) => ({ url, status: 404 })),
      resolutionSignal: signal,
      now: NOW,
    });
    expect(result.coverage.auditedPages).toBe(500);
  });
});
