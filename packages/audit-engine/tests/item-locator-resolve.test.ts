// A renamed or fixed item on a page that still fails the check resolves (pub#474).
//
// An item finding's identity is URL + rule + check + locator. With the publish
// resolution signal (#1185), a prior item with no fresh match was resolved only
// when the page dropped out of the check's failing set, and that set is
// page-level. So while the page failed the check for ANY item, every unmatched
// prior item on it was carried: a rule that renamed its item ids (#462's bare
// `dialog` → `dialog.newsletter-popup`) or a fixed item next to an unfixed one
// stayed open indefinitely, its last-seen refreshed every run.
//
// The fix: when this run's item list for that page and check is provably
// complete, an unmatched prior item resolves. A capped list (a rule cap, a
// publish clip, an unfolded aggregate) keeps carrying, because there a missing
// item is not proof it is gone.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  ResolutionSignal,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { parsePage } from "@squirrelscan/parser";
import { loadAllRules } from "@squirrelscan/rules";
import { foldOverflowChecks } from "@squirrelscan/rules/fold";
import type { RuleContext } from "@squirrelscan/rules/types";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import {
  computeMerge,
  findingKey,
  flattenChecks,
  itemListComplete,
  LEGACY_SILENT_ITEM_CAPS,
  pageCheckKey,
  SCAN_BUDGET_CHECKS,
  type MergeResolutionInput,
} from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";

const SITE = "web_474";
const RULE = "a11y/aria-dialog-name";
const CHECK = "dialog-name";
const KEY = `${RULE}|${CHECK}`;
const PAGE = "https://x.test/";
const OTHER = "https://x.test/about";
const URL = normalizePageUrl(PAGE);

const meta = {
  id: RULE,
  name: "Dialog Name",
  description: "Dialogs have accessible names",
  category: "a11y",
  scope: "page" as const,
  severity: "warning" as const,
  weight: 5,
};

function dialogCheck(ids: string[], details?: Record<string, unknown>): CheckResult {
  return {
    name: CHECK,
    status: "warn",
    message: `${ids.length} native <dialog>(s) without accessible names`,
    pageUrl: PAGE,
    items: ids.map((id) => ({ id })),
    ...(details ? { details } : {}),
  };
}

// ── computeMerge ────────────────────────────────────────────────────────────

/** Run 1: the page fails with the legacy bare `dialog` item. */
function seedPriors(): PageFindingRecord[] {
  const first = computeMerge({
    siteKey: SITE,
    crawlId: "audit_1",
    crawledUrls: new Set([URL]),
    freshFindings: flattenChecks(URL, RULE, [dialogCheck(["dialog"])]),
    removedUrls: new Set(),
    severityByRule: new Map([[RULE, "warning"]]),
    statusByUrl: new Map([[URL, 200]]),
    priorFindings: [],
    priorPages: [],
    now: 1_000,
  });
  return first.persisted;
}

/** Run 2: a rule change renamed the item; the page still fails the check. */
function mergeRenamed(opts: {
  resolution?: MergeResolutionInput;
  completeItemChecks?: Set<string>;
  freshChecks?: CheckResult[];
}) {
  const freshChecks = opts.freshChecks ?? [dialogCheck(["dialog.newsletter-popup"])];
  return computeMerge({
    siteKey: SITE,
    crawlId: "audit_2",
    crawledUrls: new Set([URL]),
    freshFindings: flattenChecks(URL, RULE, freshChecks),
    removedUrls: new Set(),
    severityByRule: new Map([[RULE, "warning"]]),
    statusByUrl: new Map([[URL, 200]]),
    priorFindings: seedPriors(),
    priorPages: [],
    now: 2_000,
    resolution: opts.resolution,
    completeItemChecks: opts.completeItemChecks,
  });
}

/** The unsampled publish signal for run 2: the page still fails the check. */
const stillFailing: MergeResolutionInput = {
  crawledUrls: new Set([URL]),
  failingByCheck: new Map([[KEY, new Set([resolutionUrlHash(URL)])]]),
  notEvaluatedByCheck: new Map(),
  truncatedChecks: new Set(),
};

function ghost(persisted: PageFindingRecord[]): PageFindingRecord | undefined {
  return persisted.find((r) => r.locator === "dialog");
}

describe("computeMerge: a renamed locator on a still-failing page (pub#474)", () => {
  test("without the resolution signal (local merge) the old locator resolves", () => {
    const merged = mergeRenamed({});
    expect(ghost(merged.persisted)?.state).toBe("resolved");
    expect(merged.findings.map((f) => f.locator)).toEqual(["dialog.newsletter-popup"]);
  });

  test("with the signal and a complete fresh list, the old locator resolves", () => {
    const merged = mergeRenamed({
      resolution: stillFailing,
      completeItemChecks: new Set([pageCheckKey(URL, RULE, CHECK)]),
    });
    const old = ghost(merged.persisted)!;
    expect(old.state).toBe("resolved");
    expect(old.lastSeenCrawlId).toBe("audit_2");
    expect(merged.findings.map((f) => f.locator)).toEqual(["dialog.newsletter-popup"]);
  });

  test("with the signal and a capped fresh list, the old locator still carries", () => {
    // No complete-list evidence for the page: today's behaviour, carried with
    // its last-seen refreshed because the signal confirmed the page fails.
    const merged = mergeRenamed({ resolution: stillFailing });
    const old = ghost(merged.persisted)!;
    expect(old.state).toBe("open");
    expect(old.provenance).toBe("carried");
    expect(old.lastSeenCrawlId).toBe("audit_2");
    expect(merged.findings.map((f) => f.locator).sort()).toEqual([
      "dialog",
      "dialog.newsletter-popup",
    ]);
  });

  test("a complete list for ANOTHER page does not resolve this page's item", () => {
    const merged = mergeRenamed({
      resolution: stillFailing,
      completeItemChecks: new Set([pageCheckKey(normalizePageUrl(OTHER), RULE, CHECK)]),
    });
    expect(ghost(merged.persisted)?.state).toBe("open");
  });

  test("a matched locator is never resolved by the complete-list branch", () => {
    const merged = mergeRenamed({
      resolution: stillFailing,
      completeItemChecks: new Set([pageCheckKey(URL, RULE, CHECK)]),
      freshChecks: [dialogCheck(["dialog", "dialog.newsletter-popup"])],
    });
    expect(merged.persisted.filter((r) => r.state === "resolved")).toEqual([]);
    expect(ghost(merged.persisted)?.provenance).toBe("fresh");
  });

  test("a page the check did not evaluate carries even with a complete-list key", () => {
    const merged = mergeRenamed({
      resolution: {
        ...stillFailing,
        notEvaluatedByCheck: new Map([[KEY, new Set([resolutionUrlHash(URL)])]]),
      },
      completeItemChecks: new Set([pageCheckKey(URL, RULE, CHECK)]),
    });
    expect(ghost(merged.persisted)?.state).toBe("open");
  });
});

// ── itemListComplete ────────────────────────────────────────────────────────

describe("itemListComplete", () => {
  test("items with no remainder are complete", () => {
    expect(itemListComplete(RULE, dialogCheck(["a", "b"]))).toBe(true);
    expect(itemListComplete(RULE, dialogCheck(["a"], { additional: 0 }))).toBe(true);
  });

  test("a recorded remainder, even a malformed one, is not", () => {
    expect(itemListComplete(RULE, dialogCheck(["a"], { additional: 3 }))).toBe(false);
    expect(itemListComplete(RULE, dialogCheck(["a"], { additional: "3" }))).toBe(false);
  });

  test("an aggregate or a check without items is not", () => {
    expect(itemListComplete(RULE, dialogCheck(["a"], { aggregated: true }))).toBe(false);
    expect(
      itemListComplete(RULE, { name: CHECK, status: "warn", message: "m", pageUrl: PAGE }),
    ).toBe(false);
  });

  test("a real capped rule (a11y/tabindex, 12 elements) is not complete", () => {
    const body = Array.from(
      { length: 12 },
      (_, i) => `<button id="b${i}" tabindex="${i + 1}">b</button>`,
    ).join("");
    const html = `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;
    const ctx = {
      page: { url: PAGE, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(html, PAGE),
      options: {},
    } as unknown as RuleContext;
    const result = loadAllRules().get("a11y/tabindex")!.run(ctx);
    if (result instanceof Promise) throw new Error("tabindex is async");
    const positive = result.checks.find((c) => c.name === "tabindex-positive")!;
    expect(positive.items).toHaveLength(10);
    expect(itemListComplete("a11y/tabindex", positive)).toBe(false);
  });

  test("a rule that stopped at a scan budget is not complete", () => {
    expect(itemListComplete(RULE, dialogCheck(["a"], { scanTruncated: true }))).toBe(false);
  });

  test("a budgeted check is complete only when it says it finished the scan", () => {
    const hidden = (details?: Record<string, unknown>): CheckResult => ({
      name: "hidden-text",
      status: "warn",
      message: "1 hidden element(s) containing 64 characters of text",
      pageUrl: PAGE,
      items: [{ id: "div#one" }],
      ...(details ? { details } : {}),
    });
    // An older publisher sends no marker at all: its walk may have stopped early.
    expect(itemListComplete("content/hidden-text", hidden({ hiddenElements: 1 }))).toBe(false);
    expect(itemListComplete("content/hidden-text", hidden())).toBe(false);
    expect(itemListComplete("content/hidden-text", hidden({ scanTruncated: true }))).toBe(false);
    expect(itemListComplete("content/hidden-text", hidden({ scanTruncated: false }))).toBe(true);
  });

  test("a bare list at a cap an older release did not record is not complete", () => {
    // An older publisher sends a11y/tabindex's ten-item cap with no remainder.
    const bare = (n: number): CheckResult => ({
      name: "tabindex-positive",
      status: "warn",
      message: `${n} element(s) with positive tabindex`,
      pageUrl: PAGE,
      items: Array.from({ length: n }, (_, i) => ({ id: `button#b${i} (tabindex=${i + 1})` })),
    });
    expect(itemListComplete("a11y/tabindex", bare(10))).toBe(false);
    expect(itemListComplete("a11y/tabindex", bare(9))).toBe(true);
    // The cap is keyed by rule AND check: another rule's ten-item list is not affected.
    expect(itemListComplete(RULE, { ...bare(10), name: CHECK })).toBe(true);
  });

  test("every legacy cap and budgeted check names a real rule", () => {
    const rules = loadAllRules();
    for (const key of [...LEGACY_SILENT_ITEM_CAPS.keys(), ...SCAN_BUDGET_CHECKS]) {
      const ruleId = key.slice(0, key.indexOf("|"));
      expect(rules.has(ruleId)).toBe(true);
    }
  });
});

// ── runCloudSmartAudits (the sampled publish path) ──────────────────────────

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

const h = (url: string) => resolutionUrlHash(normalizePageUrl(url));
const statuses = [PAGE, OTHER].map((url) => ({ url, status: 200 }));

async function publishTwice(run2Checks: CheckResult[]): Promise<Map<string, PageFindingRecord>> {
  const store = new MemStore();
  await runCloudSmartAudits({
    store,
    siteKey: SITE,
    crawlId: "audit_1",
    ruleResults: { [RULE]: { meta, checks: [dialogCheck(["dialog", "dialog.cart"])] } },
    pageStatuses: statuses,
  });
  const signal: ResolutionSignal = {
    crawledUrls: [PAGE, OTHER],
    failing: { [KEY]: [h(PAGE), h(OTHER)] },
  };
  await runCloudSmartAudits({
    store,
    siteKey: SITE,
    crawlId: "audit_2",
    ruleResults: { [RULE]: { meta, checks: run2Checks } },
    pageStatuses: statuses,
    resolutionSignal: signal,
  });
  const byLocator = new Map<string, PageFindingRecord>();
  for (const f of await store.getFindings(SITE)) {
    if (f.normalizedUrl === URL) byLocator.set(f.locator, f);
  }
  return byLocator;
}

describe("runCloudSmartAudits: a still-failing page's unlisted item (pub#474)", () => {
  test("a complete published list resolves the item it no longer holds", async () => {
    // `dialog.cart` got a name; `dialog` was renamed by the rule.
    const rows = await publishTwice([dialogCheck(["dialog.newsletter-popup"])]);
    expect(rows.get("dialog")?.state).toBe("resolved");
    expect(rows.get("dialog.cart")?.state).toBe("resolved");
    expect(rows.get("dialog.newsletter-popup")?.state).toBe("open");
  });

  test("a list with a recorded remainder carries the items it does not show", async () => {
    const rows = await publishTwice([
      dialogCheck(["dialog.newsletter-popup"], { additional: 4 }),
    ]);
    expect(rows.get("dialog")?.state).toBe("open");
    expect(rows.get("dialog")?.provenance).toBe("carried");
    expect(rows.get("dialog.cart")?.state).toBe("open");
  });

  test("a page rebuilt from a folded aggregate carries (its list is the fold's attribution)", async () => {
    const other: CheckResult = { ...dialogCheck(["dialog.promo"]), pageUrl: OTHER };
    const folded = foldOverflowChecks([dialogCheck(["dialog.newsletter-popup"]), other], {
      maxChecks: 1,
      maxItemsPerCheck: 1000,
      maxPagesPerCheck: 1000,
      maxSourcePagesPerItem: 100,
    });
    expect(folded).toHaveLength(1);
    expect(folded[0]!.details?.aggregated).toBe(true);
    const rows = await publishTwice(folded);
    expect(rows.get("dialog")?.state).toBe("open");
    expect(rows.get("dialog.cart")?.state).toBe("open");
    expect(rows.get("dialog.newsletter-popup")?.state).toBe("open");
  });

  test("a rule whose published check array was cut carries", async () => {
    const rows = await publishTwice([
      dialogCheck(["dialog.newsletter-popup"], { checksTruncated: 300 }),
    ]);
    expect(rows.get("dialog")?.state).toBe("open");
  });

  test("a sibling aggregate of the same name that skipped this page makes the key incomplete", async () => {
    // perf/source-maps emits several checks under one name, split by foldKey. A
    // sampled aggregate whose pages leave this page out can still hold its items,
    // so the page's own standalone list is not the whole story.
    const aggregate: CheckResult = {
      name: CHECK,
      status: "warn",
      message: "shared (+4 more pages)",
      pages: [OTHER],
      items: [{ id: "dialog.cart", sourcePages: [OTHER] }],
      details: { aggregated: true, occurrences: 5, pagesTruncated: 5, foldKey: "shared" },
    };
    const rows = await publishTwice([
      { ...dialogCheck(["dialog.newsletter-popup"]), details: { foldKey: "local" } },
      aggregate,
    ]);
    expect(rows.get("dialog")?.state).toBe("open");
    expect(rows.get("dialog.cart")?.state).toBe("open");
  });

  test("two same-name checks on the page: one capped makes the key incomplete", async () => {
    const rows = await publishTwice([
      dialogCheck(["dialog.newsletter-popup"]),
      { ...dialogCheck(["dialog.drawer"], { additional: 2 }), status: "fail" },
    ]);
    expect(rows.get("dialog")?.state).toBe("open");
    expect(rows.get("dialog.cart")?.state).toBe("open");
  });
});
