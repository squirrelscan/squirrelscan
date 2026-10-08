import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChannelEvent } from "@/channel/events";

import {
  type FeedPage,
  type FetchPageResult,
  pollOnce,
} from "@/channel/poller";
import {
  type ChannelState,
  MAX_SEEN_KEYS,
  type StateStore,
  createFileStateStore,
  emptyState,
} from "@/channel/state";

const CATEGORIES = new Set([
  "audit_complete",
  "audit_failed",
  "issues_detected",
]);

function memoryStore(initial: ChannelState = emptyState()): StateStore & {
  current: ChannelState;
} {
  const store = {
    current: structuredClone(initial),
    load: () => structuredClone(store.current),
    save: (state: ChannelState) => {
      store.current = structuredClone(state);
    },
  };
  return store;
}

function notification(
  id: string,
  runId = `run_${id}`,
  category = "audit_complete"
) {
  return { id, category, data: { runId, websiteId: "web_1", domain: "a.io" } };
}

function page(
  rows: ReturnType<typeof notification>[],
  nextCursor?: string | null
): FetchPageResult {
  const value: FeedPage = {
    rows,
    cursorSupported: nextCursor !== undefined,
    nextCursor: nextCursor ?? null,
  };
  return { ok: true, page: value };
}

function harness(
  responses: FetchPageResult[],
  store = memoryStore(),
  categories: ReadonlySet<string> = CATEGORIES
) {
  const events: ChannelEvent[] = [];
  const queries: Array<{ after: string | null; limit: number }> = [];
  const deps = {
    store,
    categories,
    emit: async (event: ChannelEvent) => {
      events.push(event);
    },
    fetchPage: async (query: { after: string | null; limit: number }) => {
      queries.push(query);
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return next;
    },
  };
  return { deps, events, queries, store };
}

describe("cursor feed", () => {
  test("first run takes the cursor and replays nothing", async () => {
    const h = harness([page([notification("old")], "c1")]);
    expect(await pollOnce(h.deps)).toEqual({ ok: true });
    expect(h.events).toHaveLength(0);
    expect(h.queries).toEqual([{ after: null, limit: 50 }]);
    expect(h.store.current.cursor).toBe("c1");
    expect(h.store.current.bootstrapped).toBe(true);
  });

  test("later polls use after=cursor, deliver oldest first, advance the cursor", async () => {
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      cursor: "c1",
    });
    const h = harness(
      [page([notification("a"), notification("b")], "c2")],
      store
    );
    await pollOnce(h.deps);
    expect(h.queries[0]).toEqual({ after: "c1", limit: 50 });
    expect(h.events.map((e) => e.meta.notification_id)).toEqual(["a", "b"]);
    expect(h.store.current.cursor).toBe("c2");
  });

  test("a restart catches up exactly once", async () => {
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      cursor: "c1",
    });
    await pollOnce(harness([page([notification("a")], "c2")], store).deps);
    // New process, same persisted state: the cursor already moved past `a`.
    const restarted = harness([page([], "c2")], store);
    await pollOnce(restarted.deps);
    expect(restarted.queries[0]?.after).toBe("c2");
    expect(restarted.events).toHaveLength(0);
  });

  test("a user and org twin of one run is delivered once", async () => {
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      cursor: "c1",
    });
    const h = harness(
      [page([notification("u1", "run_x"), notification("o1", "run_x")], "c2")],
      store
    );
    await pollOnce(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("categories outside the configured set advance the cursor silently", async () => {
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      cursor: "c1",
    });
    const h = harness(
      [page([notification("a", "run_a", "issues_detected")], "c2")],
      store,
      new Set(["audit_failed"])
    );
    await pollOnce(h.deps);
    expect(h.events).toHaveLength(0);
    expect(h.store.current.cursor).toBe("c2");
  });

  test("a full page is followed by another request", async () => {
    const full = Array.from({ length: 50 }, (_, i) => notification(`n${i}`));
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      cursor: "c1",
    });
    const h = harness(
      [page(full, "c2"), page([notification("last")], "c3")],
      store
    );
    await pollOnce(h.deps);
    expect(h.queries.map((q) => q.after)).toEqual(["c1", "c2"]);
    expect(h.events).toHaveLength(51);
  });

  test("HTTP errors are reported and leave state untouched", async () => {
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      cursor: "c1",
    });
    const h = harness([{ ok: false, status: 429 }], store);
    expect(await pollOnce(h.deps)).toEqual({ ok: false, status: 429 });
    expect(h.store.current.cursor).toBe("c1");
  });
});

describe("emit failures", () => {
  test("a throwing emit keeps the cursor and retries without repeating earlier rows", async () => {
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      cursor: "c1",
    });
    const rows = [notification("a"), notification("b"), notification("c")];
    const delivered: string[] = [];
    let failOnB = true;
    const deps = {
      store,
      categories: CATEGORIES,
      emit: async (event: ChannelEvent) => {
        if (event.meta.notification_id === "b" && failOnB)
          throw new Error("pipe closed");
        delivered.push(event.meta.notification_id ?? "");
      },
      fetchPage: async () => page(rows, "c2"),
    };
    await expect(pollOnce(deps)).rejects.toThrow("pipe closed");
    expect(store.current.cursor).toBe("c1");
    failOnB = false;
    await pollOnce(deps);
    expect(delivered).toEqual(["a", "b", "c"]);
    expect(store.current.cursor).toBe("c2");
  });

  test("an unchanged cursor on a full page does not refetch", async () => {
    const full = Array.from({ length: 50 }, (_, i) => notification(`n${i}`));
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      cursor: "c1",
    });
    const h = harness([page(full, "c1"), page(full, "c1")], store);
    await pollOnce(h.deps);
    expect(h.queries).toHaveLength(1);
  });
});

describe("legacy feed without next_cursor", () => {
  test("first run baselines the current page and delivers nothing", async () => {
    const h = harness([page([notification("b"), notification("a")])]);
    await pollOnce(h.deps);
    expect(h.events).toHaveLength(0);
    expect(h.store.current.cursor).toBeNull();
    expect(h.store.current.bootstrapped).toBe(true);
    expect(h.store.current.seen.length).toBeGreaterThan(0);
  });

  test("newest-first pages are de-duped by id and delivered oldest first", async () => {
    const h = harness([
      page([notification("b"), notification("a")]),
      page([
        notification("d"),
        notification("c"),
        notification("b"),
        notification("a"),
      ]),
      page([
        notification("d"),
        notification("c"),
        notification("b"),
        notification("a"),
      ]),
    ]);
    await pollOnce(h.deps);
    await pollOnce(h.deps);
    expect(h.events.map((e) => e.meta.notification_id)).toEqual(["c", "d"]);
    await pollOnce(h.deps);
    expect(h.events).toHaveLength(2);
    expect(h.queries.every((q) => q.after === null)).toBe(true);
  });

  test("the seen-set is bounded", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => notification(`n${i}`));
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      seen: Array.from({ length: MAX_SEEN_KEYS }, (_, i) => `id:old${i}`),
    });
    await pollOnce(harness([page(rows)], store).deps);
    expect(store.current.seen.length).toBe(MAX_SEEN_KEYS);
  });

  test("adopts a cursor once the server starts sending one", async () => {
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      seen: ["id:a"],
    });
    const h = harness(
      [page([notification("b"), notification("a")], "c9")],
      store
    );
    await pollOnce(h.deps);
    expect(h.events.map((e) => e.meta.notification_id)).toEqual(["b"]);
    expect(h.store.current.cursor).toBe("c9");
  });

  test("falls back when a cursor feed stops returning cursors", async () => {
    const store = memoryStore({
      ...emptyState(),
      bootstrapped: true,
      cursor: "c1",
    });
    const h = harness([page([]), page([notification("z")])], store);
    await pollOnce(h.deps);
    expect(h.queries.map((q) => q.after)).toEqual(["c1", null]);
    expect(h.events).toHaveLength(1);
    expect(h.store.current.cursor).toBeNull();
  });
});

describe("file state store", () => {
  test("keeps only the newest seen keys when a saved file is oversized", () => {
    const dir = mkdtempSync(join(tmpdir(), "channel-state-"));
    try {
      const keys = Array.from(
        { length: MAX_SEEN_KEYS + 20 },
        (_, i) => `id:${i}`
      );
      Bun.write(
        join(dir, "org_big.json"),
        JSON.stringify({
          version: 1,
          cursor: null,
          bootstrapped: true,
          seen: keys,
        })
      );
      const loaded = createFileStateStore("org_big", dir).load();
      expect(loaded.seen).toHaveLength(MAX_SEEN_KEYS);
      expect(loaded.seen.at(-1)).toBe(keys.at(-1));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips per org and tolerates a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "channel-state-"));
    try {
      const store = createFileStateStore("org_1", dir);
      expect(store.load()).toEqual(emptyState());
      store.save({
        ...emptyState(),
        bootstrapped: true,
        cursor: "c5",
        seen: ["id:a"],
      });
      expect(createFileStateStore("org_1", dir).load().cursor).toBe("c5");
      expect(createFileStateStore("org_2", dir).load().cursor).toBeNull();
      Bun.write(join(dir, "org_3.json"), "{not json");
      expect(createFileStateStore("org_3", dir).load()).toEqual(emptyState());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
