// Migration 48 adds the ax/markdown-response negotiation status columns
// (repo#1322). Like every ALTER-added column, they are also re-added on open by
// the column reconcile, so a DB stamped at the current version without them
// (a migration renumbering collision) still accepts the markdown probe write.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Effect } from "effect";

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
const newCrawl = (store: SQLiteStorage): Promise<string> =>
  run(
    store.createCrawl({
      baseUrl: "https://example.com",
      startedAt: 1,
      status: "running",
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">),
  );

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const tmpFiles: string[] = [];
function tmpDbPath(): string {
  const p = join(tmpdir(), `squirrel-markdown-${randomUUID()}.db`);
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

const NEW_COLUMNS = [
  "negotiated_status",
  "strict_negotiated_status",
  "strict_negotiated_content_type",
  "strict_negotiation_answered",
  "md_variant_answered",
];

function markdownColumns(path: string): string[] {
  const db = new Database(path);
  const cols = (
    db.prepare("PRAGMA table_info(markdown_response)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  db.close();
  return cols;
}

describe("markdown_response negotiation status columns (repo#1322)", () => {
  test("a fresh DB has the columns", async () => {
    const path = tmpDbPath();
    const store = new SQLiteStorage(path);
    await run(store.init());
    await run(store.close());
    for (const col of NEW_COLUMNS) expect(markdownColumns(path)).toContain(col);
  });

  test("a current-version DB missing the columns gets them back on open", async () => {
    const path = tmpDbPath();
    const store = new SQLiteStorage(path);
    await run(store.init());
    await run(store.close());

    const db = new Database(path);
    for (const col of NEW_COLUMNS) db.exec(`ALTER TABLE markdown_response DROP COLUMN ${col}`);
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    db.close();
    expect(version.v).toBe(SCHEMA_VERSION);
    for (const col of NEW_COLUMNS) expect(markdownColumns(path)).not.toContain(col);

    const reopened = new SQLiteStorage(path);
    await run(reopened.init());
    await run(reopened.close());
    for (const col of NEW_COLUMNS) expect(markdownColumns(path)).toContain(col);
  });

  test("the answered flags round-trip: false stays false, a row without them reads as unknown", async () => {
    const path = tmpDbPath();
    const store = new SQLiteStorage(path);
    await run(store.init());
    const base = {
      negotiatedUrl: "https://example.com/",
      negotiatedContentType: "text/html",
      servesMarkdown: false,
      mdVariantUrl: "https://example.com/index.md",
      mdVariantExists: false,
      mdVariantContentType: null,
      fetchedAt: 1,
    };
    const unanswered = await newCrawl(store);
    await run(
      store.setMarkdownProbe(unanswered, {
        ...base,
        strictNegotiationAnswered: false,
        mdVariantAnswered: false,
      }),
    );
    const legacy = await newCrawl(store);
    await run(store.setMarkdownProbe(legacy, base));

    const a = await run(store.getMarkdownProbe(unanswered));
    expect(a?.strictNegotiationAnswered).toBe(false);
    expect(a?.mdVariantAnswered).toBe(false);
    const b = await run(store.getMarkdownProbe(legacy));
    expect(b?.strictNegotiationAnswered).toBeUndefined();
    expect(b?.mdVariantAnswered).toBeUndefined();
    await run(store.close());
  });
});
