// Opening a SQLite database that several squirrel processes share (#1226).
//
// The content store, the link cache and each project database live on disk and
// are opened by every `squirrel` process at once in a batch of audits. SQLite's
// default busy timeout is 0, so any statement that needs a lock while another
// process holds it fails at once with SQLITE_BUSY. Two things follow:
//
//  - `busy_timeout` is the FIRST statement on a connection. The first pragmas
//    that follow (`journal_mode = WAL`, on a fresh file) and the schema need a
//    lock, and ran with no timeout when it was set after them.
//  - Write transactions are IMMEDIATE. A deferred one reads under a snapshot
//    and then fails with SQLITE_BUSY_SNAPSHOT when it upgrades to a write after
//    another process committed, and the busy handler never retries that; taking
//    the write lock first makes it wait, under the timeout, instead.
//
// A lock that is still not free after the timeout is reported with the file and
// how long it waited, so the error names what was busy.

import { Database } from "bun:sqlite";

export const SQLITE_BUSY_TIMEOUT_MS = 15000;

const BUSY = /database is locked|database table is locked|sqlite_busy|sqlite_locked/i;

/** The suffix a busy error carries: which file, and how long the wait was. */
export const BUSY_DETAIL = /\(database file: (.+), waited (\d+) ms\)/;

function describeBusy(error: unknown, path: string, startedAt: number): unknown {
  if (!(error instanceof Error) || !BUSY.test(error.message) || BUSY_DETAIL.test(error.message)) {
    return error;
  }
  const waited = Math.round(performance.now() - startedAt);
  const described = new Error(`${error.message} (database file: ${path}, waited ${waited} ms)`, {
    cause: error,
  });
  described.name = error.name;
  for (const key of ["code", "errno", "byteOffset"] as const) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (value !== undefined) (described as unknown as Record<string, unknown>)[key] = value;
  }
  return described;
}

function guard<A extends unknown[], R>(path: string, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const startedAt = performance.now();
    try {
      return fn(...args);
    } catch (error) {
      throw describeBusy(error, path, startedAt);
    }
  };
}

type Statement = { run: unknown; get: unknown; all: unknown; values: unknown };

function guardStatement<S extends Statement>(path: string, statement: S): S {
  const wrapped = Object.create(statement) as S;
  for (const method of ["run", "get", "all", "values"] as const) {
    const original = (statement as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof original === "function") {
      (wrapped as unknown as Record<string, unknown>)[method] = guard(path, original.bind(statement));
    }
  }
  return wrapped;
}

/**
 * Open `path` ready for concurrent use. Returns the ordinary `Database`, with
 * `busy_timeout` set first, `transaction()` taking the write lock up front, and
 * busy errors naming the file and the wait.
 */
export function openSqlite(path: string, busyTimeoutMs: number = SQLITE_BUSY_TIMEOUT_MS): Database {
  const db = new Database(path);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);

  const target = db as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ["exec", "run"] as const) {
    target[method] = guard(path, target[method]!.bind(db));
  }
  for (const method of ["prepare", "query"] as const) {
    const original = target[method]!.bind(db);
    target[method] = (...args: unknown[]) =>
      guardStatement(path, original(...args) as Statement);
  }
  const transaction = target.transaction!.bind(db);
  target.transaction = (fn: unknown) => {
    const txn = transaction(fn) as {
      (...args: unknown[]): unknown;
      deferred: unknown;
      immediate: (...args: unknown[]) => unknown;
      exclusive: unknown;
    };
    const immediate = guard(path, txn.immediate);
    return Object.assign((...args: unknown[]) => immediate(...args), {
      deferred: txn.deferred,
      immediate,
      exclusive: txn.exclusive,
    });
  };
  return db;
}

/**
 * Switch the database to WAL, waiting for a lock instead of failing.
 *
 * Changing the journal mode of a fresh file needs a lock that SQLite does not
 * run the busy handler for: with several processes creating the same database,
 * all but one get SQLITE_BUSY at once however long `busy_timeout` is. So the
 * pragma is retried here, with a short jittered pause, until `timeoutMs` is
 * spent. A database that is already WAL answers without a lock, the common case.
 */
export function enableWal(db: Database, timeoutMs: number = SQLITE_BUSY_TIMEOUT_MS): void {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!(error instanceof Error) || !BUSY.test(error.message) || performance.now() >= deadline) {
        throw error;
      }
      Bun.sleepSync(5 + Math.random() * 20);
    }
  }
}
