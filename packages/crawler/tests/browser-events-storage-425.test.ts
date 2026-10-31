// #425: what a browser render saw (CSP violations, failed requests, page errors) is stored with the page and
// read back through the same bounds; a database from before the column gets it by migration.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserEvents } from "@squirrelscan/core-contracts";

import { SQLiteStorage, SCHEMA_VERSION } from "../src/storage/sqlite";
import type { CrawlMetadata, PageRecord } from "../src/storage/types";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A, never, never>);

const STATS = { pagesTotal: 0, pagesFetched: 0, pagesFailed: 0, pagesSkipped: 0, pagesUnchanged: 0, linksTotal: 0, imagesTotal: 0, bytesTotal: 0, avgLoadTimeMs: 0 };

const EVENTS: BrowserEvents = {
  cspViolations: [{ violatedDirective: "script-src-elem", blockedUri: "https://w.test/e.js", disposition: "enforce" }],
  failedRequests: [{ url: "https://w.test/e.js", failure: "net::ERR_BLOCKED_BY_CSP" }],
  pageErrors: ["boom"],
  listenedAfterLoad: true,
};

function page(url: string, extra: Partial<PageRecord> = {}): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 10,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: "<html></html>",
    parsedData: null,
    headers: {} as PageRecord["headers"],
    securityHeaders: {} as PageRecord["securityHeaders"],
    ...extra,
  } as PageRecord;
}

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-browser-events-"));
  dbPath = join(dir, "project.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function crawl(s: SQLiteStorage): Promise<string> {
  return run(s.createCrawl({ baseUrl: "https://e.test", startedAt: 1, status: "analyzed", config: {} as CrawlMetadata["config"], stats: STATS } as Omit<CrawlMetadata, "id">));
}

describe("browser events on a stored page", () => {
  test("round trip: the events come back with the page, and a page without them has none", async () => {
    const s = new SQLiteStorage(dbPath);
    await run(s.init());
    const id = await crawl(s);
    await run(s.upsertPage(id, page("https://e.test/a", { browserEvents: EVENTS, fetcherId: "cloud-render" })));
    await run(s.upsertPage(id, page("https://e.test/b")));
    expect((await run(s.getPage(id, "https://e.test/a")))?.browserEvents).toEqual(EVENTS);
    expect((await run(s.getPage(id, "https://e.test/b")))?.browserEvents ?? null).toBeNull();
    const all = await run(s.getPages(id));
    expect(all.find((p) => p.url.endsWith("/a"))?.browserEvents).toEqual(EVENTS);
    const bodyless = await run(s.getPagesWithoutBodies(id));
    expect(bodyless.find((p) => p.url.endsWith("/a"))?.browserEvents).toEqual(EVENTS);
    s.close?.();
  });

  test("a database written before the column gets it by migration, and keeps its rows", async () => {
    const s = new SQLiteStorage(dbPath);
    await run(s.init());
    const id = await crawl(s);
    await run(s.upsertPage(id, page("https://e.test/old")));
    s.close?.();
    // Take the column away and stamp the previous version, as a database from before this feature is.
    const raw = new Database(dbPath);
    raw.exec("ALTER TABLE pages DROP COLUMN browser_events");
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    raw.close();
    const again = new SQLiteStorage(dbPath);
    await run(again.init());
    expect((await run(again.getPage(id, "https://e.test/old")))?.url).toBe("https://e.test/old");
    await run(again.upsertPage(id, page("https://e.test/new", { browserEvents: EVENTS })));
    expect((await run(again.getPage(id, "https://e.test/new")))?.browserEvents).toEqual(EVENTS);
    again.close?.();
  });

  test("a stored value that is not valid events reads back as none, never an error", async () => {
    const s = new SQLiteStorage(dbPath);
    await run(s.init());
    const id = await crawl(s);
    await run(s.upsertPage(id, page("https://e.test/x", { browserEvents: EVENTS })));
    s.close?.();
    const raw = new Database(dbPath);
    raw.query("UPDATE pages SET browser_events = ? WHERE normalized_url = ?").run("{not json", "https://e.test/x");
    raw.close();
    const again = new SQLiteStorage(dbPath);
    await run(again.init());
    expect((await run(again.getPage(id, "https://e.test/x")))?.browserEvents ?? null).toBeNull();
    again.close?.();
  });
});
