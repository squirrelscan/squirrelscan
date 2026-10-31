// The release gate's skills install step (#1367) embeds scripts/skills-install-fixture-check.py in every
// platform job of test-install.yml, because the release path has no repository checkout. This keeps the
// copies identical to the script and the step present in all five jobs.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const workflow = readFileSync(join(root, ".github/workflows/test-install.yml"), "utf8");
const script = readFileSync(join(root, "scripts/skills-install-fixture-check.py"), "utf8").trimEnd();

/** The text between a heredoc or here-string opener and its closer, de-indented by the step's 10 spaces. */
function embedded(start: string, end: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const open = workflow.indexOf(start, at);
    if (open === -1) return out;
    const from = workflow.indexOf("\n", open) + 1;
    const to = workflow.indexOf(`\n${" ".repeat(10)}${end}`, from);
    if (to === -1) throw new Error(`no closer ${end} after ${start}`);
    out.push(
      workflow
        .slice(from, to)
        .split("\n")
        .map((l) => l.slice(10))
        .join("\n"),
    );
    at = to + 1;
  }
}

test("every platform job installs skills from a local fixture server, with the same script", () => {
  const names = workflow.match(/- name: Install skills from a local fixture server/g) ?? [];
  expect(names).toHaveLength(5);
  const unix = embedded("<<'PY'", "PY\n");
  const windows = embedded("@'\n          \"\"\"Release gate", `'@ | Set-Content -Path "$work\\check.py"`);
  expect(unix).toHaveLength(4);
  for (const copy of unix) expect(copy).toBe(script);
  expect(windows).toHaveLength(1);
  expect(windows[0]).toBe(script);
});

test("the gate points every proxy variable at a dead port and never at GitHub", () => {
  expect(script).toContain("SQUIRREL_SKILLS_TEST_SOURCE");
  expect(script).toContain('dead_proxy = "http://127.0.0.1:9"');
  expect(script).not.toMatch(/github\.com|githubusercontent/);
});
