// The SQL half of the entity map (#2091).
//
// The builder's own tests run on the document; nothing there exercises the
// three tables: the JSON column round-trip, the uncapped (entity, page) list,
// the replace-on-rewrite that keeps `squirrel analyze` from leaving a previous
// run's entities behind, and the retirement that keeps project.db from growing
// a permanent copy of every audit's graph.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { SQLiteStorage } from "../src/storage/sqlite";
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

async function withStorage<T>(
  fn: (s: SQLiteStorage, crawlId: string) => Promise<T>
): Promise<T> {
  const dir = join(mkdtempSync(join(tmpdir(), "squirrelscan-em-")), "store.sqlite");
  const storage = new SQLiteStorage(dir);
  try {
    await run(storage.init());
    const crawlId = await run(storage.createCrawl(crawlMeta(1_000)));
    return await fn(storage, crawlId);
  } finally {
    await run(storage.close());
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
}

const ORG = {
  key: "id:http://x.test/#org",
  id: "http://x.test/#org",
  types: ["Organization", "Brand"],
  name: "Acme",
  properties: { name: "Acme", logo: "http://x.test/a.png", sameAs: ["http://x.test/s"] },
  occurrences: 3,
  conflicts: [
    {
      property: "logo",
      values: [
        { value: "http://x.test/a.png", pages: ["http://x.test/a"], morePages: 0 },
        { value: "http://x.test/b.png", pages: ["http://x.test/b"], morePages: 0 },
      ],
    },
  ],
  danglingRefs: 1,
  pageLocal: false,
};

const CRUMB = {
  key: "syn:BreadcrumbList|name:home",
  id: null,
  types: ["BreadcrumbList"],
  name: null,
  properties: {},
  occurrences: 2,
  conflicts: [],
  danglingRefs: 0,
  pageLocal: true,
};

describe("entity map storage", () => {
  test("round-trips nodes, edges and occurrences", async () => {
    await withStorage(async (storage, crawlId) => {
      await run(
        storage.saveEntityMap(crawlId, {
          nodes: [ORG, CRUMB],
          edges: [
            {
              source: "id:http://x.test/#org",
              predicate: "publisher",
              target: "id:http://x.test/#missing",
              dangling: true,
              occurrences: 3,
            },
            {
              source: "id:http://x.test/#org",
              predicate: "logo",
              target: "syn:BreadcrumbList|name:home",
              dangling: false,
              occurrences: 1,
            },
          ],
          occurrences: [
            { key: "id:http://x.test/#org", normalizedUrl: "http://x.test/a" },
            { key: "id:http://x.test/#org", normalizedUrl: "http://x.test/b" },
            { key: "id:http://x.test/#org", normalizedUrl: "http://x.test/c" },
            { key: "syn:BreadcrumbList|name:home", normalizedUrl: "http://x.test/a" },
          ],
        })
      );

      const rows = await run(storage.getEntityMapRows(crawlId));

      expect(rows.nodes).toHaveLength(2);
      const org = rows.nodes.find((n) => n.key === ORG.key)!;
      expect(org.id).toBe("http://x.test/#org");
      expect(org.types).toEqual(["Organization", "Brand"]);
      expect(org.name).toBe("Acme");
      expect(org.properties.logo).toBe("http://x.test/a.png");
      expect(org.occurrences).toBe(3);
      // page_count is derived from the occurrence rows, not from the document's
      // capped `pages[]`.
      expect(org.pageCount).toBe(3);
      expect(org.conflicts).toHaveLength(1);
      expect(org.danglingRefs).toBe(1);
      expect(org.pageLocal).toBe(false);

      const crumb = rows.nodes.find((n) => n.key === CRUMB.key)!;
      expect(crumb.id).toBeNull();
      expect(crumb.name).toBeNull();
      expect(crumb.pageLocal).toBe(true);
      expect(crumb.pageCount).toBe(1);

      expect(rows.edges).toHaveLength(2);
      const dangling = rows.edges.find((e) => e.dangling)!;
      expect(dangling.predicate).toBe("publisher");
      expect(dangling.target).toBe("id:http://x.test/#missing");
      expect(dangling.occurrences).toBe(3);

      expect(rows.occurrences).toHaveLength(4);
      expect(
        rows.occurrences
          .filter((o) => o.key === ORG.key)
          .map((o) => o.normalizedUrl)
      ).toEqual(["http://x.test/a", "http://x.test/b", "http://x.test/c"]);
    });
  });

  test("a rewrite replaces the crawl's rows instead of merging", async () => {
    await withStorage(async (storage, crawlId) => {
      await run(
        storage.saveEntityMap(crawlId, {
          nodes: [ORG, CRUMB],
          edges: [
            {
              source: ORG.key,
              predicate: "about",
              target: CRUMB.key,
              dangling: false,
              occurrences: 1,
            },
          ],
          occurrences: [{ key: ORG.key, normalizedUrl: "http://x.test/a" }],
        })
      );

      // `squirrel analyze` re-running over the same crawl after the site
      // dropped its BreadcrumbList markup.
      await run(
        storage.saveEntityMap(crawlId, {
          nodes: [ORG],
          edges: [],
          occurrences: [{ key: ORG.key, normalizedUrl: "http://x.test/a" }],
        })
      );

      const rows = await run(storage.getEntityMapRows(crawlId));
      expect(rows.nodes.map((n) => n.key)).toEqual([ORG.key]);
      expect(rows.edges).toHaveLength(0);
      expect(rows.occurrences).toHaveLength(1);
    });
  });

  test("an empty map clears the crawl and reads back empty", async () => {
    await withStorage(async (storage, crawlId) => {
      await run(
        storage.saveEntityMap(crawlId, {
          nodes: [ORG],
          edges: [],
          occurrences: [{ key: ORG.key, normalizedUrl: "http://x.test/a" }],
        })
      );
      await run(storage.saveEntityMap(crawlId, { nodes: [], edges: [], occurrences: [] }));

      const rows = await run(storage.getEntityMapRows(crawlId));
      expect(rows.nodes).toHaveLength(0);
      expect(rows.edges).toHaveLength(0);
      expect(rows.occurrences).toHaveLength(0);
    });
  });

  test("reading a crawl that never stored a map returns empty, not an error", async () => {
    await withStorage(async (storage, crawlId) => {
      const rows = await run(storage.getEntityMapRows(crawlId));
      expect(rows.nodes).toHaveLength(0);
      expect(rows.edges).toHaveLength(0);
      expect(rows.occurrences).toHaveLength(0);
    });
  });

  test("retiring a crawl deletes its entity rows", async () => {
    await withStorage(async (storage, crawlId) => {
      await run(
        storage.saveEntityMap(crawlId, {
          nodes: [ORG],
          edges: [
            {
              source: ORG.key,
              predicate: "publisher",
              target: "id:missing",
              dangling: true,
              occurrences: 1,
            },
          ],
          occurrences: [{ key: ORG.key, normalizedUrl: "http://x.test/a" }],
        })
      );

      await run(storage.retireCrawls([crawlId]));

      const rows = await run(storage.getEntityMapRows(crawlId));
      expect(rows.nodes).toHaveLength(0);
      expect(rows.edges).toHaveLength(0);
      expect(rows.occurrences).toHaveLength(0);
    });
  });
});
