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
