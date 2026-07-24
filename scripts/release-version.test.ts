// Locks `computeNextVersion` to release.yml's `Compute version` step, so the
// preflight (#495) can't silently drift from the version CI actually releases.
// Expectations mirror the workflow's promote(sed)/beta-bump/semver-inc logic.

import { describe, expect, test } from "bun:test";

import { computeNextVersion } from "./release";

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
