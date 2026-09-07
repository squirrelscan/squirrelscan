// #1920: `getRuleResultsGrouped` reads a crawl's rule results ONCE and hands the
// same CheckResult objects to both groupings, replacing two full reads that
// materialized every row twice.
//
// The whole value depends on it being indistinguishable from the two readers it
// replaces — the per-rule grouping is what the report's `ruleResults` is built
// from, and its check order is visible in the emitted `issues`. So this compares
// the maps element by element, and it also pins the two properties the single
// read relies on: that both `ORDER BY` clauses return their ties in `id` order,
// and that the key order comes from SQLite rather than from a JS sort.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CheckResult } from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

async function storeWith(
  rows: Array<{ page: string; rule: string; check: string }>
): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  for (const row of rows) {
    const check: CheckResult = {
      name: row.check,
      status: "pass",
      message: `${row.rule} on ${row.page || "(site)"}`,
      items: [{ id: `${row.page}#${row.check}` }],
    };
    await run(store.saveRuleResults("crawl-1", row.page, row.rule, [check]));
  }
  return store;
}

/** Rows written in an order that is neither page-sorted nor rule-sorted. */
const ROWS = [
  { page: "https://e.test/c", rule: "seo/title", check: "title-present" },
  { page: "https://e.test/a", rule: "perf/ttfb", check: "ttfb" },
  { page: "https://e.test/c", rule: "perf/ttfb", check: "ttfb" },
  { page: "", rule: "crawl/sitemap-exists", check: "sitemap" },
  { page: "https://e.test/b", rule: "seo/title", check: "title-present" },
  { page: "https://e.test/a", rule: "seo/title", check: "title-present" },
  { page: "https://e.test/b", rule: "a11y/lang", check: "html-lang" },
  { page: "https://e.test/c", rule: "a11y/lang", check: "html-lang" },
];

describe("getRuleResultsGrouped", () => {
  test("both maps match the readers it replaces, key order and check order", async () => {
    const store = await storeWith(ROWS);

    const byPage = await run(store.getRuleResultsByPage("crawl-1"));
    const byRuleId = await run(store.getRuleResultsByRuleId("crawl-1"));
    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));

    // Key order, not just key set: the report iterates these in insertion order.
    expect([...grouped.byPage.keys()]).toEqual([...byPage.keys()]);
    expect([...grouped.byRuleId.keys()]).toEqual([...byRuleId.keys()]);

    // Value-identical, including the order of checks within each key.
    expect(grouped.byPage).toEqual(byPage);
    expect(grouped.byRuleId).toEqual(byRuleId);
  });

  test("the two maps SHARE their check objects rather than copying them", async () => {
    const store = await storeWith(ROWS);
    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));

    // This is the entire point: one allocation per row, referenced twice.
    const fromPage = grouped.byPage.get("https://e.test/a")!.find(
      (c) => c.name === "ttfb"
    );
    const fromRule = grouped.byRuleId
      .get("perf/ttfb")!
      .find((c) => c.pageUrl === "https://e.test/a");
    expect(fromPage).toBeDefined();
    expect(fromRule).toBe(fromPage!);
  });

  test("site-scope rows keep their empty page key", async () => {
    const store = await storeWith(ROWS);
    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));
    const byPage = await run(store.getRuleResultsByPage("crawl-1"));

    // '' is the site-scope convention the report reads as `siteChecks`.
    expect(grouped.byPage.has("")).toBe(true);
    expect(grouped.byPage.get("")).toEqual(byPage.get("")!);
    // pageUrl is undefined rather than "" on those checks.
    expect(grouped.byPage.get("")![0]?.pageUrl).toBeUndefined();
  });

  test("an empty crawl yields two empty maps, not an error", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const grouped = await run(store.getRuleResultsGrouped("nothing-here"));
    expect(grouped.byPage.size).toBe(0);
    expect(grouped.byRuleId.size).toBe(0);
  });

  test("rows of another crawl are not included", async () => {
    const store = await storeWith(ROWS);
    await run(
      store.saveRuleResults("crawl-2", "https://e.test/z", "seo/title", [
        { name: "title-present", status: "fail", message: "other crawl" },
      ])
    );

    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));
    expect(grouped.byPage.has("https://e.test/z")).toBe(false);
    for (const checks of grouped.byRuleId.values()) {
      for (const check of checks) expect(check.message).not.toBe("other crawl");
    }
  });
});
