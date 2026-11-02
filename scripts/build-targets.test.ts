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
