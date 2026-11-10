// One store-integrity answer for every reader of a stored audit (#1667).

import { describe, expect, test } from "bun:test";

import {
  deriveStoreIntegrity,
  formatEvictedPagesNotice,
  readStoreIntegrity,
} from "@/crawler/storage/eviction-notice";

describe("deriveStoreIntegrity", () => {
  const table: Array<[string, { evicted: number; stored: number }, unknown]> = [
    ["nothing stored", { evicted: 0, stored: 0 }, { status: "full" }],
    ["every body present", { evicted: 0, stored: 40 }, { status: "full" }],
    [
      "one body gone",
      { evicted: 1, stored: 40 },
      { status: "evicted", evicted: 1, stored: 40 },
    ],
    [
      "every body gone",
      { evicted: 40, stored: 40 },
      { status: "evicted", evicted: 40, stored: 40 },
    ],
  ];
  for (const [name, counts, expected] of table) {
    test(name, () => {
      expect(deriveStoreIntegrity(counts)).toEqual(
        expected as ReturnType<typeof deriveStoreIntegrity>
      );
    });
  }
});

describe("the read notice", () => {
  const base = { evicted: 3, stored: 10, capBytes: 1024 * 1024 * 1024 };

  test("says how many of how many, and what is and is not affected", () => {
    const text = formatEvictedPagesNotice({ kind: "read", ...base });
    expect(text).toContain(
      "3 of 10 pages stored for this audit are no longer in the local content store"
    );
    expect(text).toContain("does not read their HTML");
    expect(text).toContain("content_store_max_bytes");
  });

  test("a single page is singular", () => {
    expect(
      formatEvictedPagesNotice({
        kind: "read",
        evicted: 1,
        stored: 1,
        capBytes: 1,
      })
    ).toContain("1 of 1 page stored");
  });

  test("the report notice keeps its own wording", () => {
    expect(formatEvictedPagesNotice({ kind: "report", ...base })).toContain(
      "Findings are unaffected"
    );
  });
});

describe("readStoreIntegrity", () => {
  test("a store that is not the SQLite one reads as full, never as an error", async () => {
    expect(await readStoreIntegrity({} as never, "crawl")).toEqual({
      status: "full",
    });
  });
});
