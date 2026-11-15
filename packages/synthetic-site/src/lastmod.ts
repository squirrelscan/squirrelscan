// Deterministic lastmod for the synthetic site. The canonical golden needs real lastmod values on
// the sitemap so crawl/sitemap-lastmod-churn and crawl/sitemap-lastmod-drift reach a non-skip verdict
// (repo#1668): a fixture with no lastmod makes both rules skip, and a byte-identity gate over a skip
// proves nothing.

import { hashString32 } from "./prng";

const DISTINCT_DAYS = 30;

/** A day-level lastmod for a path, spread over 30 days so the churn rule passes. */
export function lastmodForPath(path: string): string {
  const day = (hashString32(path) % DISTINCT_DAYS) + 1;
  return `2024-06-${String(day).padStart(2, "0")}`;
}

/**
 * One path in ten also names its own dateModified (matching its lastmod, so no drift), which gives
 * the drift rule comparable dates without adding a date signal to every page of the fixture.
 */
export function pageDateModified(path: string): string | null {
  return hashString32(`${path}#dated`) % 10 === 0 ? lastmodForPath(path) : null;
}
