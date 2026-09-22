// Smart audits (#110) — end-to-end orchestration through a real in-memory
// SQLite store. Proves the no-inflation invariant survives the full
// flatten → merge → persist → union path (not just the pure scoring unit).
//
// #2343: the fresh half of the union no longer comes back from `runSmartAudits`
// — it is this run's own `rule_results`, which the report reads anyway. These
// tests therefore drive the same join the report does (`joinSmartUnion`) over a
// stand-in for that read, so what they assert is still the union.

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { RuleMeta, RuleRunResult } from "@squirrelscan/rules";

import { flattenChecks, type RuleTally } from "@squirrelscan/audit-engine";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { calculateHealthScore } from "@/audit/scoring";
import { runSmartAudits, type SmartAuditResult } from "@/audit/smart-audits";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { joinSmartUnion } from "@/reports/reconstruct";

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

/** Only `.meta` is read off the tallies; the counts are the fold's business. */
const RULE_META = new Map<string, RuleTally>([
  [META.id, { meta: META } as RuleTally],
]);

interface RunInput {
  freshFindings: ReturnType<typeof flattenChecks>;
  scoredPageUrls: string[];
  ruleMeta: Map<string, RuleTally>;
  /** Stand-in for the `rule_results` rows the report reads back (byRuleId). */
  freshByRule: Map<string, CheckResult[]>;
}

/**
 * One page-rule's output over `n` pages, first `failCount` failing — split the
 * way the rules-phase sink now splits it: findings for the merge, checks for
 * storage. `removed` mirrors the sink's skip of 404/410 pages.
 */
function pageRuleRun(
  n: number,
  failCount: number,
  opts?: { removed?: Set<string>; checks?: (i: number) => CheckResult }
): RunInput {
  const freshFindings: ReturnType<typeof flattenChecks> = [];
  const scoredPageUrls: string[] = [];
  const all: CheckResult[] = [];
  for (let i = 0; i < n; i++) {
    const status: CheckResult["status"] = i < failCount ? "fail" : "pass";
    const check: CheckResult = opts?.checks?.(i) ?? {
      name: META.name,
      status,
      message: status === "fail" ? "Missing meta title" : "OK",
      pageUrl: url(i),
    };
    scoredPageUrls.push(url(i));
    all.push(check);
    if (opts?.removed?.has(url(i))) continue;
    for (const f of flattenChecks(url(i), META.id, [check]))
      freshFindings.push(f);
  }
  return {
    freshFindings,
    scoredPageUrls,
    ruleMeta: RULE_META,
    freshByRule: new Map([[META.id, all]]),
  };
}

/** The union the report builds: this run's checks + the carried half. */
function union(
  input: RunInput,
  result: SmartAuditResult
): Map<string, RuleRunResult> {
  const joined = joinSmartUnion(input.freshByRule, result);
  const out = new Map<string, RuleRunResult>();
  for (const [ruleId, checks] of joined) {
    const carried = result.carriedRuleResults.get(ruleId);
    out.set(ruleId, {
      meta: carried?.meta ?? META,
      checks,
      ...(carried?.syntheticPassCount !== undefined
        ? { syntheticPassCount: carried.syntheticPassCount }
        : {}),
    });
  }
  return out;
}

describe("runSmartAudits end-to-end (no inflation)", () => {
  test("full audit then partial re-audit keeps the score (clean carried pages count)", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());

    // --- Run 1: full audit of 100 pages, 30 fail. Persists findings + pages.
    const fullInput = pageRuleRun(100, 30);
    const full = await run(
      runSmartAudits({
        storage: store,
        crawlId: "crawl-1",
        siteKey: SITE,
        ...fullInput,
        pages: Array.from({ length: 100 }, (_, i) => ({
          normalizedUrl: url(i),
          status: 200,
        })),
      })
    );
    const fullScore = calculateHealthScore({
      results: union(fullInput, full),
    }).overall;
    // (#1652) `unrenderedFindings` is OMITTED, not 0 — a site with none must
    // serialize byte-identically to a pre-#1652 report.
    expect(full.coverage).toEqual({
      auditedPages: 100,
      knownPages: 100,
      carriedFindings: 0,
    });

    // --- Run 2: re-audit ONLY the first 10 pages (same site state: 0..29 fail,
    // so 0..9 all fail). The other 90 pages carry: 20 fail (10..29) + 70 clean.
    const partialInput = pageRuleRun(10, 10);
    const partial = await run(
      runSmartAudits({
        storage: store,
        crawlId: "crawl-2",
        siteKey: SITE,
        ...partialInput,
        pages: Array.from({ length: 10 }, (_, i) => ({
          normalizedUrl: url(i),
          status: 200,
        })),
      })
    );
    const partialScore = calculateHealthScore({
      results: union(partialInput, partial),
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

    // Run 1: 3 pages, page-0 and page-1 fail.
    const first = pageRuleRun(3, 2);
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c1",
        siteKey: SITE,
        ...first,
        pages: [0, 1, 2].map((i) => ({ normalizedUrl: url(i), status: 200 })),
      })
    );

    // Run 2: page-0 now 404. Should be removed; its finding staled.
    const second = pageRuleRun(3, 2, { removed: new Set([url(0)]) });
    const r2 = await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...second,
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
    // …and the join drops its fresh checks from the union, which is the filter
    // `runSmartAudits` used to apply to the in-memory fresh map (#2343).
    expect(r2.removedUrls.has(url(0))).toBe(true);
    const joined = union(second, r2).get(META.id)?.checks ?? [];
    expect(joined.some((c) => c.pageUrl === url(0))).toBe(false);

    await run(store.close());
  });

  test("carried findings retain per-item detail (payload replayed)", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());

    // Run 1: page-0 has a fail check WITH structured items.
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
    const first = pageRuleRun(1, 1, { checks: () => itemCheck });
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c1",
        siteKey: SITE,
        ...first,
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
    const second: RunInput = {
      freshFindings: flattenChecks(url(1), META.id, [cleanCheck]),
      scoredPageUrls: [url(1)],
      ruleMeta: RULE_META,
      freshByRule: new Map([[META.id, [cleanCheck]]]),
    };
    const r2 = await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...second,
        pages: [{ normalizedUrl: url(1), status: 200 }],
      })
    );

    // flattenChecks splits an items[] check into one finding per item, so the
    // carried union has one fail check per item — each retaining its item
    // detail (the payload was replayed, not dropped).
    const carried = union(second, r2)
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
