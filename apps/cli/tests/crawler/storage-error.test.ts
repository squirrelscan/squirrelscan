import { describe, expect, test } from "bun:test";

import { StorageError } from "../../src/crawler/storage/types";

describe("StorageError", () => {
  test("adds lock guidance for SQLite lock errors", () => {
    const err = StorageError.init("SQLiteError: database is locked");
    expect(err.message).toContain("SQLite database is busy (locked)");
    expect(err.message).toContain("running in parallel");
  });

  test("keeps standard formatting for non-lock errors", () => {
    const err = StorageError.read("permission denied");
    expect(err.message).toContain("Storage error during read");
    expect(err.message).toContain("permission denied");
  });
});

describe("a busy error names the file and the wait (#1226)", () => {
  test("the suffix the storage layer appends is read back", () => {
    const err = StorageError.write(
      new Error(
        "database is locked (database file: /home/a b/.squirrel/content-store.db, waited 15012 ms)"
      )
    );
    expect(err.message).toContain(
      "The database file /home/a b/.squirrel/content-store.db stayed locked for 15012 ms."
    );
  });

  test("a malformed or repeated marker is ignored, and cannot be made slow", () => {
    expect(
      StorageError.write(
        new Error("database is locked (database file: x, waited ")
      ).message
    ).not.toContain("stayed locked");
    const hostile = `database is locked ${"(database file: a".repeat(50_000)}`;
    const started = performance.now();
    StorageError.write(new Error(hostile));
    expect(performance.now() - started).toBeLessThan(500);
  });
});
