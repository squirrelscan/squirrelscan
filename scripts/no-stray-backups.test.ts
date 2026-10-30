// A `sed -i -E ...` on macOS leaves `<file>-E` behind; two of them were committed (#1372).
// No tracked file may be an editor or tool backup.

import { expect, test } from "bun:test";
import { join } from "node:path";

test("no tracked file is a sed, patch or editor backup", async () => {
  const proc = Bun.spawn(["git", "ls-files"], { cwd: join(import.meta.dir, ".."), stdout: "pipe" });
  const files = (await new Response(proc.stdout).text()).split("\n").filter(Boolean);
  await proc.exited;
  // `-E` is the suffix BSD sed gives a backup when `-i -E` is typed.
  expect(files.filter((f) => /(-E|\.orig|\.bak|\.rej)$/.test(f))).toEqual([]);
});
