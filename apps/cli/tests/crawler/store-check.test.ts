// #403: the write probe behind `squirrel audit`'s local store check. Every
// case uses explicit scratch paths; nothing here resolves ~/.squirrel.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkStoreWritable,
  formatStoreProblems,
} from "@/crawler/storage/store-check";
import * as pathsModule from "@/self/paths";

const realPaths = pathsModule.getSquirrelPaths();

const scratch = mkdtempSync(join(tmpdir(), "squirrel-store-check-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// Permission bits do not bind root.
const asRoot = process.getuid?.() === 0;

describe("checkStoreWritable", () => {
  test("a writable store passes and the probe leaves nothing behind", () => {
    const path = join(scratch, "ok.db");
    const db = new Database(path);
    db.run("CREATE TABLE content (hash TEXT)");
    db.close();

    expect(checkStoreWritable(path)).toBeNull();

    const reopened = new Database(path);
    const tables = reopened
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    reopened.close();
    expect(tables.map((t) => t.name)).toEqual(["content"]);
  });

  test("a store that does not exist yet passes, creating its directory", () => {
    const path = join(scratch, "new", "nested", "store.db");
    expect(checkStoreWritable(path)).toBeNull();
    expect(statSync(join(scratch, "new", "nested")).isDirectory()).toBe(true);
  });

  test("a directory is named, and blamed on the env var it came from", () => {
    const path = join(scratch, "a-dir");
    mkdirSync(path);
    const problem = checkStoreWritable(path, "SQUIRREL_CONTENT_STORE_PATH");
    expect(problem?.path).toBe(path);
    expect(problem?.problem).toBe("is a directory, not a database file");
    expect(problem?.fix).toContain(
      "set SQUIRREL_CONTENT_STORE_PATH to a file path"
    );
  });

  test("a file that is not a database is named", () => {
    const path = join(scratch, "garbage.db");
    writeFileSync(
      path,
      "this is not a sqlite file, just some text that is long enough"
    );
    const problem = checkStoreWritable(path);
    expect(problem?.problem).toBe(
      "is not a readable SQLite database (it may be damaged)"
    );
    expect(problem?.fix).toContain("move it aside");
  });

  test.skipIf(asRoot)("a read-only file is named with a chmod fix", () => {
    const path = join(scratch, "read-only.db");
    new Database(path).close();
    chmodSync(path, 0o444);
    try {
      const problem = checkStoreWritable(path);
      expect(problem?.path).toBe(path);
      expect(problem?.problem).toBe("is read-only");
      // Outside ~/.squirrel the fix is the file alone, never recursive.
      expect(problem?.fix).toBe(`chmod u+w ${path}`);
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test.skipIf(asRoot)(
    "inside the squirrel data directory the fix covers the whole directory",
    () => {
      const data = join(scratch, "squirrel-data");
      mkdirSync(data);
      const spy = spyOn(pathsModule, "getSquirrelPaths").mockImplementation(
        () => ({ ...realPaths, data })
      );
      const path = join(data, "content-store.db");
      new Database(path).close();
      chmodSync(path, 0o444);
      try {
        const problem = checkStoreWritable(path);
        expect(problem?.problem).toBe("is read-only");
        expect(problem?.fix).toBe(`chmod -R u+w ${data}`);
      } finally {
        chmodSync(path, 0o644);
        spy.mockRestore();
      }
    }
  );

  test("a store another connection is writing to is busy, not broken", () => {
    const path = join(scratch, "busy.db");
    const holder = new Database(path);
    holder.run("PRAGMA journal_mode = WAL");
    holder.run("CREATE TABLE content (hash TEXT)");
    holder.run("BEGIN IMMEDIATE");
    holder.run("INSERT INTO content VALUES ('pending')");
    const started = performance.now();
    const problem = checkStoreWritable(path);
    const elapsed = performance.now() - started;
    holder.run("COMMIT");
    expect(problem).toBeNull();
    expect(elapsed).toBeLessThan(2_000);
    const rows = holder.query("SELECT hash FROM content").all();
    holder.close();
    expect(rows).toEqual([{ hash: "pending" }]);
  });

  test.skipIf(asRoot)(
    "a store in a read-only directory names the directory",
    () => {
      const dir = join(scratch, "locked-dir");
      mkdirSync(dir);
      chmodSync(dir, 0o555);
      try {
        const problem = checkStoreWritable(join(dir, "store.db"));
        expect(problem?.path).toBe(dir);
        expect(problem?.problem).toBe("is read-only");
      } finally {
        chmodSync(dir, 0o755);
      }
    }
  );

  test.skipIf(asRoot)(
    "a directory that cannot be created outside ~/.squirrel is named, not chowned",
    () => {
      const parent = join(scratch, "no-mkdir");
      mkdirSync(parent);
      chmodSync(parent, 0o555);
      try {
        const problem = checkStoreWritable(
          join(parent, "projects", "site", "store.db"),
          "SQUIRREL_CONTENT_STORE_PATH"
        );
        // Outside ~/.squirrel: name what is missing, and never suggest
        // changing a directory squirrel does not own.
        expect(problem?.path).toBe(join(parent, "projects", "site"));
        expect(problem?.problem).toBe(
          `does not exist and cannot be created (${parent} is not writable)`
        );
        expect(problem?.fix).toBe(
          "set SQUIRREL_CONTENT_STORE_PATH to a file in a directory you can write to"
        );
      } finally {
        chmodSync(parent, 0o755);
      }
    }
  );

  // The agent-sandbox case from the field: writes are denied by policy, not by
  // the permission bits, so access(2) answers EPERM rather than EACCES.
  test.skipIf(
    process.platform !== "darwin" || asRoot || !Bun.which("sandbox-exec")
  )("a store a sandbox blocks is blamed on the sandbox", () => {
    const dir = join(scratch, "sandboxed");
    mkdirSync(dir);
    const path = join(dir, "store.db");
    new Database(path).close();
    const realDir = Bun.spawnSync(["realpath", dir]).stdout.toString().trim();
    const script = `
        const { checkStoreWritable } = await import(${JSON.stringify(join(import.meta.dir, "../../src/crawler/storage/store-check.ts"))});
        console.log(JSON.stringify(checkStoreWritable(${JSON.stringify(path)})));
      `;
    const run = Bun.spawnSync(
      [
        "sandbox-exec",
        "-p",
        `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(realDir)}))`,
        process.execPath,
        "-e",
        script,
      ],
      { cwd: join(import.meta.dir, "../.."), env: { ...process.env } }
    );
    const problem = JSON.parse(
      run.stdout.toString().trim().split("\n").pop() ?? "null"
    );
    expect(problem?.problem).toStartWith(
      "is blocked by a sandbox or security policy"
    );
    expect(problem?.fix).toContain(
      "in the sandbox settings, or run the audit outside the sandbox"
    );
  });
});

describe("formatStoreProblems", () => {
  test("one line per distinct cause", () => {
    const blocked = {
      problem: "is read-only",
      fix: "chmod -R u+w ~/.squirrel",
    };
    const text = formatStoreProblems([
      { path: "/data/a/project.db", ...blocked },
      { path: "/data/a/content-store.db", ...blocked },
      {
        path: "/data/b",
        problem: "is a directory, not a database file",
        fix: "move it",
      },
    ]);
    expect(text.split("\n")).toEqual([
      "Cannot write to /data/a/project.db: it is read-only. Fix: chmod -R u+w ~/.squirrel",
      "Cannot write to /data/b: it is a directory, not a database file. Fix: move it",
    ]);
  });
});
