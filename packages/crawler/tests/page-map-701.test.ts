// #701: the read behind `squirrel pages`' flags: the pages a rule flagged (page rules and site rules
// that name pages in `items`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CheckResult } from "@squirrelscan/core-contracts";

import type { CrawlMetadata, PageRecord } from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

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

function page(url: string, fetchedAt: number): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 10,
    loadTimeMs: 1,
    fetchedAt,
    etag: `e${fetchedAt}`,
    lastModified: null,
    contentHash: `h${fetchedAt}`,
    html: "<html></html>",
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
  } as PageRecord;
}


let dir: string;
let storage: SQLiteStorage;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sq-pagemap-701-"));
  storage = new SQLiteStorage(join(dir, "project.db"));
  await run(storage.init());
});
afterEach(() => {
  storage.close?.();
  rmSync(dir, { recursive: true, force: true });
});

async function crawl(): Promise<string> {
  const id = await run(
    storage.createCrawl({
      baseUrl: "https://e.test",
      startedAt: 1_000,
      status: "analyzed",
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">)
  );
  for (const url of ["https://e.test/", "https://e.test/a", "https://e.test/b"]) {
    await run(storage.upsertPage(id, page(url, 1_000)));
  }
  return id;
}

const check = (over: Partial<CheckResult>): CheckResult =>
  ({ name: "c", status: "warn", message: "m", ...over }) as CheckResult;

describe("getFlaggedPages", () => {
  test("reads the page of a page rule and the pages a site rule names, only for fail and warn", async () => {
    const id = await crawl();
    await run(
      storage.saveRuleResultsBatch(
        id,
        new Map([
          ["https://e.test/a", [{ ruleId: "core/meta-title", checks: [check({ pageUrl: "https://e.test/a", status: "warn" })] }]],
          ["https://e.test/b", [{ ruleId: "core/meta-title", checks: [check({ pageUrl: "https://e.test/b", status: "pass" })] }]],
          [
            "",
            [
              {
                ruleId: "links/orphan-pages",
                checks: [check({ items: [{ id: "https://e.test/a" }, { id: "https://e.test/b" }] })],
              },
              {
                ruleId: "content/duplicate-title",
                checks: [
                  check({
                    items: [
                      { id: "same title", label: "x", sourcePages: ["https://e.test/a", "https://e.test/b"] },
                      { id: "not a url and no pages" },
                    ],
                  }),
                ],
              },
              { ruleId: "core/h1", checks: [check({ pageUrl: "https://e.test/", status: "fail" })] },
            ],
          ],
        ])
      )
    );
    const flagged = await run(storage.getFlaggedPages(id, ["core/meta-title", "links/orphan-pages"]));
    expect(flagged.get("core/meta-title")).toEqual(["https://e.test/a"]);
    expect([...(flagged.get("links/orphan-pages") ?? [])].sort()).toEqual(["https://e.test/a", "https://e.test/b"]);
    // A duplicate group names its pages in `sourcePages`; an item id that is not a URL names none.
    const dup = await run(storage.getFlaggedPages(id, ["content/duplicate-title"]));
    expect([...(dup.get("content/duplicate-title") ?? [])].sort()).toEqual(["https://e.test/a", "https://e.test/b"]);
    // A rule not asked for is not read.
    expect(flagged.has("core/h1")).toBe(false);
  });

  test("an empty rule list reads nothing", async () => {
    const id = await crawl();
    expect((await run(storage.getFlaggedPages(id, []))).size).toBe(0);
  });
});
