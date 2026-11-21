// squirrelscan/repo#1883: grouped stream producer. One line per distinct (rule, check, locator,
// fingerprint) carrying the COMPLETE page list, and an inverse that materializes
// exactly the rows buildStreamFindings would have streamed.

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";

import { findingKey } from "../src/merge-core";
import {
  runCloudSmartAudits,
  type SmartAuditStore,
} from "../src/merge-promise";
import { calculateHealthScoreFromTallies } from "../src/scoring";
import {
  buildGroupedStreamFindings,
  buildSkippedPassCounts,
  buildStreamFindings,
  expandGroupedStreamFinding,
  GROUPED_STREAM_MAX_LINE_CHARS,
  summarizeGroupedStream,
  type GroupedStreamFindingLine,
  type StreamFindingLine,
} from "../src/stream-findings";
import {
  buildDrschollsFixture,
  pageUrl,
  type FixtureRules,
} from "./helpers/grouped-stream-fixture";
import { describeSitePagesContract } from "./helpers/site-pages-contract";

const NOW = 1_700_000_000_000;
const pk = (f: StreamFindingLine) =>
  findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator);
const byPk = (rows: StreamFindingLine[]) =>
  [...rows].sort((a, b) => (pk(a) < pk(b) ? -1 : pk(a) > pk(b) ? 1 : 0));
const expandAll = (lines: GroupedStreamFindingLine[]) =>
  lines.flatMap(expandGroupedStreamFinding);

const meta = (id: string, severity = "warning") => ({
  id,
  name: id,
  description: id,
  category: "content" as const,
  scope: "page" as const,
  severity,
  weight: 10,
});

/** Mixed fixture covering every filter/flatten path buildStreamFindings has. */
function mixedFixture(): FixtureRules {
  const folded: CheckResult = {
    name: "alt",
    status: "fail",
    message: "Missing alt (+2 more pages)",
    pageUrl: pageUrl(0),
    pages: [pageUrl(0), pageUrl(1), pageUrl(2)],
    items: [
      { id: "img-a", label: "A", sourcePages: [pageUrl(0), pageUrl(1)] },
      { id: "img-b", label: "B", sourcePages: [pageUrl(2)] },
    ],
    details: { aggregated: true, occurrences: 3, additional: 4 },
  };
  return {
    "a11y/alt": { meta: meta("a11y/alt"), checks: [folded] },
    "core/multi": {
      meta: meta("core/multi", "error"),
      checks: [
        { name: "one", status: "fail", message: "m1", pageUrl: pageUrl(0) },
        {
          name: "two",
          status: "warn",
          message: "m2",
          value: 3,
          expected: 1,
          pageUrl: pageUrl(0),
        },
        { name: "two", status: "pass", message: "fine", pageUrl: pageUrl(1) },
        { name: "one", status: "fail", message: "m1", pageUrl: pageUrl(1) },
        {
          name: "items",
          status: "warn",
          message: "2 bad",
          value: 2,
          pageUrl: pageUrl(1),
          items: [
            { id: "x", label: "X" },
            { id: "y", label: "Y" },
          ],
        },
        {
          name: "items",
          status: "warn",
          message: "1 bad",
          value: 1,
          pageUrl: pageUrl(2),
          items: [{ id: "x", label: "X" }],
        },
      ],
    },
    // PK collision: same page+check+locator twice with different message/status.
    "core/collide": {
      meta: meta("core/collide"),
      checks: [
        { name: "c", status: "fail", message: "first", pageUrl: pageUrl(0) },
        {
          name: "c",
          status: "warn",
          message: "last",
          pageUrl: `${pageUrl(0)}#frag`,
        },
        {
          name: "c",
          status: "fail",
          message: "other page",
          pageUrl: pageUrl(1),
        },
      ],
    },
    "core/provenance": {
      meta: meta("core/provenance"),
      checks: [
        {
          name: "c",
          status: "fail",
          message: "carried",
          pageUrl: pageUrl(0),
          provenance: "carried",
        },
        {
          name: "c",
          status: "fail",
          message: "unr",
          pageUrl: pageUrl(1),
          provenance: "unrendered",
        },
        { name: "c", status: "fail", message: "fresh", pageUrl: pageUrl(2) },
      ],
    },
    "core/site": {
      meta: meta("core/site"),
      checks: [
        { name: "robots", status: "fail", message: "site scope, no pageUrl" },
      ],
    },
  };
}

describe("grouped stream round-trip", () => {
  test("expand(grouped) equals buildStreamFindings on a mixed fixture", () => {
    const rules = mixedFixture();
    const expected = byPk(buildStreamFindings(rules, NOW));
    expect(expected.length).toBeGreaterThan(5);
    // Provenance/site filtering held: nothing from the skipped checks.
    expect(
      expected.some((f) => f.message === "carried" || f.message === "unr")
    ).toBe(false);
    expect(expected.some((f) => f.ruleId === "core/site")).toBe(false);
    expect(byPk(expandAll(buildGroupedStreamFindings(rules, NOW)))).toEqual(
      expected
    );
  });

  test("round-trip holds when every group is split into parts", () => {
    const rules = mixedFixture();
    const lines = buildGroupedStreamFindings(rules, NOW, { maxLineChars: 1 });
    expect(byPk(expandAll(lines))).toEqual(
      byPk(buildStreamFindings(rules, NOW))
    );
  });

  test("round-trip on the drscholls-shaped fixture", () => {
    const rules = buildDrschollsFixture();
    expect(byPk(expandAll(buildGroupedStreamFindings(rules, NOW)))).toEqual(
      byPk(buildStreamFindings(rules, NOW))
    );
  });

  test("buildSkippedPassCounts is unchanged by the new producer", () => {
    const rules = mixedFixture();
    const before = JSON.stringify(buildSkippedPassCounts(rules));
    buildGroupedStreamFindings(rules, NOW);
    expect(JSON.stringify(buildSkippedPassCounts(rules))).toBe(before);
    expect(buildSkippedPassCounts(rules)["core/multi"]).toEqual({ two: 1 });
  });
});

describe("grouped stream collapse", () => {
  test("drscholls-shaped: 401 pages, 28,733 rows collapse to 2,479 lines", () => {
    const rules = buildDrschollsFixture(401);
    const perPage = buildStreamFindings(rules, NOW);
    const lines = buildGroupedStreamFindings(rules, NOW);
    const summary = summarizeGroupedStream(lines);
    // Sized to the prod measurement (28,829 rows, 2,606 distinct groups). Measured
    // here: 28,733 per-page lines (16.6 MB NDJSON) vs 2,479 grouped lines (2.1 MB).
    expect(perPage.length).toBe(28_733);
    expect(summary.lines).toBe(2_479);
    expect(summary.rows).toBe(perPage.length);
    expect(summary.lines).toBeLessThan(3000);
    expect(summary.lines).toBe(lines.length);
  });

  test("one line per distinct (rule, check, locator, fingerprint) when nothing splits", () => {
    const rules = buildDrschollsFixture(60);
    const lines = buildGroupedStreamFindings(rules, NOW);
    const distinct = new Set(
      buildStreamFindings(rules, NOW).map((f) =>
        JSON.stringify([f.ruleId, f.checkName, f.locator, f.fingerprint])
      )
    );
    expect(lines.length).toBe(distinct.size);
    expect(lines.every((l) => l.part === 0 && l.parts === 1)).toBe(true);
    expect(new Set(lines.map((l) => l.pages.length)).size).toBeGreaterThan(1);
  });

  test("pages are sorted by URL and payloads are deduped", () => {
    const lines = buildGroupedStreamFindings(buildDrschollsFixture(30), NOW);
    for (const l of lines) {
      const urls = l.pages.map(([u]) => u);
      expect(urls).toEqual([...urls].sort());
      expect(new Set(l.payloads).size).toBe(l.payloads.length);
      expect(l.pages.every(([, i]) => i >= 0 && i < l.payloads.length)).toBe(
        true
      );
    }
  });

  test("default budget is 128 KiB", () => {
    expect(GROUPED_STREAM_MAX_LINE_CHARS).toBe(131072);
  });
});

describe("grouped stream chunking", () => {
  const wide = (pages: number): FixtureRules => ({
    "core/wide": {
      meta: meta("core/wide"),
      checks: Array.from({ length: pages }, (_, i) => ({
        name: "c",
        status: "fail" as const,
        message: "same everywhere",
        pageUrl: `https://x.test/some/longer/path/segment/${i}`,
      })),
    },
  });

  test("a wide group splits into parts within budget, losing no page", () => {
    const budget = 2000;
    const rules = wide(500);
    const lines = buildGroupedStreamFindings(rules, NOW, {
      maxLineChars: budget,
    });
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines)
      expect(JSON.stringify(l).length).toBeLessThanOrEqual(budget);
    const all = lines.flatMap((l) => l.pages.map(([u]) => u));
    expect(all.length).toBe(500);
    expect(new Set(all).size).toBe(500);
    lines.forEach((l, i) => {
      expect(l.part).toBe(i);
      expect(l.parts).toBe(lines.length);
    });
    // Parts concatenate in URL order.
    expect(all).toEqual([...all].sort());
  });

  test("each part carries only the payloads it references, re-indexed", () => {
    const rules = buildDrschollsFixture(80);
    const lines = buildGroupedStreamFindings(rules, NOW, {
      maxLineChars: 3000,
    });
    expect(lines.some((l) => l.parts > 1)).toBe(true);
    for (const l of lines) {
      const used = new Set(l.pages.map(([, i]) => i));
      expect(used.size).toBe(l.payloads.length);
    }
  });

  test("a single page over budget still gets its own part", () => {
    const rules = wide(3);
    const lines = buildGroupedStreamFindings(rules, NOW, { maxLineChars: 10 });
    expect(lines.length).toBe(3);
    expect(lines.every((l) => l.pages.length === 1 && l.parts === 3)).toBe(
      true
    );
    expect(JSON.stringify(lines[0]).length).toBeGreaterThan(10);
  });
});

describe("grouped stream gate", () => {
  test("rows equals distinct PKs, and dropping any line leaves rows short", () => {
    const rules = buildDrschollsFixture(40);
    const lines = buildGroupedStreamFindings(rules, NOW, { maxLineChars: 700 });
    const { rows } = summarizeGroupedStream(lines);
    const pks = new Set(buildStreamFindings(rules, NOW).map(pk));
    expect(rows).toBe(pks.size);
    expect(lines.some((l) => l.parts > 1)).toBe(true);
    for (let drop = 0; drop < lines.length; drop++) {
      const received = new Set(
        lines
          .filter((_, i) => i !== drop)
          .flatMap((l) => expandGroupedStreamFinding(l).map(pk))
      );
      expect(received.size).toBeLessThan(rows);
    }
  });
});

// Minimal store: runCloudSmartAudits only needs findings + pages in memory here.
// Its upsertSitePages is a keyed upsert and runs the shared contract below (#497).
class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();
  async getFindings(_s: string, states?: FindingState[]) {
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages(): Promise<SitePageRecord[]> {
    return [...this.pages.values()];
  }
  async upsertFindings(rows: PageFindingRecord[]) {
    for (const f of rows) {
      this.findings.set(
        findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator),
        f
      );
    }
  }
  async upsertSitePages(pages: SitePageRecord[]): Promise<void> {
    for (const p of pages) this.pages.set(p.normalizedUrl, { ...p });
  }
  async markPageRemoved() {}
  async markPagesRemoved() {}
  async compactFindings() {
    return 0;
  }
}

describeSitePagesContract(
  "grouped-stream-findings-1883.test.ts MemStore",
  () => new MemStore()
);

describe("grouped stream score parity", () => {
  test("grouped-materialized rows score identically to per-page rows", async () => {
    const rules = buildDrschollsFixture(120);
    const crawled = Array.from({ length: 120 }, (_, i) => pageUrl(i));
    const score = async (rows: StreamFindingLine[]) => {
      const byPage = new Map<string, PageFindingRecord[]>();
      for (const r of byPk(rows)) {
        const rec: PageFindingRecord = {
          ...r,
          siteKey: "web",
          lastSeenCrawlId: "audit_1",
        };
        const arr = byPage.get(r.normalizedUrl);
        if (arr) arr.push(rec);
        else byPage.set(r.normalizedUrl, [rec]);
      }
      const result = await runCloudSmartAudits({
        store: new MemStore(),
        siteKey: "web",
        crawlId: "audit_1",
        ruleResults: Object.fromEntries(
          Object.entries(rules).map(([id, r]) => [
            id,
            { meta: r.meta, checks: [] },
          ])
        ) as never,
        pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
        completeStore: {
          findingPages: (async function* () {
            for (const page of byPage.values()) yield page;
          })(),
          priorOpenFindings: [],
          crawledUrls: crawled,
          skippedPassCounts: buildSkippedPassCounts(rules),
        },
      });
      return calculateHealthScoreFromTallies(
        result.scoringTallies!,
        result.unionRuleResults
      );
    };
    const perPage = await score(buildStreamFindings(rules, NOW));
    const grouped = await score(
      expandAll(buildGroupedStreamFindings(rules, NOW))
    );
    expect(grouped).toEqual(perPage);
  });
});
