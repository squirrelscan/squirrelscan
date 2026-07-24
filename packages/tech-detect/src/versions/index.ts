// Software-version security advisories — SCAFFOLD ONLY.
//
// Maps detected (technology, version) pairs to known outdated / end-of-life /
// vulnerable releases. Today it returns [] — no advisory dataset is wired yet.
// The shape + call sites exist so the data layer (endoflife.date, retire.js,
// OSV.dev snapshots) can be dropped in later without changing the API surface.
//
// See plans/technology-version-security.md for the full build sequence.

import type { SoftwareAdvisory } from "@squirrelscan/core-contracts";
import type { DetectedTechnology } from "../types";

export type { SoftwareAdvisory };

/**
 * Returns version advisories for the detected stack.
 *
 * STUB: always returns an empty array. When implemented it will semver-compare
 * each tech's resolved `version` against a cached advisory dataset and emit
 * `SoftwareAdvisory` records. Detections without a resolved version are skipped.
 */
export function checkVersionAdvisories(
  _detected: DetectedTechnology[],
): SoftwareAdvisory[] {
  return [];
}
