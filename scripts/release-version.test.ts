// Locks `computeNextVersion` to release.yml's `Compute version` step, so the
// preflight (#495) can't silently drift from the version CI actually releases.
// Expectations mirror the workflow's promote(sed)/beta-bump/semver-inc logic.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeNextVersion,
  latestTaggedVersion,
  manifestsCarry,
  SYNCED_MANIFESTS,
} from "./release";

const cases: Array<{
  current: string;
  channel: "beta" | "stable";
  bump: "patch" | "minor" | "major" | "promote";
  expected: string;
}> = [
  // stable: semver inc
  { current: "0.0.60", channel: "stable", bump: "patch", expected: "0.0.61" },
  { current: "0.0.60", channel: "stable", bump: "minor", expected: "0.1.0" },
  { current: "0.0.60", channel: "stable", bump: "major", expected: "1.0.0" },
  // fresh beta from a release: semver pre-inc
  { current: "0.0.60", channel: "beta", bump: "patch", expected: "0.0.61-beta.0" },
  { current: "0.0.60", channel: "beta", bump: "minor", expected: "0.1.0-beta.0" },
  // existing beta: bump the suffix (bump type ignored, mirrors the workflow)
  { current: "0.0.56-beta.2", channel: "beta", bump: "patch", expected: "0.0.56-beta.3" },
  { current: "0.0.56-beta.2", channel: "beta", bump: "major", expected: "0.0.56-beta.3" },
  // promote: drop the prerelease suffix
  { current: "0.0.56-beta.2", channel: "stable", bump: "promote", expected: "0.0.56" },
  // alpha (unreachable today, but must stay aligned with release.yml's sed -E)
  { current: "1.2.3-alpha.0", channel: "stable", bump: "promote", expected: "1.2.3" },
  { current: "1.2.3-alpha.0", channel: "beta", bump: "patch", expected: "1.2.4-beta.0" },
  { current: "1.2.3-alpha.0", channel: "beta", bump: "minor", expected: "1.3.0-beta.0" },
];

describe("computeNextVersion mirrors release.yml", () => {
  for (const { current, channel, bump, expected } of cases) {
    test(`${current} ${channel}/${bump} -> ${expected}`, () => {
      expect(computeNextVersion(current, channel, bump)).toBe(expected);
    });
  }
});

describe("latestTaggedVersion", () => {
  test("uses the highest semantic version rather than the main manifest", () => {
    expect(latestTaggedVersion(["v0.0.79", "v0.1.0-beta.1", "not-a-version"], "0.0.1")).toBe(
      "0.1.0-beta.1",
    );
  });

  test("falls back when no release tags exist", () => {
    expect(latestTaggedVersion([], "0.0.1")).toBe("0.0.1");
  });
});

// This gate is what stops a release tagging a commit whose manifests still say
// the previous version — the drift that left main on 0.0.82 while v0.0.83 was
// the published release.
describe("manifestsCarry", () => {
  async function fixture(versions: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "release-manifests-"));
    for (const [rel, version] of Object.entries(versions)) {
      await Bun.write(join(root, rel), JSON.stringify({ version }) + "\n");
    }
    return root;
  }

  const all = (version: string) => Object.fromEntries(SYNCED_MANIFESTS.map((m) => [m, version]));

  test("true when every manifest is on the version", async () => {
    const root = await fixture(all("0.0.83"));
    expect(await manifestsCarry("0.0.83", root)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  test("false when the release version is not yet stamped", async () => {
    const root = await fixture(all("0.0.82"));
    expect(await manifestsCarry("0.0.83", root)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("false when only some manifests were bumped", async () => {
    const root = await fixture({ ...all("0.0.83"), "npm/package.json": "0.0.82" });
    expect(await manifestsCarry("0.0.83", root)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  // Skipping an absent manifest would let the release gate pass on a tree that
  // cannot carry a version at all.
  test("throws when a release manifest is missing rather than passing", async () => {
    const root = await fixture({ "apps/cli/package.json": "0.0.83" });
    await expect(manifestsCarry("0.0.83", root)).rejects.toThrow("npm/package.json");
    await rm(root, { recursive: true, force: true });
  });

  test("a missing manifest is reported even when another already disagrees", async () => {
    const root = await fixture({ "apps/cli/package.json": "0.0.82" });
    await expect(manifestsCarry("0.0.83", root)).rejects.toThrow(/missing/);
    await rm(root, { recursive: true, force: true });
  });

  test("server.json is not one of the synced manifests", () => {
    expect(SYNCED_MANIFESTS).not.toContain("server.json");
  });
});
