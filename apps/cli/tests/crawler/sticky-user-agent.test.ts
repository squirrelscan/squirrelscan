// Sticky per-project user-agent (#875)
// The random UA is drawn once per project and persisted in project_meta, so
// later runs against the same project store serve the same markup and keep
// the content-keyed caches (render fingerprint, server render cache, LLM page
// cache) warm. Explicit config always wins; --fresh-ua re-rolls the pin.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import {
  resolveStickyUserAgent,
  USER_AGENT_META_KEY,
  isModernUserAgentString,
} from "@/utils/user-agent";

// Passes the modern-browser filter but can never come out of a random draw.
const SENTINEL_UA = "Mozilla/5.0 (SquirrelTest) Chrome/999.0.0.0 Safari/537.36";

describe("sticky user-agent (#875)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `squirrel-sticky-ua-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "project.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function openStorage(): Promise<SQLiteStorage> {
    const storage = new SQLiteStorage(dbPath);
    await Effect.runPromise(storage.init());
    return storage;
  }

  test("two runs over the same project store use the same UA", async () => {
    // Run 1: first crawl draws and pins
    const storage1 = await openStorage();
    const first = await Effect.runPromise(resolveStickyUserAgent("", storage1));
    expect(first.source).toBe("fresh");
    expect(first.userAgent.length).toBeGreaterThan(0);
    await Effect.runPromise(storage1.close());

    // Run 2: a separate storage instance over the same project.db reuses it
    const storage2 = await openStorage();
    const second = await Effect.runPromise(
      resolveStickyUserAgent("", storage2)
    );
    expect(second.source).toBe("sticky");
    expect(second.userAgent).toBe(first.userAgent);
    await Effect.runPromise(storage2.close());
  });

  test("explicit config user_agent wins and never touches the pin", async () => {
    const storage = await openStorage();
    const pinned = await Effect.runPromise(resolveStickyUserAgent("", storage));

    const custom = await Effect.runPromise(
      resolveStickyUserAgent("MyBot/1.0 (+https://example.com/bot)", storage)
    );
    expect(custom.source).toBe("config");
    expect(custom.userAgent).toBe("MyBot/1.0 (+https://example.com/bot)");

    // Pin unchanged — unsetting the config later returns to the same UA
    const meta = await Effect.runPromise(
      storage.getProjectMeta(USER_AGENT_META_KEY)
    );
    expect(meta).toBe(pinned.userAgent);
    await Effect.runPromise(storage.close());
  });

  test("freshUa re-rolls and persists the new draw", async () => {
    const storage = await openStorage();
    await Effect.runPromise(
      storage.setProjectMeta(USER_AGENT_META_KEY, SENTINEL_UA)
    );

    const rerolled = await Effect.runPromise(
      resolveStickyUserAgent("", storage, { freshUa: true })
    );
    expect(rerolled.source).toBe("fresh");
    expect(rerolled.userAgent).not.toBe(SENTINEL_UA);

    const meta = await Effect.runPromise(
      storage.getProjectMeta(USER_AGENT_META_KEY)
    );
    expect(meta).toBe(rerolled.userAgent);
    await Effect.runPromise(storage.close());
  });

  test("a pin below the modern-browser floor is re-rolled (#854)", async () => {
    const storage = await openStorage();
    const staleUa =
      "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2171.95 Safari/537.36";
    await Effect.runPromise(
      storage.setProjectMeta(USER_AGENT_META_KEY, staleUa)
    );

    const resolved = await Effect.runPromise(
      resolveStickyUserAgent("", storage)
    );
    expect(resolved.source).toBe("fresh");
    expect(isModernUserAgentString(resolved.userAgent)).toBe(true);

    const meta = await Effect.runPromise(
      storage.getProjectMeta(USER_AGENT_META_KEY)
    );
    expect(meta).toBe(resolved.userAgent);
    await Effect.runPromise(storage.close());
  });

  test("project_meta roundtrip: set, get, overwrite", async () => {
    const storage = await openStorage();
    expect(
      await Effect.runPromise(storage.getProjectMeta("missing"))
    ).toBeNull();

    await Effect.runPromise(storage.setProjectMeta("k", "v1"));
    expect(await Effect.runPromise(storage.getProjectMeta("k"))).toBe("v1");

    await Effect.runPromise(storage.setProjectMeta("k", "v2"));
    expect(await Effect.runPromise(storage.getProjectMeta("k"))).toBe("v2");
    await Effect.runPromise(storage.close());
  });
});
