import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Public copy rule: no em dash (U+2014) in anything the CLI or a rule prints.
// Bun.Transpiler drops comments, so only code, string and template literals
// are checked. Where the character is functionally needed (title-separator
// regexes, HTML entity tables), spell it as the escape sequence so the source stays clean.
const EM_DASH = String.fromCodePoint(0x2014);
const ESCAPED = String.raw`\u2014`;
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const ROOTS = ["apps/cli/src", "packages"];

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of ROOTS) {
    const glob = new Glob("**/*.{ts,tsx}");
    for await (const rel of glob.scan({ cwd: join(REPO_ROOT, root) })) {
      if (
        /(^|\/)(node_modules|dist|tests?)\//.test(rel) ||
        rel.endsWith(".test.ts")
      )
        continue;
      files.push(join(REPO_ROOT, root, rel));
    }
  }
  return files.sort();
}

describe("no em dash in CLI and rule output", () => {
  test("no source file carries a literal em dash outside comments", async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await Bun.file(file).text();
      if (!text.includes(EM_DASH)) continue;
      const loader = file.endsWith("x") ? "tsx" : "ts";
      const js = new Bun.Transpiler({ loader }).transformSync(
        text.replaceAll(ESCAPED, "\\uE000")
      );
      for (const [i, line] of js.split("\n").entries()) {
        if (line.includes(EM_DASH))
          offenders.push(
            `${file.slice(REPO_ROOT.length + 1)} (js line ${i + 1}): ${line.trim().slice(0, 100)}`
          );
      }
    }
    expect(offenders).toEqual([]);
  }, 30_000);

  test("the guard detects an em dash in a string literal and ignores comments", () => {
    const tr = new Bun.Transpiler({ loader: "ts" });
    expect(tr.transformSync(`const m = "a ${EM_DASH} b";`)).toContain(EM_DASH);
    expect(
      tr.transformSync(`// a ${EM_DASH} b\nconst m = "ok";`)
    ).not.toContain(EM_DASH);
  });
});
