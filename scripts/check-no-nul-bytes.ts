// Fails when a tracked text source file contains a NUL byte (repo#1565).
// A raw 0x00 makes grep and rg treat the whole file as binary and skip it
// silently. Write the escape `\0` in source instead of the raw byte.
//
// Usage: bun run scripts/check-no-nul-bytes.ts

import { join } from "node:path";

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|yml|yaml|sh|ps1|toml|css|html|astro|txt|svg|py)$/;

/** Tracked text files under `root` that contain a raw NUL byte, repo-relative. */
export async function findNulFiles(root: string, files: string[]): Promise<string[]> {
  const offenders: string[] = [];
  for (const f of files) {
    const file = Bun.file(join(root, f));
    if (!(await file.exists())) continue;
    if ((await file.bytes()).includes(0)) offenders.push(f);
  }
  return offenders;
}

export function isTextSource(path: string): boolean {
  return TEXT_EXT.test(path);
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const proc = Bun.spawn(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe" });
  const files = (await new Response(proc.stdout).text()).split("\0").filter(isTextSource);
  await proc.exited;

  if (files.length === 0) {
    console.error("check-no-nul-bytes: git ls-files returned no text files, refusing to pass");
    process.exit(1);
  }

  const offenders = await findNulFiles(root, files);
  if (offenders.length > 0) {
    console.error("Tracked source files contain a raw NUL byte (grep and rg skip them as binary):");
    for (const f of offenders) console.error(`  ${f}`);
    console.error("Replace each raw NUL with the escape sequence \\0 in source.");
    process.exit(1);
  }
  console.log(`check-no-nul-bytes: ${files.length} text files clean`);
}
