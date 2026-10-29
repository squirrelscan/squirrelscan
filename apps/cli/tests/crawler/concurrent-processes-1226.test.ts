// #1226: several `squirrel` processes sharing the machine-wide stores and a
// project database must not fail with "SQLite database is busy (locked)".
// N real processes, released by one start file so they open fresh connections
// together; the assertion is only that every one finishes, so nothing here
// depends on timing.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const worker = join(import.meta.dir, "../helpers/concurrent-store-worker.ts");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function round(
  processes: number
): Promise<{ code: number; out: string; err: string }[]> {
  const dir = mkdtempSync(join(tmpdir(), "squirrel-concurrent-"));
  roots.push(dir);
  const startFile = join(dir, "go");
  const procs = Array.from({ length: processes }, (_, i) =>
    Bun.spawn([process.execPath, "run", worker, dir, String(i), startFile], {
      stdout: "pipe",
      stderr: "pipe",
    })
  );
  // Let every process reach the barrier, then release them together.
  await Bun.sleep(1500);
  writeFileSync(startFile, "");
  return Promise.all(
    procs.map(async (proc) => {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, out, err };
    })
  );
}

describe("concurrent processes on one set of stores", () => {
  test("8 processes opening and writing at once all finish", async () => {
    for (let r = 0; r < 3; r++) {
      const results = await round(8);
      const failed = results.filter(
        (x) => x.code !== 0 || !x.out.includes("ok")
      );
      expect(failed.map((x) => x.err.slice(-1500))).toEqual([]);
    }
  }, 120_000);
});
