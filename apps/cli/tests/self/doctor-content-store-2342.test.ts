// repo#2342: `squirrel self doctor` reports the content store's size, its cap and
// its last eviction, which used to be invisible.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTENT_STORE_MAX_BYTES_ENV,
  ContentStore,
} from "@/crawler/storage/content-store";
import { checkContentStore } from "@/self/doctor";

let dir: string;
const savedEnv = process.env[CONTENT_STORE_MAX_BYTES_ENV];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "doctor-content-store-"));
  delete process.env[CONTENT_STORE_MAX_BYTES_ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[CONTENT_STORE_MAX_BYTES_ENV];
  else process.env[CONTENT_STORE_MAX_BYTES_ENV] = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

function noise(bytes: number): string {
  let out = "";
  while (out.length < bytes) out += Math.random().toString(36).slice(2);
  return out.slice(0, bytes);
}

describe("self doctor: content store (#2342)", () => {
  test("a missing store passes and names the cap", () => {
    const check = checkContentStore({ path: join(dir, "absent.db") });
    expect(check.status).toBe("pass");
    expect(check.message).toBe(
      "Empty (created by the first audit); cap 1.0 GB"
    );
  });

  test("reports size, entries, cap and that nothing was ever evicted", () => {
    const path = join(dir, "store.db");
    const store = new ContentStore(path, 10_000_000);
    for (let i = 0; i < 3; i++) store.put(noise(4_000), "text/html");
    store.close();

    const check = checkContentStore({ path });
    expect(check.status).toBe("pass");
    expect(check.message).toMatch(
      /^\d+(\.\d)? KB in 3 entries, cap 1\.0 GB; no eviction recorded$/
    );
  });

  test("reports the last eviction and when it happened", () => {
    const path = join(dir, "store.db");
    const store = new ContentStore(path, 50_000);
    for (let i = 0; i < 20; i++) store.put(noise(8_000), "text/html");
    const eviction = store.getLastEviction();
    store.close();
    expect(eviction).not.toBeNull();

    const check = checkContentStore({
      path,
      now: eviction!.at + 3 * 3_600_000,
    });
    expect(check.message).toContain(
      `last eviction 3h ago (${eviction!.entries} entries,`
    );
  });

  test("names the env var when it sets the cap, and warns when the store is over it", () => {
    const path = join(dir, "store.db");
    const store = new ContentStore(path, 10_000_000);
    for (let i = 0; i < 5; i++) store.put(noise(8_000), "text/html");
    store.close();

    process.env[CONTENT_STORE_MAX_BYTES_ENV] = "16KB";
    const check = checkContentStore({ path });
    expect(check.status).toBe("warn");
    expect(check.message).toContain(
      `cap 16.0 KB (${CONTENT_STORE_MAX_BYTES_ENV})`
    );
    expect(check.message).toContain("Over the cap");
    expect(check.fix).toContain("content_store_max_bytes");
  });

  test("is read-only: it does not create the store's tables", () => {
    // A store written by an older binary has no store_meta table; the doctor
    // must read it as "no eviction recorded" and leave it that way.
    const path = join(dir, "old.db");
    const db = new Database(path);
    db.run(
      "CREATE TABLE content (hash TEXT PRIMARY KEY, content BLOB NOT NULL, content_type TEXT NOT NULL, original_size INTEGER NOT NULL, compressed_size INTEGER NOT NULL, created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 1)"
    );
    db.close();

    expect(checkContentStore({ path }).message).toContain(
      "no eviction recorded"
    );
    const after = new Database(path);
    const tables = after
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    after.close();
    expect(tables.map((t) => t.name)).toEqual(["content"]);
  });
});
