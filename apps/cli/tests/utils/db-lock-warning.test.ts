import { describe, expect, test } from "bun:test";

import {
  isDatabaseLockMessage,
  getDatabaseLockWarning,
} from "../../src/cli/db-lock-warning";

describe("isDatabaseLockMessage", () => {
  test("detects SQLite lock messages", () => {
    expect(
      isDatabaseLockMessage(
        "Storage error during init: SQLiteError: database is locked"
      )
    ).toBe(true);
    expect(isDatabaseLockMessage("SQLITE_BUSY: database table is locked")).toBe(
      true
    );
  });

  test("does not match unrelated errors", () => {
    expect(isDatabaseLockMessage("Failed to parse config file")).toBe(false);
  });
});

describe("getDatabaseLockWarning", () => {
  test("returns user guidance for parallel commands", () => {
    const warning = getDatabaseLockWarning();
    expect(warning).toContain("Another SquirrelScan process");
    expect(warning).toContain("parallel");
  });
});
