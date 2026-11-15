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
  rows: Array<{ page: string; rule: string; check: string }>,
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
    const fromPage = grouped.byPage.get("https://e.test/a")!.find((c) => c.name === "ttfb");
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

  test("parity holds under an index that reorders the ties (#1920)", async () => {
    // The version of this that read once ORDER BY id and grouped passed every
    // other test here, because on today's schema both original queries happen to
    // return their ties in id order. Add an index that makes the per-rule query
    // walk in page_url order and the two disagree: a, m, z against z, a, m. That
    // is the emitted issue order, so it has to come from SQLite rather than from
    // an assumption about ties.
    const store = await storeWith([
      { page: "https://e.test/z", rule: "seo/title", check: "title-present" },
      { page: "https://e.test/a", rule: "seo/title", check: "title-present" },
      { page: "https://e.test/m", rule: "seo/title", check: "title-present" },
    ]);
    // Reaching into the connection deliberately: the point is a DIFFERENT query
    // plan from the one the schema gives today.
    (store as unknown as { getDb(): { exec(sql: string): void } })
      .getDb()
      .exec(
        "CREATE INDEX IF NOT EXISTS idx_rr_probe ON rule_results (crawl_id, rule_id, page_url)",
      );

    const byRuleId = await run(store.getRuleResultsByRuleId("crawl-1"));
    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));

    expect(grouped.byRuleId.get("seo/title")?.map((c) => c.pageUrl)).toEqual(
      byRuleId.get("seo/title")!.map((c) => c.pageUrl),
    );
    expect(grouped.byRuleId).toEqual(byRuleId);

    const byPage = await run(store.getRuleResultsByPage("crawl-1"));
    expect([...grouped.byPage.keys()]).toEqual([...byPage.keys()]);
    expect(grouped.byPage).toEqual(byPage);
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
      ]),
    );

    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));
    expect(grouped.byPage.has("https://e.test/z")).toBe(false);
    for (const checks of grouped.byRuleId.values()) {
      for (const check of checks) expect(check.message).not.toBe("other crawl");
    }
  });
});

describe("getRuleResultsGrouped compact build (#1920)", () => {
  async function richStore(): Promise<SQLiteStorage> {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const save = (page: string, rule: string, checks: CheckResult[]) =>
      run(store.saveRuleResults("crawl-1", page, rule, checks));
    for (const page of ["https://e.test/a", "https://e.test/b"]) {
      await save(page, "seo/title", [
        { name: "t", status: "pass", message: "ok" },
        { name: "t2", status: "warn", message: "short", value: 0, expected: "30+" },
        { name: "t3", status: "fail", message: "empty", value: "", expected: 60 },
        {
          name: "t4",
          status: "info",
          message: "shared message",
          items: [{ id: "x" }],
          details: { a: 1 },
          pages: ["https://e.test/a"],
        },
        { name: "t5", status: "skipped", message: "n/a", skipReason: "not applicable" },
      ]);
    }
    await save("", "crawl/sitemap-exists", [
      { name: "sitemap", status: "fail", message: "missing", value: 3 },
    ]);
    await save("https://e.test/a", "components/x", [
      {
        name: "c",
        status: "warn",
        message: "evidence",
        componentOccurrences: [
          {
            version: 1,
            pageUrl: "https://e.test/a",
            siteOrigin: "https://e.test",
            provenance: { source: "page-dom", rendered: false },
            groupable: true,
            confidence: "observed",
            region: { role: "footer", nestedIn: "none", structuralSignature: "r" },
            family: { key: "f", structuralSignature: "f" },
            variant: { key: "v", structuralSignature: "v", contentHash: "c" },
            element: { locator: "footer:1>footer>p:1", structuralSignature: "e" },
            defect: { kind: "stale-copyright", values: { year: 2019 }, valueHashes: { year: "h" } },
          },
        ],
        componentEvidence: { state: "omitted", reason: "page-sample-limit", occurrenceCount: 4 },
      },
    ]);
    return store;
  }

  test("JSON output is byte-identical to the readers it replaces", async () => {
    const store = await richStore();
    const byPage = await run(store.getRuleResultsByPage("crawl-1"));
    const byRuleId = await run(store.getRuleResultsByRuleId("crawl-1"));
    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));
    expect(JSON.stringify([...grouped.byPage])).toBe(JSON.stringify([...byPage]));
    expect(JSON.stringify([...grouped.byRuleId])).toBe(JSON.stringify([...byRuleId]));
  });

  test("checks carry no explicitly undefined keys, and keep value 0 and ''", async () => {
    const store = await richStore();
    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));
    let seen = 0;
    for (const checks of grouped.byPage.values()) {
      for (const check of checks) {
        seen++;
        expect(Object.values(check).every((v) => v !== undefined)).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
    const t = grouped.byPage.get("https://e.test/a")!;
    // The value column stores text, so 0 reads back as "0" (same as before).
    expect(t.find((c) => c.name === "t2")!.value).toBe("0");
    expect(t.find((c) => c.name === "t3")!.value).toBe("");
    expect("skipReason" in t.find((c) => c.name === "t")!).toBe(false);
  });

  test("equal JSON columns on different rows are distinct objects", async () => {
    const store = await richStore();
    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));
    const a = grouped.byPage.get("https://e.test/a")!.find((c) => c.name === "t4")!;
    const b = grouped.byPage.get("https://e.test/b")!.find((c) => c.name === "t4")!;
    expect(a.items).toEqual(b.items);
    expect(a.items).not.toBe(b.items);
    expect(a.details).not.toBe(b.details);
    expect(a.pages).not.toBe(b.pages);
    expect(a.message).toBe(b.message);
  });
});
