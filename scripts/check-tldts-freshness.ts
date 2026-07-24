#!/usr/bin/env bun
/**
 * Warn when the bundled tldts Public Suffix List snapshot is stale (#153).
 *
 * tldts (packages/rules/src/integrity/signals.ts) embeds a PSL snapshot frozen
 * at its publish time; integrity signals rely on it for eTLD+1 resolution.
 * There is no runtime PSL date, so we proxy freshness by the locked tldts
 * version's npm publish date. WARN-only — never fails CI (exit 0 always).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Warn after the snapshot is older than this many months.
const MAX_AGE_MONTHS = 6;
const AVG_MONTH_MS = (365.25 / 12) * 24 * 60 * 60 * 1000;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function emitWarning(msg: string): void {
  // GitHub Actions annotation in CI, plain prefix locally.
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=tldts PSL::${msg}` : `WARN: ${msg}`);
}

// Read the locked tldts version straight from bun.lock (no resolution needed).
async function lockedVersion(): Promise<string | null> {
  try {
    const lock = await Bun.file(join(repoRoot, "bun.lock")).text();
    return lock.match(/"tldts":\s*\["tldts@([\d.]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

// Fetch the npm publish date for a specific tldts version (15s network cap).
async function publishedAt(version: string): Promise<Date | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/tldts", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { time?: Record<string, string> };
    const stamp = data.time?.[version];
    return stamp ? new Date(stamp) : null;
  } catch {
    return null;
  }
}

const version = await lockedVersion();
if (!version) {
  emitWarning("could not read tldts version from bun.lock — skipping freshness check");
  process.exit(0);
}

const published = await publishedAt(version);
if (!published) {
  emitWarning(`could not fetch npm publish date for tldts@${version} — skipping freshness check`);
  process.exit(0);
}

const ageMonths = (Date.now() - published.getTime()) / AVG_MONTH_MS;
if (ageMonths > MAX_AGE_MONTHS) {
  emitWarning(
    `tldts@${version} (bundled PSL) was published ${ageMonths.toFixed(1)} months ago ` +
      `(> ${MAX_AGE_MONTHS}). Run \`bun update tldts\` to refresh the Public Suffix List snapshot.`,
  );
} else {
  console.log(
    `tldts@${version} PSL snapshot is fresh (${ageMonths.toFixed(1)} months old, threshold ${MAX_AGE_MONTHS}).`,
  );
}

process.exit(0);
