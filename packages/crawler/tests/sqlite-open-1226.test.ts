// #1226: busy_timeout comes first, write transactions take the lock up front,
// and a lock that outlasts the timeout names the file and the wait.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enableWal, openSqlite } from "../src/storage/sqlite-open";

const dir = mkdtempSync(join(tmpdir(), "squirrel-sqlite-open-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("openSqlite", () => {
  test("busy_timeout is set on the connection before anything else runs", () => {
    const db = openSqlite(join(dir, "a.db"), 1234);
    expect((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(1234);
    db.close();
  });

  test("a lock held past the timeout is reported with the file and the wait", () => {
    const file = join(dir, "held.db");
    const holder = new Database(file);
    holder.exec("PRAGMA journal_mode = WAL");
    holder.exec("CREATE TABLE t (x)");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO t VALUES (1)");

    const db = openSqlite(file, 200);
    let message = "";
    try {
      db.transaction(() => db.exec("INSERT INTO t VALUES (2)"))();
    } catch (error) {
      message = (error as Error).message;
    }
    holder.exec("ROLLBACK");
    holder.close();
    db.close();

    expect(message).toMatch(/locked/);
    expect(message).toContain(`database file: ${file}`);
    expect(message).toMatch(/waited \d+ ms/);
  });

  test("a write transaction waits for another process's write lock and then commits", async () => {
    const file = join(dir, "wait.db");
    const setup = new Database(file);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.exec("CREATE TABLE t (x)");
    setup.close();

    // Another process takes the write lock, says so, holds it for a moment.
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { Database } from "bun:sqlite";
         const db = new Database(${JSON.stringify(file)});
         db.exec("BEGIN IMMEDIATE"); db.exec("INSERT INTO t VALUES (1)");
         console.log("locked"); await Bun.sleep(600); db.exec("COMMIT");`,
      ],
      { stdout: "pipe", stderr: "ignore" }
    );
    const reader = holder.stdout.getReader();
    await reader.read(); // "locked"

    const db = openSqlite(file, 10_000);
    // Reads first, then writes: deferred, this is the shape that fails at once
    // with SQLITE_BUSY_SNAPSHOT once the holder commits in between.
    db.transaction(() => {
      db.query("SELECT count(*) AS n FROM t").get();
      db.exec("INSERT INTO t VALUES (2)");
    })();
    await holder.exited;

    expect((db.query("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(2);
    db.close();
  });

  test("enableWal waits out a lock that the busy handler ignores", () => {
    const file = join(dir, "wal.db");
    const db = openSqlite(file, 1000);
    enableWal(db);
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    db.close();
  });
});
