// An image's natural size and animation in the resource store (#470).
//
// The image pool reads them from each image's header, images/responsive-size
// measures oversizing with them, and a cache hit on the next audit has to hand
// them back, or the rule falls back to its byte budget on every warm run. Both
// upgrade routes are covered: the migration (a DB at version 31) and the
// reconcile (a DB stamped at the current version without the columns, the
// version-collision case that has bitten six other tables).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type { ResourceSizeRecord } from "@squirrelscan/core-contracts";

import { SCHEMA_VERSION, SQLiteStorage } from "../src/storage/sqlite";
import type { CrawlMetadata } from "../src/storage/types";

const STATS = {
  pagesTotal: 0,
  pagesFetched: 0,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

const crawlMeta = (startedAt: number): Omit<CrawlMetadata, "id"> => ({
  baseUrl: "http://x.test",
  startedAt,
  status: "completed",
  config: {} as CrawlMetadata["config"],
  stats: STATS,
});

const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e);

function image(path: string, overrides: Partial<ResourceSizeRecord> = {}): ResourceSizeRecord {
  return {
    type: "image",
    url: `http://x.test/${path}`,
    status: 206,
    error: null,
    contentType: "image/jpeg",
    sizeBytes: 20_480,
    sourcePages: ["http://x.test/"],
    cacheControl: "public, max-age=86400",
    ...overrides,
  };
}

const RECORDS: ResourceSizeRecord[] = [
  image("photo.jpg", { naturalWidth: 1200, naturalHeight: 1200, animated: false }),
  image("spin.webp", { contentType: "image/webp", naturalWidth: 100, naturalHeight: 100, animated: true }),
  image("exif.jpg", { naturalWidth: null, naturalHeight: null, animated: null }),
  { type: "css", url: "http://x.test/app.css", status: 200, error: null, contentType: "text/css", sizeBytes: 900, sourcePages: [] },
];

function header(record: { naturalWidth?: number | null; naturalHeight?: number | null; animated?: boolean | null }) {
  return [record.naturalWidth, record.naturalHeight, record.animated];
}

describe("natural size in resource_sizes (#470)", () => {
  test("round-trips, and a later crawl's cache lookup hands it back", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "squirrelscan-rs-")), "store.sqlite");
    const storage = new SQLiteStorage(path);
    try {
      await run(storage.init());
      const first = await run(storage.createCrawl(crawlMeta(1_000)));
      await run(storage.saveResourceSizes(first, RECORDS));

      const stored = await run(storage.getResourceSizes(first));
      const byUrl = new Map(stored.map((r) => [r.url, r]));
      expect(header(byUrl.get("http://x.test/photo.jpg")!)).toEqual([1200, 1200, false]);
      expect(header(byUrl.get("http://x.test/spin.webp")!)).toEqual([100, 100, true]);
      expect(header(byUrl.get("http://x.test/exif.jpg")!)).toEqual([null, null, null]);
      expect(header(byUrl.get("http://x.test/app.css")!)).toEqual([null, null, null]);

      // What the resource checker reuses on the next audit.
      const second = await run(storage.createCrawl(crawlMeta(2_000)));
      const cached = new Map((await run(storage.getCachedResources(second))).map((r) => [r.url, r]));
      expect(header(cached.get("http://x.test/photo.jpg")!)).toEqual([1200, 1200, false]);
      expect(header(cached.get("http://x.test/spin.webp")!)).toEqual([100, 100, true]);
    } finally {
      await run(storage.close());
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  async function storeWithoutHeaderColumns(version: number): Promise<{ path: string; crawlId: string }> {
    const path = join(mkdtempSync(join(tmpdir(), "squirrelscan-rs-")), "store.sqlite");
    const storage = new SQLiteStorage(path);
    await run(storage.init());
    const crawlId = await run(storage.createCrawl(crawlMeta(1_000)));
    await run(storage.close());
    // Rewind the table to its pre-#470 shape, with one row the old code wrote.
    const db = new Database(path);
    db.exec("ALTER TABLE resource_sizes DROP COLUMN natural_width");
    db.exec("ALTER TABLE resource_sizes DROP COLUMN natural_height");
    db.exec("ALTER TABLE resource_sizes DROP COLUMN animated");
    db.prepare(
      "INSERT INTO resource_sizes (crawl_id, type, url, status, error, content_type, size_bytes, source_pages) VALUES (?, 'image', ?, 200, NULL, 'image/jpeg', 20480, '[]')"
    ).run(crawlId, "http://x.test/old.jpg");
    db.exec("DELETE FROM schema_version");
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
    db.close();
    return { path, crawlId };
  }

  for (const [label, version] of [
    ["migrated from version 31", 31],
    ["stamped current without the columns", SCHEMA_VERSION],
  ] as const) {
    test(`${label}: the old row reads as unknown, and a new write stores the size`, async () => {
      const { path, crawlId } = await storeWithoutHeaderColumns(version);
      const storage = new SQLiteStorage(path);
      try {
        await run(storage.init());
        const before = await run(storage.getResourceSizes(crawlId));
        expect(before).toHaveLength(1);
        expect(header(before[0]!)).toEqual([null, null, null]);

        // The write is what fails loudly on a missing column.
        await run(storage.saveResourceSizes(crawlId, RECORDS));
        const after = new Map((await run(storage.getResourceSizes(crawlId))).map((r) => [r.url, r]));
        expect(header(after.get("http://x.test/photo.jpg")!)).toEqual([1200, 1200, false]);
        expect(header(after.get("http://x.test/old.jpg")!)).toEqual([null, null, null]);

        const db = new Database(path, { readonly: true });
        const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
        db.close();
        expect(version.version).toBe(SCHEMA_VERSION);
      } finally {
        await run(storage.close());
        rmSync(join(path, ".."), { recursive: true, force: true });
      }
    });
  }
});
