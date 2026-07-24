// #921 drift guard: every column any migration adds to `pages` must also be in
// PAGES_ALTER_COLUMNS, so a future `ALTER TABLE pages ADD COLUMN` can't silently
// reintroduce the migration-renumbering gap that made upsertPage throw when
// someone forgets to update the reconciler's self-heal list.
//
// (The zero-success circuit breaker itself is exercised end to end by the
// release-gating cloud e2e — its invalid-site case asserts a fast fail rather
// than a grind. A focused in-harness unit test hit an unrelated store-failure
// edge in the test harness; tracked as a follow-up.)

import { readFileSync } from "fs";
import { describe, expect, test } from "bun:test";

describe("PAGES_ALTER_COLUMNS drift guard (#921)", () => {
  test("every 'ALTER TABLE pages ADD COLUMN' in MIGRATIONS is in PAGES_ALTER_COLUMNS", () => {
    const src = readFileSync(new URL("../src/storage/sqlite.ts", import.meta.url), "utf8");

    // Columns that any migration adds to `pages`.
    const migrationCols = new Set<string>();
    for (const m of src.matchAll(/ALTER TABLE pages ADD COLUMN\s+(\w+)/g)) {
      migrationCols.add(m[1]!);
    }

    // Columns the reconciler self-heals (parsed from the PAGES_ALTER_COLUMNS literal).
    const listBlock = src.match(/PAGES_ALTER_COLUMNS[^[]*\[([\s\S]*?)\];/);
    expect(listBlock).not.toBeNull();
    const reconciledCols = new Set<string>();
    for (const m of listBlock![1]!.matchAll(/name:\s*"(\w+)"/g)) {
      reconciledCols.add(m[1]!);
    }

    expect(migrationCols.size).toBeGreaterThan(0);
    const missing = [...migrationCols].filter((c) => !reconciledCols.has(c));
    expect(missing).toEqual([]);
  });
});
