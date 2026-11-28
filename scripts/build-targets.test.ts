// Locks the Makefile's `build-all` targets: every x64 platform must compile
// with Bun's `-baseline` target (no AVX requirement), or the binary dies with
// an illegal instruction on older CPUs (#1562: darwin-x64, installer exit 132).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const makefile = readFileSync(join(import.meta.dir, "..", "Makefile"), "utf8");

const platforms = (makefile.match(/^PLATFORMS\s*:=\s*(.+)$/m)?.[1] ?? "").trim().split(/\s+/);

/** `case "$platform" in` arms: platform -> Bun target suffix. */
const targetOverrides = new Map<string, string>();
for (const m of makefile.matchAll(/^\s*([a-z0-9-]+)\) target="([a-z0-9-]+)";;/gm)) {
  targetOverrides.set(m[1] as string, m[2] as string);
}

describe("build-all targets", () => {
  test("PLATFORMS is parsed", () => {
    expect(platforms).toContain("darwin-x64");
    expect(platforms.length).toBeGreaterThanOrEqual(7);
  });

  const x64 = platforms.filter((p) => p.includes("x64"));
  for (const platform of x64) {
    test(`${platform} compiles with the baseline target`, () => {
      expect(targetOverrides.get(platform)).toBe(`${platform}-baseline`);
    });
  }

  test("arm64 platforms keep the plain target", () => {
    for (const platform of platforms.filter((p) => p.includes("arm64"))) {
      expect(targetOverrides.has(platform)).toBe(false);
    }
  });

  test("the output filename stays the platform name, not the baseline target", () => {
    expect(makefile).toContain("--outfile=build/squirrel-$(VERSION)-$$platform$$ext");
  });
});

describe("release flags (#1414)", () => {
  test("RELEASE_FLAGS carries minify and splitting", () => {
    const flags = makefile.match(/^RELEASE_FLAGS\s*:=((?:.*\\\n)*.*)$/m)?.[1] ?? "";
    expect(flags).toContain("--minify");
    expect(flags).toContain("--splitting");
    expect(flags).toContain("--compile");
  });

  test("build-all and build-ci both use RELEASE_FLAGS, with no inline flag copies", () => {
    const body = (name: string) =>
      makefile.match(new RegExp(`^${name}:.*\\n((?:\\t.*\\n?)+)`, "m"))?.[1] ?? "";
    expect(body("build-all")).toContain("$(RELEASE_FLAGS)");
    expect(body("build-ci")).toContain("$(RELEASE_FLAGS)");
    expect(body("build-all")).not.toContain("--minify");
    expect(body("build-ci")).not.toContain("--minify");
  });
});

describe("CI compiles with the release flags (#2313)", () => {
  const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
  // The `build:` job, up to the next top-level job key.
  const buildJob = workflow.match(/^ {2}build:\n((?: {4}.*\n|\s*\n)+)/m)?.[1] ?? "";
  const runs = [...buildJob.matchAll(/^\s+(?:- )?run:\s*(.+)$/gm)].map((m) => (m[1] as string).trim());

  test("the Compile CLI job is found", () => {
    expect(buildJob).toContain("name: Compile CLI");
  });

  test("it compiles with `make build-ci`, never the dev `bun run build`", () => {
    expect(runs).toContain("make build-ci");
    expect(runs).not.toContain("bun run build");
  });
});
