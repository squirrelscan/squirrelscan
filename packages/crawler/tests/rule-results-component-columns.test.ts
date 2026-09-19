// #2307: the two component-evidence columns on `rule_results` must survive the
// two failure modes this file's history says ALTER-added columns actually hit.
//
// 1. A store recorded at the current version but MISSING the column, from a
//    migration-number collision between a beta and a release. It has bitten
//    `pages`, `sitemaps`, `robots_txt`, `links` and `crawls` in turn, so the
//    columns are in RULE_RESULTS_ALTER_COLUMNS and `reconcileColumns` re-adds
//    them on open regardless of the version counter. Here the store is stamped
//    at the current version with the columns dropped, exactly as that collision
//    leaves it.
// 2. An OLDER binary opening a NEWER store. The migration runner is gated on
//    `currentVersion < SCHEMA_VERSION`, so a store stamped ABOVE the binary's
//    version skips migrations entirely rather than refusing or throwing — the
//    same branch an old CLI takes against a v30 store. Pinned here as behaviour,
//    not changed.

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

const EVIDENCE: NonNullable<CheckResult["componentOccurrences"]> = [
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
];

function check(): CheckResult {
  return {
    name: "footer-copyright-year",
    status: "warn",
    message: "Footer copyright year is 2019",
    componentOccurrences: EVIDENCE,
    componentEvidence: { state: "omitted", reason: "page-sample-limit", occurrenceCount: 4 },
  };
}

function tempDbPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "sq-2307-db-"));
  return { dir, file: join(dir, "store.db") };
}

describe("rule_results component-evidence columns", () => {
  test("round-trip through the store preserves both fields", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await run(store.saveRuleResults("crawl-1", "https://e.test/a", "content/stale-copyright", [check()]));

    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));
    const stored = grouped.byRuleId.get("content/stale-copyright")![0]!;
    expect(stored.componentOccurrences).toEqual(EVIDENCE);
    expect(stored.componentEvidence).toEqual({
      state: "omitted",
      reason: "page-sample-limit",
      occurrenceCount: 4,
    });
  });

  test("a check with no evidence reads back undefined, not an empty array", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await run(
      store.saveRuleResults("crawl-1", "https://e.test/a", "seo/title", [
        { name: "title-present", status: "pass", message: "ok" },
      ]),
    );
    const grouped = await run(store.getRuleResultsGrouped("crawl-1"));
    const stored = grouped.byRuleId.get("seo/title")![0]!;
    // "No evidence recorded" must stay distinguishable from "evidence found none".
    expect(stored.componentOccurrences).toBeUndefined();
    expect(stored.componentEvidence).toBeUndefined();
  });

  test("a store at the current version but missing the columns self-heals on open", async () => {
    const { dir, file } = tempDbPath();
    try {
      // Build a real store, then reproduce the collision: drop the two columns
      // while leaving the version counter claiming they are present.
      const seed = new SQLiteStorage(file);
      await run(seed.init());
      await run(seed.close?.() ?? Effect.void);

      const raw = new Database(file);
      raw.exec("ALTER TABLE rule_results DROP COLUMN component_occurrences");
      raw.exec("ALTER TABLE rule_results DROP COLUMN component_evidence");
      const version = (
        raw.prepare("SELECT version FROM schema_version").get() as { version: number }
      ).version;
      expect(version).toBe(SCHEMA_VERSION);
      const columns = (
        raw.prepare("PRAGMA table_info(rule_results)").all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).not.toContain("component_occurrences");
      raw.close();

      // Opening must re-add them rather than throwing on every write forever.
      const reopened = new SQLiteStorage(file);
      await run(reopened.init());
      await run(
        reopened.saveRuleResults("crawl-1", "https://e.test/a", "content/stale-copyright", [check()]),
      );
      const grouped = await run(reopened.getRuleResultsGrouped("crawl-1"));
      expect(grouped.byRuleId.get("content/stale-copyright")![0]!.componentOccurrences).toEqual(
        EVIDENCE,
      );
      await run(reopened.close?.() ?? Effect.void);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store stamped ABOVE this binary's version opens and works, it does not refuse", async () => {
    const { dir, file } = tempDbPath();
    try {
      const seed = new SQLiteStorage(file);
      await run(seed.init());
      await run(seed.close?.() ?? Effect.void);

      // What an older CLI sees when it opens a store a newer CLI wrote: the
      // migration loop is `currentVersion < SCHEMA_VERSION`, so it runs nothing.
      const raw = new Database(file);
      raw.exec("DELETE FROM schema_version");
      raw.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION + 5);
      raw.close();

      const reopened = new SQLiteStorage(file);
      await run(reopened.init());
      await run(
        reopened.saveRuleResults("crawl-1", "https://e.test/a", "content/stale-copyright", [check()]),
      );
      const grouped = await run(reopened.getRuleResultsGrouped("crawl-1"));
      expect(grouped.byRuleId.get("content/stale-copyright")![0]!.componentOccurrences).toEqual(
        EVIDENCE,
      );
      // The version it claimed is left alone: nothing downgrades the counter.
      const raw2 = new Database(file);
      expect(
        (raw2.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
      ).toBe(SCHEMA_VERSION + 5);
      raw2.close();
      await run(reopened.close?.() ?? Effect.void);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
