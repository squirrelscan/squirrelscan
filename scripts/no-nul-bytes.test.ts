// A raw NUL byte makes grep and rg skip a file as binary (#1565).
// Runs in CI through the scripts test suite; see check-no-nul-bytes.ts.

import { expect, test } from "bun:test";
import { join } from "node:path";

test("no tracked text source file contains a raw NUL byte", async () => {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "check-no-nul-bytes.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited, err).toBe(0);
}, 30_000);
