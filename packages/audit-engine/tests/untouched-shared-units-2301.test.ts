// pub#2301: the untouched-carried aggregate keeps the shared-component units, so a partial
// re-audit (untouched pages through the aggregate) scores the same as the full fold of the
// same site (every page streamed).

import type {
  ComponentOccurrence,
  PageFindingRecord,
} from "@squirrelscan/core-contracts";
import type { RuleMeta } from "@squirrelscan/rules";

import { packComponentOccurrences } from "@squirrelscan/core-contracts/component-evidence";
import { describe, expect, test } from "bun:test";

import {
  aggregateUntouchedCarried,
  createCompleteStoreTallyFold,
  untouchedCarriedFinding,
} from "../src/complete-store-fold";
import { calculateHealthScoreFromTallies } from "../src/scoring";

const SITE = "https://example.test";
const CRAWLED = `${SITE}/crawled`;
const UNTOUCHED = Array.from({ length: 25 }, (_, i) => `${SITE}/u${i}`);

function meta(id: string, over: Partial<RuleMeta> = {}): RuleMeta {
  return {
    id,
    name: id,
    description: id,
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 1,
    ...over,
  };
}

function occurrence(pageUrl: string): ComponentOccurrence {
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
    element: { locator: "header>a:1", structuralSignature: "s:e" },
    defect: { kind: "link-text-empty", values: {}, valueHashes: {} },
  };
}

function row(
  url: string,
  ruleId: string,
  status: "fail" | "warn",
  component: boolean
): PageFindingRecord {
  const payload = component
    ? JSON.stringify({
        componentOccurrences: packComponentOccurrences([occurrence(url)]),
      })
    : null;
  return {
    siteKey: "site",
    normalizedUrl: url,
    ruleId,
    checkName: ruleId.split("/")[1]!,
    locator: "",
    status,
    message: "m",
    value: null,
    expected: null,
    payload,
    state: "open",
    provenance: "carried",
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastSeenCrawlId: "audit_1",
  } as unknown as PageFindingRecord;
}

const BACKDROP = "a11y/backdrop";
const LOGO = "a11y/logo-link";
const ADVISORY = "a11y/advisory-logo";
const WARNLOGO = "a11y/warn-logo";

function build(opts: { component: boolean; viaAggregate: boolean }) {
  const metas = {
    [BACKDROP]: meta(BACKDROP),
    [LOGO]: meta(LOGO),
    [ADVISORY]: meta(ADVISORY, { severity: "info" }),
    [WARNLOGO]: meta(WARNLOGO),
  };
  const ruleResults = Object.fromEntries(
    Object.entries(metas).map(([id, m]) => [
      id,
      {
        meta: m,
        checks: [
          {
            name: id.split("/")[1]!,
            status: "pass" as const,
            message: "ok",
            pageUrl: CRAWLED,
          },
        ],
      },
    ])
  );
  // A per-page backdrop so the density threshold is crossed, as in the #2256 tests.
  const backdrop = Array.from({ length: 12 }, (_, i) =>
    row(`${SITE}/b${i}`, BACKDROP, "fail", false)
  );
  const pages: Array<{ url: string; rows: PageFindingRecord[] }> = [
    ...backdrop.map((r) => ({ url: r.normalizedUrl, rows: [r] })),
    ...UNTOUCHED.map((url) => ({
      url,
      rows: [
        row(url, LOGO, "fail", opts.component),
        row(url, ADVISORY, "warn", opts.component),
        row(url, WARNLOGO, "warn", opts.component),
      ],
    })),
  ];
  const fold = createCompleteStoreTallyFold({
    ruleResults: ruleResults as never,
    crawledUrls: new Set([CRAWLED]),
    carriedPageUrls: new Set(pages.map((p) => p.url)),
    ruleMetaIndex: new Map(Object.entries(metas)),
    ...(opts.viaAggregate ? { requireAggregatableCarried: true } : {}),
  });
  const carriedOf = (rows: PageFindingRecord[]) =>
    rows.map((r) => untouchedCarriedFinding(r, false));
  if (opts.viaAggregate) {
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
  const tallies = fold.finish();
  const score = calculateHealthScoreFromTallies(
    tallies,
    new Map(Object.entries(ruleResults)) as never
  );
  return { score, tallies };
}

describe("untouched aggregate keeps shared-component units (#2301)", () => {
  test("aggregate and full fold agree on overall and shared units", () => {
    const full = build({ component: true, viaAggregate: false });
    const agg = build({ component: true, viaAggregate: true });
    expect(full.tallies.get(WARNLOGO)!.tally.sharedWarnUnits).toBe(25);
    expect(agg.tallies.get(WARNLOGO)!.tally.sharedWarnUnits).toBe(25);
    expect(full.score.debug?.sharedComponentUnits).toBeGreaterThan(0);
    expect(agg.score.debug?.sharedComponentUnits).toBe(
      full.score.debug?.sharedComponentUnits
    );
    expect(agg.score.debug?.issueDensityShared).toBe(
      full.score.debug?.issueDensityShared
    );
    expect(agg.score.overall).toBe(full.score.overall);
    expect(JSON.stringify(agg.score)).toBe(JSON.stringify(full.score));
  });

  test("advisory rule: the warn half is dropped from the shared units too", () => {
    const agg = build({ component: true, viaAggregate: true });
    const advisory = agg.tallies.get(ADVISORY)!.tally;
    expect(advisory.warnUnits).toBe(0);
    expect(advisory.sharedWarnUnits ?? 0).toBe(0);
    const full = build({ component: true, viaAggregate: false });
    expect(JSON.stringify([...agg.tallies])).toBe(
      JSON.stringify([...full.tallies])
    );
  });

  test("no component findings: the aggregate carries no shared fields and scores as the full fold", () => {
    const { aggregate } = aggregateUntouchedCarried(
      UNTOUCHED.map((url) => ({
        normalizedUrl: url,
        rows: [row(url, LOGO, "fail", false)],
        rendered: true,
        active: true,
      }))
    );
    for (const r of aggregate.rules) {
      expect("sharedWarnUnits" in r).toBe(false);
      expect("sharedFailUnits" in r).toBe(false);
    }
    const full = build({ component: false, viaAggregate: false });
    const agg = build({ component: false, viaAggregate: true });
    expect(full.score.debug?.sharedComponentUnits).toBeUndefined();
    expect(JSON.stringify(agg.score)).toBe(JSON.stringify(full.score));
    expect(JSON.stringify([...agg.tallies])).toBe(
      JSON.stringify([...full.tallies])
    );
  });
});
