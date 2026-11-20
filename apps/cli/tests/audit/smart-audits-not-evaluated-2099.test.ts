// pub#2099: a LOCAL smart re-audit scores a carried page's not-evaluated checks
// as the full audit did. The record rides on the sqlite `site_pages` row
// (`not_evaluated`), so these tests go through a real SQLite store: in memory for
// the tally, on disk for the migration and the older-CLI read and write.

import type { CheckResult, SitePageRecord } from "@squirrelscan/core-contracts";
import type { RuleMeta, RuleRunResult } from "@squirrelscan/rules";

import {
  createNotEvaluatedCollector,
  flattenChecks,
  type RuleTally,
} from "@squirrelscan/audit-engine";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSmartAudits, type SmartAuditResult } from "@/audit/smart-audits";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { joinSmartUnion } from "@/reports/reconstruct";

const TTFB: RuleMeta = {
  id: "perf/ttfb",
  name: "TTFB",
  description: "Time to first byte",
  category: "perf",
  scope: "page",
  severity: "warning",
  weight: 6,
};
const CHECK = "ttfb";
const KEY = `${TTFB.id}|${CHECK}`;
const SITE = "https://example.com";
const url = (i: number) => `${SITE}/page-${i}`;
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);
const RULE_META = new Map<string, RuleTally>([
  [TTFB.id, { meta: TTFB } as RuleTally],
]);

// The engine test's shape (capped-rescore busyShapes): slow on every sixth page,
// no timing data on 11, 22, 33, 44 and 55, fine elsewhere.
const status = (i: number): CheckResult["status"] =>
  i % 6 === 0 ? "warn" : i % 11 === 0 ? "skipped" : "pass";
const SKIPPED = range(0, 60).filter((i) => status(i) === "skipped");
const FULL_PASSES = range(0, 60).filter((i) => status(i) === "pass").length;

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

/** One run over `pages`, split as the controller's page sink splits it. */
function audit(pages: number[]) {
  const collector = createNotEvaluatedCollector((u) => u);
  const freshFindings: ReturnType<typeof flattenChecks> = [];
  const checks: CheckResult[] = [];
  for (const i of pages) {
    const s = status(i);
    const check: CheckResult = {
      name: CHECK,
      status: s,
      message:
        s === "warn"
          ? "Slow TTFB"
          : s === "skipped"
            ? "No timing data"
            : "TTFB ok",
      pageUrl: url(i),
    };
    checks.push(check);
    collector.add(TTFB.id, check, url(i));
    for (const f of flattenChecks(url(i), TTFB.id, [check]))
      freshFindings.push(f);
  }
  return {
    freshFindings,
    scoredPageUrls: pages.map(url),
    ruleMeta: RULE_META,
    notEvaluated: collector.result(),
    pages: pages.map((i) => ({ normalizedUrl: url(i), status: 200 })),
    freshByRule: new Map([[TTFB.id, checks]]),
  };
}

async function smart(store: SQLiteStorage, crawlId: string, pages: number[]) {
  const { freshByRule, ...input } = audit(pages);
  const result = await run(
    runSmartAudits({ storage: store, crawlId, siteKey: SITE, ...input })
  );
  return { result, freshByRule };
}

/** perf/ttfb passes the report's union scores: fresh passes + synthetic carried passes. */
function ttfbPasses(r: {
  result: SmartAuditResult;
  freshByRule: Map<string, CheckResult[]>;
}) {
  const joined =
    new Map(joinSmartUnion(r.freshByRule, r.result)).get(TTFB.id) ?? [];
  const carried: RuleRunResult | undefined = r.result.carriedRuleResults.get(
    TTFB.id
  );
  return (
    joined.filter((c) => c.status === "pass").length +
    (carried?.syntheticPassCount ?? 0)
  );
}

function tempDb(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "sq-2099-db-"));
  return { dir, file: join(dir, "store.db") };
}

const sitePageColumns = (raw: Database): string[] =>
  (
    raw.prepare("PRAGMA table_info(site_pages)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);

const schemaVersion = (raw: Database): number =>
  (
    raw.prepare("SELECT version FROM schema_version").get() as {
      version: number;
    }
  ).version;

/** The version a fresh store is stamped at: the current SCHEMA_VERSION. */
async function freshVersion(dir: string): Promise<number> {
  const file = join(dir, "fresh.db");
  const fresh = new SQLiteStorage(file);
  await run(fresh.init());
  await run(fresh.close());
  const raw = new Database(file);
  const version = schemaVersion(raw);
  raw.close();
  return version;
}

const recordedPages = (pages: SitePageRecord[]): string[] =>
  pages
    .filter((p) => p.notEvaluated?.includes(KEY))
    .map((p) => p.normalizedUrl);

describe("(pub#2099) local smart re-audit: carried not-evaluated checks", () => {
  test("a 3-page re-run tallies perf/ttfb exactly as the full audit", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const full = await smart(store, "crawl-1", range(0, 60));
    expect(ttfbPasses(full)).toBe(FULL_PASSES);
    expect(FULL_PASSES).toBe(45);
    // The store records the skipped pages, and only those.
    const pages = await run(store.getSitePages(SITE));
    expect(recordedPages(pages).sort()).toEqual(SKIPPED.map(url).sort());

    const rerun = await smart(store, "crawl-2", range(0, 3));
    // Before pub#2099 the sqlite store dropped the record: 45 + 5 skipped pages.
    expect(ttfbPasses(rerun)).toBe(FULL_PASSES);
    // The carried rows keep their record across the re-run.
    expect(recordedPages(await run(store.getSitePages(SITE))).sort()).toEqual(
      SKIPPED.map(url).sort()
    );
  });

  test("a re-crawl that evaluates the page clears its record", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await run(
      store.upsertSitePages([
        {
          siteKey: SITE,
          normalizedUrl: url(1),
          lastStatus: 200,
          state: "active",
          lastSeenCrawlId: "crawl-1",
          lastSeenAt: 1,
          notEvaluated: [KEY],
        },
      ])
    );
    expect((await run(store.getSitePages(SITE)))[0]!.notEvaluated).toEqual([
      KEY,
    ]);
    await smart(store, "crawl-2", [1]);
    const [page] = await run(store.getSitePages(SITE));
    expect(page!.lastSeenCrawlId).toBe("crawl-2");
    expect(page!.notEvaluated ?? null).toBeNull();
  });

  test("NULL and malformed cells read as nothing recorded, never a throw", async () => {
    const { dir, file } = tempDb();
    try {
      const store = new SQLiteStorage(file);
      await run(store.init());
      await run(store.close());
      const raw = new Database(file);
      const insert = raw.prepare(
        `INSERT INTO site_pages (site_key, normalized_url, last_status, state,
           last_seen_crawl_id, last_seen_at, not_evaluated) VALUES (?, ?, 200, 'active', 'c', 1, ?)`
      );
      const cells = [
        null,
        "",
        "{not json",
        '"perf/ttfb|ttfb"',
        "[]",
        "[1,2]",
        '{"a":1}',
      ];
      for (const [i, cell] of cells.entries()) insert.run(SITE, url(i), cell);
      insert.run(SITE, url(99), JSON.stringify([KEY]));
      raw.close();

      const reopened = new SQLiteStorage(file);
      await run(reopened.init());
      const pages = await run(reopened.getSitePages(SITE));
      await run(reopened.close());
      const byUrl = new Map(pages.map((p) => [p.normalizedUrl, p]));
      for (const i of cells.keys())
        expect(byUrl.get(url(i))!.notEvaluated ?? null).toBeNull();
      expect(byUrl.get(url(99))!.notEvaluated).toEqual([KEY]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(pub#2099) site_pages.not_evaluated migration", () => {
  /** A store as the CURRENT release writes it: version 48, no column, one full audit. */
  async function v48Store(file: string): Promise<void> {
    const seed = new SQLiteStorage(file);
    await run(seed.init());
    await run(seed.close());
    const raw = new Database(file);
    raw.exec("ALTER TABLE site_pages DROP COLUMN not_evaluated");
    raw.exec("DELETE FROM schema_version");
    raw.prepare("INSERT INTO schema_version (version) VALUES (?)").run(48);
    // Pages as the 48 release's upsertSitePages writes them (named columns, no
    // not_evaluated): a full audit's page set, no findings needed for ttfb passes.
    const write = raw.prepare(
      `INSERT OR REPLACE INTO site_pages (site_key, normalized_url, last_status, state,
         last_seen_crawl_id, last_seen_at) VALUES (?, ?, 200, 'active', 'crawl-1', 1)`
    );
    for (const i of range(0, 60)) write.run(SITE, url(i));
    raw.close();
  }

  test("a store written by the current release opens, migrates and scores as before", async () => {
    const { dir, file } = tempDb();
    try {
      await v48Store(file);
      const store = new SQLiteStorage(file);
      await run(store.init());
      const pages = await run(store.getSitePages(SITE));
      expect(pages).toHaveLength(60);
      expect(pages.every((p) => p.notEvaluated === undefined)).toBe(true);
      // No record yet: every carried page without a row earns its pass, as today.
      const rerun = await smart(store, "crawl-2", range(0, 3));
      expect(ttfbPasses(rerun)).toBe(2 + 57);
      await run(store.close());

      const raw = new Database(file);
      expect(sitePageColumns(raw)).toContain("not_evaluated");
      expect(schemaVersion(raw)).toBe(await freshVersion(dir));
      raw.close();

      // Migrating again is a no-op.
      const again = new SQLiteStorage(file);
      await run(again.init());
      expect(await run(again.getSitePages(SITE))).toHaveLength(60);
      await run(again.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store at the current version but missing the column self-heals on open", async () => {
    const { dir, file } = tempDb();
    try {
      const seed = new SQLiteStorage(file);
      await run(seed.init());
      await run(seed.close());
      const raw = new Database(file);
      raw.exec("ALTER TABLE site_pages DROP COLUMN not_evaluated");
      raw.close();

      const store = new SQLiteStorage(file);
      await run(store.init());
      await smart(store, "crawl-1", range(0, 60));
      expect(recordedPages(await run(store.getSitePages(SITE)))).toHaveLength(
        SKIPPED.length
      );
      await run(store.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an older CLI's site_pages read and write still work on a migrated store", async () => {
    const { dir, file } = tempDb();
    try {
      const store = new SQLiteStorage(file);
      await run(store.init());
      await smart(store, "crawl-1", range(0, 60));
      await run(store.close());

      // The 48 release's statements, verbatim: a named-column INSERT and a
      // `SELECT *` mapped by column NAME (bun:sqlite returns keyed objects).
      const raw = new Database(file);
      raw
        .prepare(
          `INSERT OR REPLACE INTO site_pages (
            site_key, normalized_url, last_status, state, last_seen_crawl_id, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(SITE, url(11), 200, "active", "crawl-old", 2);
      const rows = raw
        .prepare(
          "SELECT * FROM site_pages WHERE site_key = ? ORDER BY normalized_url ASC"
        )
        .all(SITE) as Record<string, unknown>[];
      raw.close();
      expect(rows).toHaveLength(60);
      const old = rows.map((row) => ({
        normalizedUrl: row.normalized_url as string,
        lastStatus: row.last_status as number,
        state: row.state as string,
        lastSeenCrawlId: row.last_seen_crawl_id as string,
      }));
      expect(old.find((p) => p.normalizedUrl === url(11))).toEqual({
        normalizedUrl: url(11),
        lastStatus: 200,
        state: "active",
        lastSeenCrawlId: "crawl-old",
      });

      // The older write replaced the row whole, so its record is gone: the page
      // reads as nothing recorded, never a stale record from an earlier crawl.
      const reopened = new SQLiteStorage(file);
      await run(reopened.init());
      const pages = await run(reopened.getSitePages(SITE));
      await run(reopened.close());
      expect(
        pages.find((p) => p.normalizedUrl === url(11))!.notEvaluated
      ).toBeUndefined();
      expect(recordedPages(pages)).toHaveLength(SKIPPED.length - 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
