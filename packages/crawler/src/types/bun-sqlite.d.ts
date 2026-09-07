declare module "bun:sqlite" {
  interface SQLiteRunResult {
    changes: number;
    lastInsertRowid?: number | bigint;
  }

  interface SQLiteStatement {
    run(...params: unknown[]): SQLiteRunResult;
    get(...params: unknown[]): any;
    all(...params: unknown[]): any[];
    values(...params: unknown[]): unknown[][];
  }

  export class Database {
    constructor(path?: string, options?: unknown);
    run(sql: string, ...params: unknown[]): SQLiteRunResult;
    exec(sql: string): void;
    /**
     * Compile a statement and CACHE it on the Database, keyed by the SQL text:
     * the same SQL returns the same object rather than being re-parsed. Prefer
     * this over `prepare` on any statement a crawl runs more than a handful of
     * times. This overload was missing from this ambient declaration, which is
     * why the storage layer reached for `prepare` everywhere.
     */
    query(sql: string): SQLiteStatement;
    /** Compile a NEW statement every call. Use `query` in hot paths. */
    prepare(sql: string): SQLiteStatement;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
  }
}
