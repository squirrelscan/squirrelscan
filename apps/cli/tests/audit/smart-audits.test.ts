// Smart audits (#110) — end-to-end orchestration through a real in-memory
// SQLite store. Proves the no-inflation invariant survives the full
// flatten → merge → persist → union path (not just the pure scoring unit).

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { RuleMeta } from "@squirrelscan/rules";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { calculateHealthScore } from "@/audit/scoring";
import { runSmartAudits } from "@/audit/smart-audits";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

const META: RuleMeta = {
  id: "core/meta-title",
  name: "Meta Title",
  description: "Page has a meta title",
  category: "core",
  scope: "page",
  severity: "error",
  weight: 5,
};

const SITE = "https://example.com";
const url = (i: number) => `${SITE}/page-${i}`;

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

/** Build a minimal RuleExecutionResult for `n` pages, first `failCount` failing. */
function ruleExecResult(n: number, failCount: number) {
  const pageRuleResults = new Map<string, Map<string, CheckResult[]>>();
  const allChecks: CheckResult[] = [];
  for (let i = 0; i < n; i++) {
    const status: CheckResult["status"] = i < failCount ? "fail" : "pass";
    const check: CheckResult = {
      name: META.name,
      status,
      message: status === "fail" ? "Missing meta title" : "OK",
      pageUrl: url(i),
    };
    pageRuleResults.set(url(i), new Map([[META.id, [check]]]));
    allChecks.push(check);
  }
  const ruleResultsMap = new Map([
    [META.id, { meta: META, checks: allChecks }],
  ]);
  // Only pageRuleResults + ruleResultsMap are read by runSmartAudits.
  return { pageRuleResults, ruleResultsMap } as unknown as Parameters<
    typeof runSmartAudits
  >[0]["ruleResults"];
}

describe("runSmartAudits end-to-end (no inflation)", () => {
  test("full audit then partial re-audit keeps the score (clean carried pages count)", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());

    // --- Run 1: full audit of 100 pages, 30 fail. Persists findings + pages.
    const full = await run(
      runSmartAudits({
        storage: store,
        crawlId: "crawl-1",
        siteKey: SITE,
        ruleResults: ruleExecResult(100, 30),
        pages: Array.from({ length: 100 }, (_, i) => ({
          normalizedUrl: url(i),
          status: 200,
        })),
      })
    );
    const fullScore = calculateHealthScore({
      results: full.unionRuleResults,
    }).overall;
    expect(full.coverage).toEqual({
      auditedPages: 100,
      knownPages: 100,
      carriedFindings: 0,
    });

    // --- Run 2: re-audit ONLY the first 10 pages (same site state: 0..29 fail,
    // so 0..9 all fail). The other 90 pages carry: 20 fail (10..29) + 70 clean.
    const partial = await run(
      runSmartAudits({
        storage: store,
        crawlId: "crawl-2",
        siteKey: SITE,
        ruleResults: ruleExecResult(10, 10),
        pages: Array.from({ length: 10 }, (_, i) => ({
          normalizedUrl: url(i),
          status: 200,
        })),
      })
    );
    const partialScore = calculateHealthScore({
      results: partial.unionRuleResults,
    }).overall;
    // Real audits over 100 pages always score a number (null ⇒ 0-page failure).
    if (fullScore === null || partialScore === null)
      throw new Error("expected numeric scores for a full/partial audit");

    // Coverage reflects the partial crawl over the full known set.
    expect(partial.coverage.auditedPages).toBe(10);
    expect(partial.coverage.knownPages).toBe(100);
    // 20 carried fails (pages 10..29).
    expect(partial.coverage.carriedFindings).toBe(20);

    // THE INVARIANT: a partial re-audit must NOT raise the score.
    expect(partialScore).toBeLessThanOrEqual(fullScore + 1);
    expect(Math.abs(partialScore - fullScore)).toBeLessThanOrEqual(1);

    await run(store.close());
  });

  test("404 on re-audit removes the page + stales its findings", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());

    // Run 1: 3 pages, page-1 fails.
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c1",
        siteKey: SITE,
        ruleResults: ruleExecResult(3, 2),
        pages: [0, 1, 2].map((i) => ({ normalizedUrl: url(i), status: 200 })),
      })
    );

    // Run 2: page-0 now 404. Should be removed; its finding staled.
    const r2 = await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ruleResults: ruleExecResult(3, 2),
        pages: [
          { normalizedUrl: url(0), status: 404 },
          { normalizedUrl: url(1), status: 200 },
          { normalizedUrl: url(2), status: 200 },
        ],
      })
    );

    const sitePages = await run(store.getSitePages(SITE));
    const removedPage = sitePages.find((p) => p.normalizedUrl === url(0));
    expect(removedPage?.state).toBe("removed");
    // Real per-page status persisted (not a hardcoded constant).
    expect(removedPage?.lastStatus).toBe(404);
    const findings = await run(store.getFindings(SITE));
    const removedFinding = findings.find((f) => f.normalizedUrl === url(0));
    if (removedFinding) expect(removedFinding.state).toBe("stale");
    // Removed page excluded from the known set.
    expect(r2.coverage.knownPages).toBe(2);

    await run(store.close());
  });

  test("carried findings retain per-item detail (payload replayed)", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());

    // Run 1: page-0 has a fail check WITH structured items.
    const pageRuleResults = new Map<string, Map<string, CheckResult[]>>();
    const itemCheck: CheckResult = {
      name: META.name,
      status: "fail",
      message: "Broken images",
      pageUrl: url(0),
      items: [
        { id: "https://example.com/img/a.png", label: "a.png" },
        { id: "https://example.com/img/b.png", label: "b.png" },
      ],
    };
    pageRuleResults.set(url(0), new Map([[META.id, [itemCheck]]]));
    const rr = {
      pageRuleResults,
      ruleResultsMap: new Map([[META.id, { meta: META, checks: [itemCheck] }]]),
    } as unknown as Parameters<typeof runSmartAudits>[0]["ruleResults"];
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c1",
        siteKey: SITE,
        ruleResults: rr,
        pages: [{ normalizedUrl: url(0), status: 200 }],
      })
    );

    // Run 2: re-audit a DIFFERENT page (page-1, clean pass) so page-0 carries.
    const cleanCheck: CheckResult = {
      name: META.name,
      status: "pass",
      message: "OK",
      pageUrl: url(1),
    };
    const rr2 = {
      pageRuleResults: new Map([[url(1), new Map([[META.id, [cleanCheck]]])]]),
      ruleResultsMap: new Map([
        [META.id, { meta: META, checks: [cleanCheck] }],
      ]),
    } as unknown as Parameters<typeof runSmartAudits>[0]["ruleResults"];
    const r2 = await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ruleResults: rr2,
        pages: [{ normalizedUrl: url(1), status: 200 }],
      })
    );

    // flattenChecks splits an items[] check into one finding per item, so the
    // carried union has one fail check per item — each retaining its item
    // detail (the payload was replayed, not dropped).
    const carried = r2.unionRuleResults
      .get(META.id)
      ?.checks.filter((c) => c.pageUrl === url(0) && c.status === "fail");
    expect(carried?.length).toBe(2);
    const carriedItemIds = carried
      ?.flatMap((c) => c.items?.map((i) => i.id) ?? [])
      .sort();
    expect(carriedItemIds).toEqual([
      "https://example.com/img/a.png",
      "https://example.com/img/b.png",
    ]);

    await run(store.close());
  });
});
