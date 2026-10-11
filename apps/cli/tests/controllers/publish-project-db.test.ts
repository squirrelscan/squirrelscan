// #625: marking a published report opens the audited project's database and
// nothing else. It used to open and initialise every `project.db` under the
// projects directory until one held the crawl, which stalled the end of an
// audit on a store with thousands of projects after the report url printed.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { CrawlMetadata, PageRecord } from "@/crawler/storage/types";

import {
  type AuditSource,
  getLatestAudit,
  getStoredAudit,
  getStoredAuditByPrefix,
} from "@/controllers/report";
import { savePublishedReportInfo } from "@/controllers/report/publish";
import { resolveProjectDbPath } from "@/crawler/storage";
import {
  closeGlobalContentStore,
  getGlobalContentStore,
} from "@/crawler/storage/content-store";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { getProjectsPath } from "@/self/paths";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

const home = isolateSquirrelHome("squirrel-publish-project-db");

const run = <A>(effect: Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(effect);

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

const nulls = <K extends string>(keys: K[]) =>
  Object.fromEntries(keys.map((k) => [k, null])) as Record<K, null>;

function page(url: string): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 20,
    loadTimeMs: 1,
    fetchedAt: 1_000,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: "<html><head><title>t</title></head><body>b</body></html>",
    parsedData: null,
    headers: {
      ...nulls([
        "contentEncoding",
        "cacheControl",
        "vary",
        "etag",
        "server",
        "lastModified",
        "link",
        "serverTiming",
        "age",
        "xCache",
        "cfCacheStatus",
        "xVercelCache",
        "altSvc",
        "acceptRanges",
      ]),
      contentType: "text/html",
    },
    securityHeaders: nulls([
      "hsts",
      "csp",
      "xFrameOptions",
      "xContentTypeOptions",
      "referrerPolicy",
      "permissionsPolicy",
      "xRobotsTag",
    ]),
  } as PageRecord;
}

/** A project database holding one renderable audit; returns the crawl id. */
async function projectWithCrawl(
  name: string,
  startedAt = Date.now()
): Promise<string> {
  mkdirSync(join(getProjectsPath(), name), { recursive: true });
  const store = new SQLiteStorage(resolveProjectDbPath(name));
  await run(store.init());
  const id = await run(
    store.createCrawl({
      baseUrl: "https://shop.test",
      startedAt,
      status: "completed",
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">)
  );
  await run(store.upsertPage(id, page("https://shop.test/")));
  await run(
    store.saveRuleResults(id, "https://shop.test/", "core/favicon", [
      { name: "favicon", status: "pass", message: "Favicon found: ico" },
    ])
  );
  await run(store.close());
  return id;
}

async function publishedIn(name: string, crawlId: string) {
  const store = new SQLiteStorage(resolveProjectDbPath(name));
  await run(store.init());
  const record = await run(store.getPublishedReport(crawlId));
  await run(store.close());
  return record;
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

describe("savePublishedReportInfo (#625)", () => {
  test("opens only the audited project's database, however many others exist", async () => {
    home.use("many-projects");
    const crawlId = await projectWithCrawl("shop-test");
    // 500 empty project directories, and 20 real databases that sort first and
    // hold a copy of the same crawl, so a search would open them and could stop
    // at the wrong one.
    for (let i = 0; i < 500; i++) {
      mkdirSync(join(getProjectsPath(), `empty-${i}`), { recursive: true });
    }
    for (let i = 0; i < 20; i++) {
      const name = `aaa-decoy-${String(i).padStart(2, "0")}`;
      mkdirSync(join(getProjectsPath(), name), { recursive: true });
      copyFileSync(
        resolveProjectDbPath("shop-test"),
        resolveProjectDbPath(name)
      );
    }

    const init = spyOn(SQLiteStorage.prototype, "init");
    restores.push(() => init.mockRestore());

    await savePublishedReportInfo(
      resolveProjectDbPath("shop-test"),
      crawlId,
      "rep_1",
      "https://reports.squirrelscan.com/rep_1",
      "unlisted"
    );

    expect(init).toHaveBeenCalledTimes(1);
    init.mockRestore();
    expect((await publishedIn("shop-test", crawlId))?.reportId).toBe("rep_1");
    expect(await publishedIn("aaa-decoy-00", crawlId)).toBeNull();
  });

  test("never lists the projects directory", async () => {
    home.use("unlistable");
    const crawlId = await projectWithCrawl("shop-test");
    // Write and search but no read: the directory cannot be listed, while a
    // path inside it still opens. (Ignored when the tests run as root.)
    chmodSync(getProjectsPath(), 0o311);
    restores.push(() => chmodSync(getProjectsPath(), 0o755));

    await savePublishedReportInfo(
      resolveProjectDbPath("shop-test"),
      crawlId,
      "rep_2",
      "https://reports.squirrelscan.com/rep_2",
      "public"
    );

    chmodSync(getProjectsPath(), 0o755);
    expect((await publishedIn("shop-test", crawlId))?.reportId).toBe("rep_2");
  });

  test("a missing database or a crawl it does not hold is a quiet no-op", async () => {
    home.use("missing");
    const crawlId = await projectWithCrawl("shop-test");
    const write = () =>
      savePublishedReportInfo(
        resolveProjectDbPath("never-audited"),
        crawlId,
        "rep_3",
        "https://reports.squirrelscan.com/rep_3",
        "public"
      );
    expect(write()).resolves.toBeUndefined();
    await savePublishedReportInfo(
      resolveProjectDbPath("shop-test"),
      "00000000-0000-0000-0000-000000000000",
      "rep_3",
      "https://reports.squirrelscan.com/rep_3",
      "public"
    );
    expect(await publishedIn("shop-test", crawlId)).toBeNull();
  });
});

describe("the scratch home holds against an inherited env override (#626)", () => {
  test("SQUIRREL_CONTENT_STORE_PATH does not move the shared store out of it", () => {
    const prior = process.env.SQUIRREL_CONTENT_STORE_PATH;
    process.env.SQUIRREL_CONTENT_STORE_PATH = join(home.dir, "elsewhere.db");
    try {
      closeGlobalContentStore();
      expect(getGlobalContentStore().getPath()).toBe(
        join(home.root, "content-store.db")
      );
    } finally {
      closeGlobalContentStore();
      if (prior === undefined) delete process.env.SQUIRREL_CONTENT_STORE_PATH;
      else process.env.SQUIRREL_CONTENT_STORE_PATH = prior;
    }
  });
});

describe("report loaders say which database the audit came from (#625)", () => {
  test("by id, by prefix and latest, the source is the database that holds it", async () => {
    home.use("source");
    const older = await projectWithCrawl("aaa-shop-test", 1_000);
    const newer = await projectWithCrawl("shop-test", 2_000);

    const byId: AuditSource = {};
    expect((await getStoredAudit(older, undefined, byId)).ok).toBe(true);
    expect(byId.dbPath).toBe(resolveProjectDbPath("aaa-shop-test"));

    const byPrefix: AuditSource = {};
    const prefixed = await getStoredAuditByPrefix(
      newer.slice(0, 8),
      undefined,
      byPrefix
    );
    expect(prefixed.ok).toBe(true);
    expect(byPrefix.dbPath).toBe(resolveProjectDbPath("shop-test"));

    const latest: AuditSource = {};
    expect((await getLatestAudit(undefined, undefined, latest)).ok).toBe(true);
    expect(latest.dbPath).toBe(resolveProjectDbPath("shop-test"));

    // Nothing found, nothing recorded.
    const none: AuditSource = {};
    await getStoredAudit(
      "00000000-0000-0000-0000-000000000000",
      undefined,
      none
    );
    expect(none.dbPath).toBeUndefined();
  });
});
