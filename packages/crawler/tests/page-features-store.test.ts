// page_features accumulator + SiteQuery read API (#1022, PR-A).
// Covers schema creation, v17→v18 migration on an existing crawl DB, upsert
// idempotency, and each bounded aggregate query against a seeded fixture.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Effect } from "effect";

import type { PageFeatureRow } from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

async function freshStore(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  return store;
}

const CRAWL = "crawl-1";

function feat(over: Partial<PageFeatureRow> = {}): PageFeatureRow {
  return {
    normalizedUrl: "https://example.com/a",
    status: 200,
    depth: 1,
    title: "Title A",
    titleHash: "th-a",
    description: "Desc A",
    descHash: "dh-a",
    contentHash: "ch-a",
    wordCount: 100,
    pageType: "article",
    schemaTypes: ["Article"],
    robotsNoindex: false,
    canonical: "https://example.com/a",
    visibleAuthor: true,
    visibleDate: true,
    transferBytes: 1000,
    templateFp: "tpl-a",
    secretHits: 0,
    metaNoindex: false,
    indexableReasons: [],
    richResultTypes: [],
    ...over,
  };
}

describe("page_features store — round-trip", () => {
  test("upsert single + read round-trips every field (schemaTypes json + boolean flags + nullables)", async () => {
    const store = await freshStore();
    const row = feat({
      normalizedUrl: "https://example.com/x",
      schemaTypes: ["Article", "BreadcrumbList"],
      robotsNoindex: true,
      visibleAuthor: false,
      visibleDate: true,
      wordCount: null,
      transferBytes: null,
      secretHits: null,
      canonical: null,
      title: null,
      titleHash: null,
    });
    await run(store.upsertPageFeatures(CRAWL, row));

    const got = await run(store.getPageFeatures(CRAWL, "https://example.com/x"));
    expect(got).toEqual(row);
    // Explicit checks on the tricky serialized fields.
    expect(got?.schemaTypes).toEqual(["Article", "BreadcrumbList"]);
    expect(got?.robotsNoindex).toBe(true);
    expect(got?.visibleAuthor).toBe(false);
    expect(got?.visibleDate).toBe(true);
    expect(got?.wordCount).toBeNull();
    expect(got?.title).toBeNull();
    await run(store.close());
  });

  test("empty schemaTypes round-trips as []", async () => {
    const store = await freshStore();
    await run(
      store.upsertPageFeatures(CRAWL, feat({ schemaTypes: [] }))
    );
    const got = await run(store.getPageFeatures(CRAWL, feat().normalizedUrl));
    expect(got?.schemaTypes).toEqual([]);
    await run(store.close());
  });

  test("upsert is idempotent on PK (crawl_id, normalized_url) → replace", async () => {
    const store = await freshStore();
    await run(store.upsertPageFeatures(CRAWL, feat({ title: "v1", titleHash: "h1" })));
    await run(store.upsertPageFeatures(CRAWL, feat({ title: "v2", titleHash: "h2" })));
    expect(await run(store.getPageFeaturesCount(CRAWL))).toBe(1);
    const got = await run(store.getPageFeatures(CRAWL, feat().normalizedUrl));
    expect(got?.title).toBe("v2");
    expect(got?.titleHash).toBe("h2");
    await run(store.close());
  });

  test("batch upsert inserts many; empty batch is a no-op", async () => {
    const store = await freshStore();
    await run(
      store.upsertPageFeaturesBatch(CRAWL, [
        feat({ normalizedUrl: "https://example.com/a" }),
        feat({ normalizedUrl: "https://example.com/b" }),
        feat({ normalizedUrl: "https://example.com/c" }),
      ])
    );
    expect(await run(store.getPageFeaturesCount(CRAWL))).toBe(3);
    await run(store.upsertPageFeaturesBatch(CRAWL, []));
    expect(await run(store.getPageFeaturesCount(CRAWL))).toBe(3);
    await run(store.close());
  });

  test("getPageFeatures returns null for a missing url", async () => {
    const store = await freshStore();
    expect(await run(store.getPageFeatures(CRAWL, "https://nope"))).toBeNull();
    await run(store.close());
  });

  test("rows are crawl-scoped (count + reads never bleed across crawls)", async () => {
    const store = await freshStore();
    await run(store.upsertPageFeatures("crawl-1", feat({ normalizedUrl: "u1" })));
    await run(store.upsertPageFeatures("crawl-2", feat({ normalizedUrl: "u2" })));
    expect(await run(store.getPageFeaturesCount("crawl-1"))).toBe(1);
    expect(await run(store.getPageFeaturesCount("crawl-2"))).toBe(1);
    expect(await run(store.getPageFeatures("crawl-1", "u2"))).toBeNull();
    await run(store.close());
  });
});

describe("page_features store — aggregates", () => {
  // Seed: 3 pages share title/desc/content hash "dup", 2 share "dup2", 1 unique.
  async function seedDuplicates(store: SQLiteStorage): Promise<void> {
    const rows: PageFeatureRow[] = [
      feat({ normalizedUrl: "https://example.com/1", title: "Shared", titleHash: "dup", descHash: "dup", contentHash: "dup" }),
      feat({ normalizedUrl: "https://example.com/2", title: "Shared", titleHash: "dup", descHash: "dup", contentHash: "dup" }),
      feat({ normalizedUrl: "https://example.com/3", title: "Shared", titleHash: "dup", descHash: "dup", contentHash: "dup" }),
      feat({ normalizedUrl: "https://example.com/4", title: "Pair", titleHash: "dup2", descHash: "dup2", contentHash: "dup2" }),
      feat({ normalizedUrl: "https://example.com/5", title: "Pair", titleHash: "dup2", descHash: "dup2", contentHash: "dup2" }),
      feat({ normalizedUrl: "https://example.com/6", title: "Unique", titleHash: "uniq", descHash: "uniq", contentHash: "uniq" }),
    ];
    await run(store.upsertPageFeaturesBatch(CRAWL, rows));
  }

  test("duplicateGroups(title) groups by title_hash HAVING count>1, cnt-desc, urls sorted, sample present", async () => {
    const store = await freshStore();
    await seedDuplicates(store);
    const groups = await run(store.getPageFeatureDuplicateGroups(CRAWL, "title"));
    expect(groups.map((g) => g.hash)).toEqual(["dup", "dup2"]); // 3 before 2
    expect(groups[0]).toEqual({
      hash: "dup",
      sample: "Shared",
      urls: ["https://example.com/1", "https://example.com/2", "https://example.com/3"],
      count: 3,
    });
    expect(groups[1].urls).toEqual(["https://example.com/4", "https://example.com/5"]);
    expect(groups[1].count).toBe(2);
    await run(store.close());
  });

  test("duplicateGroups(description) keys on desc_hash", async () => {
    const store = await freshStore();
    await seedDuplicates(store);
    const groups = await run(store.getPageFeatureDuplicateGroups(CRAWL, "description"));
    expect(groups.map((g) => g.hash)).toEqual(["dup", "dup2"]);
    expect(groups[0].sample).toBe("Desc A");
    await run(store.close());
  });

  test("duplicateGroups(content) keys on content_hash with null sample", async () => {
    const store = await freshStore();
    await seedDuplicates(store);
    const groups = await run(store.getPageFeatureDuplicateGroups(CRAWL, "content"));
    expect(groups.map((g) => g.hash)).toEqual(["dup", "dup2"]);
    expect(groups[0].sample).toBeNull();
    expect(groups[0].count).toBe(3);
    await run(store.close());
  });

  test("duplicateGroups ignores null / empty hashes", async () => {
    const store = await freshStore();
    await run(
      store.upsertPageFeaturesBatch(CRAWL, [
        feat({ normalizedUrl: "https://example.com/1", titleHash: null }),
        feat({ normalizedUrl: "https://example.com/2", titleHash: null }),
        feat({ normalizedUrl: "https://example.com/3", titleHash: "" }),
        feat({ normalizedUrl: "https://example.com/4", titleHash: "" }),
      ])
    );
    expect(await run(store.getPageFeatureDuplicateGroups(CRAWL, "title"))).toEqual([]);
    await run(store.close());
  });

  test("duplicateGroups respects maxGroups + maxUrlsPerGroup caps but count stays true", async () => {
    const store = await freshStore();
    // 3 groups of 3 identical-title pages each.
    const rows: PageFeatureRow[] = [];
    for (const g of ["g1", "g2", "g3"]) {
      for (const n of [1, 2, 3]) {
        rows.push(feat({ normalizedUrl: `https://example.com/${g}-${n}`, titleHash: g }));
      }
    }
    await run(store.upsertPageFeaturesBatch(CRAWL, rows));
    const groups = await run(
      store.getPageFeatureDuplicateGroups(CRAWL, "title", { maxGroups: 2, maxUrlsPerGroup: 2 })
    );
    expect(groups.length).toBe(2);
    for (const g of groups) {
      expect(g.urls.length).toBe(2); // capped
      expect(g.count).toBe(3); // true group size preserved
    }
    await run(store.close());
  });

  test("templateClusters groups by template_fp HAVING count>1", async () => {
    const store = await freshStore();
    await run(
      store.upsertPageFeaturesBatch(CRAWL, [
        feat({ normalizedUrl: "https://example.com/1", templateFp: "T" }),
        feat({ normalizedUrl: "https://example.com/2", templateFp: "T" }),
        feat({ normalizedUrl: "https://example.com/3", templateFp: "solo" }),
        feat({ normalizedUrl: "https://example.com/4", templateFp: null }),
      ])
    );
    const clusters = await run(store.getPageFeatureTemplateClusters(CRAWL));
    expect(clusters).toEqual([
      { fp: "T", urls: ["https://example.com/1", "https://example.com/2"], count: 2 },
    ]);
    await run(store.close());
  });

  test("pagesByType returns matching urls sorted; empty for an unknown type", async () => {
    const store = await freshStore();
    await run(
      store.upsertPageFeaturesBatch(CRAWL, [
        feat({ normalizedUrl: "https://example.com/b", pageType: "product" }),
        feat({ normalizedUrl: "https://example.com/a", pageType: "product" }),
        feat({ normalizedUrl: "https://example.com/c", pageType: "article" }),
      ])
    );
    expect(await run(store.getPageFeaturesByType(CRAWL, "product"))).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(await run(store.getPageFeaturesByType(CRAWL, "listing"))).toEqual([]);
    await run(store.close());
  });

  test("sumTransferBytes / sumSecretHits sum across the crawl; null contributes 0", async () => {
    const store = await freshStore();
    await run(
      store.upsertPageFeaturesBatch(CRAWL, [
        feat({ normalizedUrl: "https://example.com/1", transferBytes: 100, secretHits: 1 }),
        feat({ normalizedUrl: "https://example.com/2", transferBytes: 200, secretHits: 2 }),
        feat({ normalizedUrl: "https://example.com/3", transferBytes: null, secretHits: 0 }),
      ])
    );
    expect(await run(store.sumPageFeatureTransferBytes(CRAWL))).toBe(300);
    expect(await run(store.sumPageFeatureSecretHits(CRAWL))).toBe(3);
    await run(store.close());
  });

  test("homepage returns the shallowest page, tie-broken by url", async () => {
    const store = await freshStore();
    await run(
      store.upsertPageFeaturesBatch(CRAWL, [
        feat({ normalizedUrl: "https://example.com/deep", depth: 2 }),
        feat({ normalizedUrl: "https://example.com/z-home", depth: 0 }),
        feat({ normalizedUrl: "https://example.com/a-home", depth: 0 }),
      ])
    );
    const home = await run(store.getHomepageFeature(CRAWL));
    expect(home?.normalizedUrl).toBe("https://example.com/a-home");
    expect(home?.depth).toBe(0);
    await run(store.close());
  });

  test("getPageFeaturesPage keyset cursor paginates in normalized_url order", async () => {
    const store = await freshStore();
    await run(
      store.upsertPageFeaturesBatch(
        CRAWL,
        ["a", "b", "c", "d", "e"].map((s) =>
          feat({ normalizedUrl: `https://example.com/${s}` })
        )
      )
    );
    const page1 = await run(store.getPageFeaturesPage(CRAWL, { limit: 2 }));
    expect(page1.map((r) => r.normalizedUrl)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    const page2 = await run(
      store.getPageFeaturesPage(CRAWL, { after: page1[1].normalizedUrl, limit: 2 })
    );
    expect(page2.map((r) => r.normalizedUrl)).toEqual([
      "https://example.com/c",
      "https://example.com/d",
    ]);
    const page3 = await run(
      store.getPageFeaturesPage(CRAWL, { after: page2[1].normalizedUrl, limit: 2 })
    );
    expect(page3.map((r) => r.normalizedUrl)).toEqual(["https://example.com/e"]);
    const page4 = await run(
      store.getPageFeaturesPage(CRAWL, { after: page3[0].normalizedUrl, limit: 2 })
    );
    expect(page4).toEqual([]);
    await run(store.close());
  });
});

describe("page_features store — empty crawl edge cases", () => {
  test("every aggregate returns an empty/zero/null result on an empty crawl", async () => {
    const store = await freshStore();
    expect(await run(store.getPageFeaturesCount(CRAWL))).toBe(0);
    expect(await run(store.getPageFeatureDuplicateGroups(CRAWL, "title"))).toEqual([]);
    expect(await run(store.getPageFeatureTemplateClusters(CRAWL))).toEqual([]);
    expect(await run(store.getPageFeaturesByType(CRAWL, "article"))).toEqual([]);
    expect(await run(store.sumPageFeatureTransferBytes(CRAWL))).toBe(0);
    expect(await run(store.sumPageFeatureSecretHits(CRAWL))).toBe(0);
    expect(await run(store.getHomepageFeature(CRAWL))).toBeNull();
    expect(await run(store.getPageFeaturesPage(CRAWL))).toEqual([]);
    await run(store.close());
  });
});

// ── Migration: existing ~/.squirrel crawl DBs must gain page_features cleanly ──

const tmpFiles: string[] = [];
function tmpDbPath(): string {
  const p = join(tmpdir(), `squirrel-1022-${randomUUID()}.db`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try {
      unlinkSync(p);
    } catch {
      // ignore missing temp files
    }
  }
});

// Build a pre-page_features (v17) crawl DB: crawls + pages populated, schema
// recorded at 17, NO page_features table.
function buildV17Db(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE crawls (
      id TEXT PRIMARY KEY, base_url TEXT NOT NULL, started_at INTEGER NOT NULL,
      completed_at INTEGER, status TEXT NOT NULL, config TEXT NOT NULL, stats TEXT NOT NULL
    );
    CREATE TABLE pages (
      crawl_id TEXT NOT NULL, url TEXT NOT NULL, normalized_url TEXT NOT NULL,
      final_url TEXT, depth INTEGER NOT NULL, parent_url TEXT, redirect_chain TEXT,
      status INTEGER NOT NULL, content_type TEXT, size_bytes INTEGER NOT NULL,
      load_time_ms INTEGER NOT NULL, ttfb INTEGER, download_time INTEGER,
      fetched_at INTEGER NOT NULL, etag TEXT, last_modified TEXT,
      content_hash TEXT NOT NULL, html TEXT, parsed_data TEXT, headers TEXT NOT NULL,
      security_headers TEXT NOT NULL, request_headers TEXT,
      fetcher_id TEXT, fallback_reason TEXT, source_hash TEXT,
      PRIMARY KEY (crawl_id, normalized_url)
    );
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (17);
    INSERT INTO crawls (id, base_url, started_at, status, config, stats)
      VALUES ('c1', 'https://example.com', 1, 'completed', '{}', '{}');
    INSERT INTO pages (crawl_id, url, normalized_url, depth, status, size_bytes, load_time_ms, fetched_at, content_hash, headers, security_headers)
      VALUES ('c1', 'https://example.com/', 'https://example.com/', 0, 200, 1, 1, 1, 'h', '{}', '{}');
  `);
  legacy.close();
}

describe("page_features migration (v17 → current)", () => {
  test("opening a v17 crawl DB creates page_features, bumps the version, preserves existing pages", async () => {
    const path = tmpDbPath();
    buildV17Db(path);

    // Sanity: the old DB really has no page_features table.
    const before = new Database(path);
    const hadTable = before
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='page_features'")
      .get();
    expect(hadTable).toBeNull();
    before.close();

    const store = new SQLiteStorage(path);
    await run(store.init());

    // Existing crawl data survives the migration.
    expect(await run(store.getPageCount("c1"))).toBe(1);

    // page_features is usable + writable on the migrated DB.
    await run(store.upsertPageFeatures("c1", feat({ normalizedUrl: "https://example.com/x" })));
    const got = await run(store.getPageFeatures("c1", "https://example.com/x"));
    expect(got?.title).toBe("Title A");
    await run(store.close());

    // Version was advanced to the current schema version.
    const check = new Database(path);
    const version = check.prepare("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    };
    expect(version.version).toBe(19);
    const cols = (
      check.prepare("PRAGMA table_info(page_features)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("title_hash");
    expect(cols).toContain("secret_hits");
    // v19 indexability columns present after migration.
    expect(cols).toContain("meta_noindex");
    expect(cols).toContain("indexable_reasons");
    expect(cols).toContain("rich_result_types");
    check.close();
  });
});
