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
    prepare(sql: string): SQLiteStatement;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
  }
}
