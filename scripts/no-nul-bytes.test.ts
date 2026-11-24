// A raw NUL byte makes grep and rg skip a file as binary (repo#1565).
// The checker itself runs as a CI step; these tests pin its detection.

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNulFiles, isTextSource } from "./check-no-nul-bytes";

const dir = await mkdtemp(join(tmpdir(), "nul-bytes-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

test("flags a file with a raw NUL byte and passes one with the escape", async () => {
  await writeFile(join(dir, "raw.ts"), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(join(dir, "escaped.ts"), "const k = `a\\0b`;\n");
  expect(await findNulFiles(dir, ["raw.ts", "escaped.ts", "missing.ts"])).toEqual(["raw.ts"]);
});

test("only text source extensions are scanned", () => {
  expect(isTextSource("packages/rules/src/a.ts")).toBe(true);
  expect(isTextSource("assets/logo.png")).toBe(false);
});

// Repo-wide gate: runs in the `rest` suite, so CI fails on any tracked source
// file with a raw NUL without needing its own workflow step.
test("no tracked text source file contains a raw NUL byte", async () => {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "check-no-nul-bytes.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited, err).toBe(0);
}, 30_000);
