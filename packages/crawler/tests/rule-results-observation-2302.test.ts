// repo#2302: a check's `observation` must survive the SQLite store, because the
// CLI's real JSON report is rebuilt from `rule_results` (reports/reconstruct.ts).
// Without the column every in-memory test passes while `squirrel audit` drops it.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import type { CheckResult } from "../src/storage/types";
import { SCHEMA_VERSION, SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const OBSERVATION: NonNullable<CheckResult["observation"]> = {
  mode: "static",
  applicability: "unknown",
  uncertainty: "Only the initial HTML was inspected.",
};

const RULE = "performance/lcp-hints";
const PAGE = "https://e.test/a";

function observed(): CheckResult {
  return { name: "lcp-hints", status: "info", message: "Not judged", observation: OBSERVATION };
}

function tempDbPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "sq-2302-db-"));
  return { dir, file: join(dir, "store.db") };
}

function columns(raw: Database): string[] {
  return (raw.prepare("PRAGMA table_info(rule_results)").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

describe("rule_results observation column (repo#2302)", () => {
  test("both writers round-trip it through every reader", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await run(store.saveRuleResults("crawl-1", PAGE, RULE, [observed()]));
    await run(
      store.saveRuleResultsBatch("crawl-2", new Map([[PAGE, [{ ruleId: RULE, checks: [observed()] }]]])),
    );

    for (const crawlId of ["crawl-1", "crawl-2"]) {
      const grouped = await run(store.getRuleResultsGrouped(crawlId));
      expect(grouped.byRuleId.get(RULE)![0]!.observation).toEqual(OBSERVATION);
      expect(grouped.byPage.get(PAGE)![0]!.observation).toEqual(OBSERVATION);
      const byPage = await run(store.getRuleResultsByPage(crawlId));
      expect(byPage.get(PAGE)![0]!.observation).toEqual(OBSERVATION);
      const byRule = await run(store.getRuleResultsByRuleId(crawlId));
      expect(byRule.get(RULE)![0]!.observation).toEqual(OBSERVATION);
    }
  });

  test("a check with no observation reads back undefined", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await run(
      store.saveRuleResults("crawl-1", PAGE, "seo/title", [
        { name: "title-present", status: "pass", message: "ok" },
      ]),
    );
    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));
    expect(grouped.byRuleId.get("seo/title")![0]!.observation).toBeUndefined();
  });

  test("a version 41 store gains the column and reaches the current version", async () => {
    const { dir, file } = tempDbPath();
    try {
      const seed = new SQLiteStorage(file);
      await run(seed.init());
      await run(seed.close?.() ?? Effect.void);

      const raw = new Database(file);
      raw.exec("ALTER TABLE rule_results DROP COLUMN observation");
      raw.exec("DELETE FROM schema_version");
      raw.prepare("INSERT INTO schema_version (version) VALUES (?)").run(41);
      raw.close();

      const reopened = new SQLiteStorage(file);
      await run(reopened.init());
      await run(reopened.saveRuleResults("crawl-1", PAGE, RULE, [observed()]));
      const grouped = await run(reopened.getRuleResultsGrouped("crawl-1"));
      expect(grouped.byRuleId.get(RULE)![0]!.observation).toEqual(OBSERVATION);
      await run(reopened.close?.() ?? Effect.void);

      const raw2 = new Database(file);
      expect(SCHEMA_VERSION).toBe(42);
      expect(
        (raw2.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
      ).toBe(SCHEMA_VERSION);
      expect(columns(raw2)).toContain("observation");
      raw2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store at the current version but missing the column self-heals on open", async () => {
    const { dir, file } = tempDbPath();
    try {
      const seed = new SQLiteStorage(file);
      await run(seed.init());
      await run(seed.close?.() ?? Effect.void);

      const raw = new Database(file);
      raw.exec("ALTER TABLE rule_results DROP COLUMN observation");
      expect(columns(raw)).not.toContain("observation");
      raw.close();

      const reopened = new SQLiteStorage(file);
      await run(reopened.init());
      await run(reopened.saveRuleResults("crawl-1", PAGE, RULE, [observed()]));
      const grouped = await run(reopened.getRuleResultsGrouped("crawl-1"));
      expect(grouped.byRuleId.get(RULE)![0]!.observation).toEqual(OBSERVATION);
      await run(reopened.close?.() ?? Effect.void);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
