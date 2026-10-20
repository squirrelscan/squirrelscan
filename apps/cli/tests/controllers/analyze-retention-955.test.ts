// #955: `squirrel analyze` finishes an audit in the split pipeline (crawl,
// analyze, report), so it applies `[storage] keep_audits` like `squirrel audit`
// does. A project audited only through the split commands never retired
// anything, and its project.db grew to several GB.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CrawlMetadata, PageRecord } from "@/crawler/storage/types";

import { runAnalyze } from "@/controllers/analyze";
import { createStorage } from "@/crawler/storage";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

const home = isolateSquirrelHome("squirrel-analyze-retention-955");

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);

const STATS = {
  pagesTotal: 1,
  pagesFetched: 1,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

const HTML =
  "<!doctype html><html lang=en><head><title>Split pipeline</title></head><body><h1>Hi</h1></body></html>";

function pageRecord(status: number): PageRecord {
  const url = "https://e.test/";
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status,
    contentType: "text/html",
    sizeBytes: HTML.length,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: HTML,
    parsedData: null,
    headers: {},
    securityHeaders: {},
  } as unknown as PageRecord;
}

/** A crawled-but-not-analyzed crawl: what `squirrel crawl` leaves behind. */
async function crawled(
  store: SQLiteStorage,
  index: number,
  pageStatus = 200
): Promise<string> {
  const id = await run(
    store.createCrawl({
      baseUrl: "https://e.test",
      startedAt: 1_000 + index,
      status: "crawled",
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">)
  );
  await run(store.upsertPage(id, pageRecord(pageStatus)));
  return id;
}

function config(project: string | null, keep: number): string {
  const path = join(home.dir, `${project ?? "unnamed"}-${keep}.toml`);
  const head = project ? `[project]\nname = "${project}"\n` : "";
  writeFileSync(path, `${head}[storage]\nkeep_audits = ${keep}\n`);
  return path;
}

async function retiredFlags(
  store: SQLiteStorage,
  ids: string[]
): Promise<boolean[]> {
  const crawls = await run(store.listCrawls(50));
  return ids.map((id) => {
    const crawl = crawls.find((c) => c.id === id);
    return Boolean(crawl?.retiredAt);
  });
}

async function project(name: string): Promise<SQLiteStorage> {
  return (await run(createStorage({ projectName: name }))) as SQLiteStorage;
}

describe("analyze applies keep_audits retention (#955)", () => {
  test("the third split-pipeline audit retires those beyond the window", async () => {
    const store = await project("split-a");
    const ids = [
      await crawled(store, 1),
      await crawled(store, 2),
      await crawled(store, 3),
    ];
    await run(store.close());

    for (const id of ids) {
      const result = await runAnalyze({
        crawlId: id,
        configPath: config("split-a", 1),
      });
      expect(result.ok).toBe(true);
    }

    const check = await project("split-a");
    try {
      // keep_audits = 1: only the newest audit stays openable.
      expect(await retiredFlags(check, ids)).toEqual([true, true, false]);
    } finally {
      await run(check.close());
    }
  }, 60_000);

  test("keep_audits = 0 retires nothing", async () => {
    const store = await project("split-b");
    const ids = [await crawled(store, 1), await crawled(store, 2)];
    await run(store.close());
    for (const id of ids) {
      await runAnalyze({ crawlId: id, configPath: config("split-b", 0) });
    }
    const check = await project("split-b");
    try {
      expect(await retiredFlags(check, ids)).toEqual([false, false]);
    } finally {
      await run(check.close());
    }
  }, 60_000);

  test("a blocked crawl never retires history", async () => {
    const store = await project("split-c");
    const good = await crawled(store, 1);
    const blocked = await crawled(store, 2, 403);
    await run(store.close());
    await runAnalyze({ crawlId: good, configPath: config("split-c", 1) });
    await runAnalyze({ crawlId: blocked, configPath: config("split-c", 1) });
    const check = await project("split-c");
    try {
      expect(await retiredFlags(check, [good, blocked])).toEqual([
        false,
        false,
      ]);
    } finally {
      await run(check.close());
    }
  }, 60_000);

  test("another project's crawl is left alone by this directory's window", async () => {
    const store = await project("split-d");
    const ids = [await crawled(store, 1), await crawled(store, 2)];
    await run(store.close());
    for (const id of ids) {
      await runAnalyze({
        crawlId: id,
        configPath: config("some-other-project", 1),
      });
    }
    const check = await project("split-d");
    try {
      expect(await retiredFlags(check, ids)).toEqual([false, false]);
    } finally {
      await run(check.close());
    }
  }, 60_000);

  test("with no project name, --id never applies this directory's window", async () => {
    const store = await project("split-e");
    const ids = [await crawled(store, 1), await crawled(store, 2)];
    await run(store.close());
    for (const id of ids) {
      await runAnalyze({ crawlId: id, configPath: config(null, 1) });
    }
    const check = await project("split-e");
    try {
      expect(await retiredFlags(check, ids)).toEqual([false, false]);
    } finally {
      await run(check.close());
    }
  }, 60_000);

  test("with no project name, the latest crawl's project is retained", async () => {
    // The split pipeline: crawl, then analyze the latest crawl, twice over.
    const ids: string[] = [];
    // Newest crawls in the scratch home, so "latest" is this project's.
    for (const index of [10_001, 10_002]) {
      const store = await project("split-f");
      ids.push(await crawled(store, index));
      await run(store.close());
      const result = await runAnalyze({ configPath: config(null, 1) });
      expect(result.ok).toBe(true);
    }
    const check = await project("split-f");
    try {
      expect(await retiredFlags(check, ids)).toEqual([true, false]);
    } finally {
      await run(check.close());
    }
  }, 60_000);

  test("an audit still building its report keeps its sentinel", async () => {
    const store = await project("split-g");
    const id = await crawled(store, 1);
    await run(store.setReportStatus(id, "building"));
    await run(store.close());
    await runAnalyze({ crawlId: id, configPath: config("split-g", 1) });
    const check = await project("split-g");
    try {
      const row = (
        check as unknown as {
          getDb(): {
            prepare(q: string): { get(id: string): { report_status: string } };
          };
        }
      )
        .getDb()
        .prepare("SELECT report_status FROM crawls WHERE id = ?")
        .get(id);
      expect(row.report_status).toBe("building");
    } finally {
      await run(check.close());
    }
  }, 60_000);
});
