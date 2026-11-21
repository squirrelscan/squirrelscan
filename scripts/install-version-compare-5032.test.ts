// install.sh's version comparison and signed-era decision (squirrelscan/repo#5032),
// run by real bash against the table shared with install.ps1 and the updater
// (scripts/fixtures/version-compare.json). The functions are cut out of
// install.sh itself, so what is tested is what ships.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url).pathname;
const installSh = readFileSync(`${root}install.sh`, "utf8");
const fixture = JSON.parse(readFileSync(`${root}scripts/fixtures/version-compare.json`, "utf8")) as {
  compare: { a: string; b: string; cmp: number }[];
  era: { first: string; version: string; era: boolean }[];
};

const validStart = installSh.indexOf("valid_release_version() {");
const validEnd = installSh.indexOf("\n}\n", validStart) + 3;
const start = installSh.indexOf("num_cmp() {");
const end = installSh.indexOf("signed_era_fail() {");
const library = `${installSh.slice(validStart, validEnd)}\n${installSh.slice(start, end)}`;

function bash(script: string): string {
  const out = Bun.spawnSync(["bash", "-c", `set -u\n${library}\n${script}`], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return out.stdout.toString();
}
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

describe("install.sh version comparison (repo#5032)", () => {
  test("the library was cut out of install.sh", () => {
    expect(validStart).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(0);
    expect(library).toContain("valid_release_version()");
    expect(library).toContain("version_cmp()");
    expect(library).toContain("release_signed_era()");
  });

  test("version_cmp matches the shared table", () => {
    const script = fixture.compare.map((c) => `echo "$(version_cmp ${q(c.a)} ${q(c.b)})"`).join("\n");
    const got = bash(script).trim().split("\n").map(Number);
    expect(got).toEqual(fixture.compare.map((c) => c.cmp));
  });

  test("release_signed_era matches the shared table", () => {
    const script = fixture.era
      .map((c) => `RELEASE_FIRST_SIGNED_VERSION=${q(c.first)}; if release_signed_era ${q(c.version)}; then echo true; else echo false; fi`)
      .join("\n");
    const got = bash(script).trim().split("\n");
    expect(got).toEqual(fixture.era.map((c) => String(c.era)));
  });
});
