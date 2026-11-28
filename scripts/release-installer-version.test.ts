// release.yml records the installer version next to install.sh / install.ps1 in R2 (#1871).
// The installer worker (private repo, #1597) reads the sidecar key `installer-version.txt` and
// serves it as `x-squirrel-installer-version`; without it the header reads `unknown`. The key is a
// cross-repo contract, so it is spelled out here rather than imported.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

// The body of one step: from its `- name:` line to the next step or job.
function stepBody(name: string): string {
  const start = workflow.indexOf(`- name: ${name}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + 1);
  const end = rest.search(/\n {6}- (name|uses):|\n {2}[a-z][a-z0-9-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("release.yml installer version sidecar", () => {
  const publish = stepBody("Publish installers and channel metadata to R2");

  test("the publish step writes the release version to installer-version.txt", () => {
    expect(publish).toContain("VERSION: ${{ needs.version.outputs.version }}");
    expect(publish).toMatch(/printf '%s\\n' "\$VERSION" > installer-version\.txt/);
    expect(publish).toMatch(/\n\s*put installer-version\.txt installer-version\.txt /);
  });

  test("the sidecar is uploaded after both install scripts, in the same step", () => {
    const sh = publish.search(/\n\s*put install\.sh /);
    const ps1 = publish.search(/\n\s*put install\.ps1 /);
    const sidecar = publish.search(/\n\s*put installer-version\.txt /);
    expect(sh).toBeGreaterThanOrEqual(0);
    expect(ps1).toBeGreaterThanOrEqual(0);
    expect(sidecar).toBeGreaterThan(sh);
    expect(sidecar).toBeGreaterThan(ps1);
  });
});
