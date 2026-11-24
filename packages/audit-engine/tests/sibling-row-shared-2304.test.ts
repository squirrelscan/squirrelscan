// pub#2304: sibling rows of a multi-item shared-component check are neutral in
// addChecksToTally, so a carried replay (one row per item) scores like a fresh
// full audit (one check). Rows come from the REAL flattenChecks.

import type {
  CheckResult,
  ComponentOccurrence,
  PageFindingRecord,
} from "@squirrelscan/core-contracts";
import type { RuleMeta } from "@squirrelscan/rules";

import { describe, expect, test } from "bun:test";

import {
  aggregateUntouchedCarried,
  createCompleteStoreTallyFold,
  untouchedCarriedFinding,
} from "../src/complete-store-fold";
import { flattenChecks } from "../src/merge-core";
import {
  addChecksToTally,
  calculateHealthScoreFromTallies,
  carriedFindingToCheck,
  emptyTally,
} from "../src/scoring";

const SITE = "https://example.test";
const CRAWLED = `${SITE}/crawled`;
const PAGES = Array.from({ length: 25 }, (_, i) => `${SITE}/u${i}`);
const BACKDROP = "a11y/backdrop";
const MULTI = "a11y/multi-logo";
const MIXED = "a11y/mixed-logo";
const CONTROL = "a11y/plain";

function meta(id: string): RuleMeta {
  return {
    id,
    name: id,
    description: id,
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 1,
  } as RuleMeta;
}

function occurrence(pageUrl: string, n: number): ComponentOccurrence {
  return {
    version: 1,
    pageUrl,
    siteOrigin: SITE,
    provenance: { source: "page-dom", rendered: true },
    groupable: true,
    confidence: "observed",
    region: { role: "header", nestedIn: "none", structuralSignature: "s:r" },
    family: { key: "s:f", structuralSignature: "s:f" },
    variant: { key: "s:v", structuralSignature: "s:v", contentHash: "s:c" },
    element: { locator: `header>a:${n}`, structuralSignature: `s:e${n}` },
    defect: { kind: "link-text-empty", values: {}, valueHashes: {} },
  };
}

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `item ${i}` }));

function sharedCheck(url: string, name: string, n: number): CheckResult {
  return {
    name,
    status: "fail",
    message: "m",
    pageUrl: url,
    items: items(n),
    componentOccurrences: Array.from({ length: n }, (_, i) =>
      occurrence(url, i)
    ),
  } as unknown as CheckResult;
}

function plainCheck(url: string, name: string, n: number): CheckResult {
  return {
    name,
    status: "fail",
    message: "m",
    pageUrl: url,
    items: items(n),
  } as unknown as CheckResult;
}

/** Fresh checks of one page, by rule id. */
type PageChecks = Record<string, CheckResult[]>;

function pageChecks(url: string, mode: "multi" | "mixed" | "control") {
  const out: PageChecks = {};
  if (mode === "multi") out[MULTI] = [sharedCheck(url, "logo", 3)];
  if (mode === "mixed") {
    // One rule, two keys: a shared multi-item check and a plain one.
    out[MIXED] = [sharedCheck(url, "logo", 3), plainCheck(url, "other", 2)];
  }
  if (mode === "control") out[CONTROL] = [plainCheck(url, "logo", 3)];
  return out;
}

function toRows(url: string, checks: PageChecks): PageFindingRecord[] {
  return Object.entries(checks).flatMap(([ruleId, cs]) =>
    flattenChecks(url, ruleId, cs).map(
      (f) =>
        ({
          siteKey: "site",
          ...f,
          state: "open",
          provenance: "carried",
          firstSeenAt: 1,
          lastSeenAt: 1,
          lastSeenCrawlId: "audit_1",
        }) as unknown as PageFindingRecord
    )
  );
}

const metas = Object.fromEntries(
  [BACKDROP, MULTI, MIXED, CONTROL].map((id) => [id, meta(id)])
);

function ruleResults() {
  return Object.fromEntries(
    Object.entries(metas).map(([id, m]) => [
      id,
      {
        meta: m,
        checks: [
          {
            name: "x",
            status: "pass" as const,
            message: "ok",
            pageUrl: CRAWLED,
          },
        ],
      },
    ])
  );
}

function score(tallies: Map<string, unknown>) {
  return calculateHealthScoreFromTallies(
    tallies as never,
    new Map(Object.entries(ruleResults())) as never
  );
}

function perPage(mode: "multi" | "mixed" | "control") {
  const backdrop = Array.from({ length: 12 }, (_, i) => {
    const url = `${SITE}/b${i}`;
    return { url, checks: { [BACKDROP]: [plainCheck(url, "bd", 1)] } };
  });
  return [
    ...backdrop,
    ...PAGES.map((url) => ({ url, checks: pageChecks(url, mode) })),
  ] as Array<{ url: string; checks: PageChecks }>;
}

function carriedFold(
  mode: "multi" | "mixed" | "control",
  via: "stream" | "aggregate"
) {
  const pages = perPage(mode).map((p) => ({
    url: p.url,
    rows: toRows(p.url, p.checks),
  }));
  const fold = createCompleteStoreTallyFold({
    ruleResults: ruleResults() as never,
    crawledUrls: new Set([CRAWLED]),
    carriedPageUrls: new Set(pages.map((p) => p.url)),
    ruleMetaIndex: new Map(Object.entries(metas)),
    ...(via === "aggregate" ? { requireAggregatableCarried: true } : {}),
  });
  const carriedOf = (rows: PageFindingRecord[]) =>
    rows.map((r) => untouchedCarriedFinding(r, false));
  if (via === "aggregate") {
    for (const p of pages) fold.retainUntouchedSample(p.url, carriedOf(p.rows));
    const { aggregate } = aggregateUntouchedCarried(
      pages.map((p) => ({
        normalizedUrl: p.url,
        rows: p.rows,
        rendered: true,
        active: true,
      }))
    );
    fold.addUntouched(aggregate);
  } else {
    for (const p of pages) fold.foldPage(p.url, [], carriedOf(p.rows));
  }
  fold.foldShellRules();
  return fold.finish();
}

/** The fresh full audit: ONE check per (rule, page) with the evidence on it. */
function freshTallies(
  mode: "multi" | "mixed" | "control",
  carried: Map<string, { tally: { passed: number } }>
) {
  const byRule = new Map<string, CheckResult[]>();
  for (const p of perPage(mode))
    for (const [ruleId, cs] of Object.entries(p.checks))
      byRule.set(ruleId, [...(byRule.get(ruleId) ?? []), ...cs]);
  const tallies = new Map<
    string,
    { meta: RuleMeta; tally: ReturnType<typeof emptyTally> }
  >();
  for (const id of Object.keys(metas)) {
    const tally = emptyTally();
    // The shell's crawled-page pass, as the fold adds it.
    addChecksToTally(
      tally,
      [
        { name: "x", status: "pass", message: "ok", pageUrl: CRAWLED },
        ...(byRule.get(id) ?? []),
      ] as CheckResult[],
      false,
      // The fold also credits each carried page that is clean for the rule as a
      // pass; that bookkeeping is not what is under test, so take it from the
      // carried tally and compare the failure and shared units exactly.
      Math.max(0, carried.get(id)!.tally.passed - 1)
    );
    tallies.set(id, { meta: metas[id]!, tally });
  }
  return tallies;
}

describe("sibling rows are neutral in addChecksToTally (#2304)", () => {
  for (const mode of ["multi", "mixed"] as const) {
    test(`${mode}: fresh, carried stream and aggregate score byte-identically`, () => {
      const streamTallies = carriedFold(mode, "stream");
      const fresh = score(freshTallies(mode, streamTallies));
      const stream = score(streamTallies);
      const agg = score(carriedFold(mode, "aggregate"));
      expect(fresh.debug?.sharedComponentUnits).toBeGreaterThan(0);
      expect(JSON.stringify(stream)).toBe(JSON.stringify(fresh));
      expect(JSON.stringify(agg)).toBe(JSON.stringify(fresh));
    });
  }

  test("mixed: only the shared key counts as shared units", () => {
    for (const via of ["stream", "aggregate"] as const) {
      const t = carriedFold("mixed", via).get(MIXED)!.tally;
      expect(t.sharedFailUnits).toBe(3 * PAGES.length);
      expect(t.failUnits).toBe(5 * PAGES.length);
    }
  });

  test("multi: every carried page counts as shared units on both carried paths", () => {
    for (const via of ["stream", "aggregate"] as const) {
      const t = carriedFold("multi", via).get(MULTI)!.tally;
      expect(t.sharedFailUnits).toBe(3 * PAGES.length);
    }
  });

  test("control without components: carried equals fresh, no shared fields", () => {
    const fresh = score(
      freshTallies("control", carriedFold("control", "stream"))
    );
    expect(fresh.debug?.sharedComponentUnits).toBeUndefined();
    for (const via of ["stream", "aggregate"] as const) {
      const t = carriedFold("control", via);
      expect(JSON.stringify(score(t))).toBe(JSON.stringify(fresh));
      expect(t.get(CONTROL)!.tally.sharedFailUnits).toBeUndefined();
    }
  });

  function carriedChecks(check: CheckResult) {
    return flattenChecks(CRAWLED, MULTI, [check]).map((f) =>
      carriedFindingToCheck({ ...f, status: f.status } as never, CRAWLED)
    );
  }

  test("all siblings (owner row lost): not shared", () => {
    const rows = carriedChecks(sharedCheck(CRAWLED, "logo", 3));
    const siblings = rows.filter((c) => !c.componentOccurrences);
    expect(siblings).toHaveLength(2);
    const tally = emptyTally();
    addChecksToTally(tally, siblings);
    expect(tally.failUnits).toBe(2);
    expect(tally.sharedFailUnits).toBeUndefined();
    // Control: with the owner restored the same key IS shared.
    const whole = emptyTally();
    addChecksToTally(whole, rows);
    expect(whole.sharedFailUnits).toBe(3);
  });

  test("payload-limit marker stays unshared", () => {
    const rows = carriedChecks(sharedCheck(CRAWLED, "logo", 3));
    const owner = rows.find((c) => c.componentOccurrences)!;
    const markerOwner = {
      ...owner,
      componentOccurrences: undefined,
      componentEvidence: {
        state: "omitted",
        reason: "payload-limit",
        occurrenceCount: 3,
      },
    } as CheckResult;
    const siblings = rows.filter((c) => !c.componentOccurrences);
    const tally = emptyTally();
    addChecksToTally(tally, [...siblings, markerOwner]);
    expect(tally.sharedFailUnits).toBeUndefined();
  });
});
