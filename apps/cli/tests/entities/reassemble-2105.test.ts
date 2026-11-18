// repo#2105: a map written to the store comes back from `reassembleMap` equal to
// the document on the facts the tables alone could not recover.

import type { EntityMap } from "@squirrelscan/core-contracts/entity-map";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { storeEntityMap } from "@/audit/entity-map";
import { reassembleMap } from "@/controllers/entities";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e);

const ORG = "id:http://x.test/#org";
const LOGO = "id:http://x.test/#logo";

function document(): EntityMap {
  return {
    format: "squirrelscan.entity-map",
    version: 1,
    site: "http://x.test",
    generatedAt: new Date(1_000).toISOString(),
    summary: {} as EntityMap["summary"],
    nodes: [
      {
        key: ORG,
        id: "http://x.test/#org",
        types: ["Organization"],
        name: "Acme",
        properties: {},
        occurrences: 2,
        pages: ["http://x.test/a"],
        morePages: 0,
        conflicts: [],
        danglingRefs: 0,
        pageLocal: false,
      },
    ],
    edges: [
      {
        source: ORG,
        predicate: "logo",
        target: LOGO,
        dangling: true,
        occurrences: 1,
        pages: ["http://x.test/a"],
        morePages: 0,
      },
    ],
    pages: [
      // The same entity declared twice: two declarations, one key.
      {
        url: "http://x.test/a",
        declares: [ORG],
        references: [LOGO],
        entityCount: 2,
      },
      { url: "http://x.test/b", declares: [], references: [], entityCount: 0 },
    ],
  } as unknown as EntityMap;
}

describe("reassembleMap (repo#2105)", () => {
  test("pages and edges come back equal to the document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "squirrelscan-reasm-"));
    const storage = new SQLiteStorage(join(dir, "store.sqlite"));
    try {
      await run(storage.init());
      const crawlId = await run(
        storage.createCrawl({
          baseUrl: "http://x.test",
          startedAt: 1_000,
          status: "completed",
          config: {} as never,
          stats: {
            pagesTotal: 2,
            pagesFetched: 2,
            pagesFailed: 0,
            pagesSkipped: 0,
            pagesUnchanged: 0,
            linksTotal: 0,
            imagesTotal: 0,
            bytesTotal: 0,
            avgLoadTimeMs: 0,
          },
        })
      );
      const doc = document();
      await storeEntityMap({ storage, crawlId, map: doc });
      const crawls = await run(storage.listCrawls());
      const rows = await run(storage.getEntityMapRows(crawlId));
      const rebuilt = reassembleMap(
        crawls.find((c) => c.id === crawlId)!,
        rows,
        doc.pages.map((p: { url: string }) => p.url)
      );
      expect(rebuilt.pages).toEqual(doc.pages);
      expect(rebuilt.edges).toEqual(doc.edges);
      expect(rebuilt.pages[0]!.entityCount).toBe(2);
    } finally {
      await run(storage.close());
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a crawl from before the migration falls back to distinct keys", () => {
    const rebuilt = reassembleMap(
      { baseUrl: "http://x.test", startedAt: 1_000 } as never,
      {
        nodes: [],
        edges: [],
        occurrences: [{ key: ORG, normalizedUrl: "http://x.test/a" }],
      },
      ["http://x.test/a"]
    );
    expect(rebuilt.pages[0]!.entityCount).toBe(1);
    expect(rebuilt.pages[0]!.references).toEqual([]);
  });
});
