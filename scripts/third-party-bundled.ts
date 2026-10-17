// Packages a dependency ships INSIDE its own files, for
// scripts/generate-third-party-notices.ts. Split out so the scan and its guard
// can be tested on a fixture directory without running the whole generator.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `@modelcontextprotocol/server` bundles ajv 8 and friends into its dist, so
 * they reach the CLI binary without ever appearing in the dependency walk
 * (#570). Their bundler leaves the source path in region comments
 * (`node_modules/.pnpm/ajv@8.18.0/node_modules/ajv/...`), which is how they are
 * found.
 */
const BUNDLED_SOURCE = /node_modules\/\.pnpm\/((?:@[^/+]+\+)?[^/@]+)@(\d[^/_]*)/g;

/** `name@version` of every package whose bundler marker appears in `directory`'s JS. */
export function bundledPackages(directory: string): Set<string> {
  const found = new Set<string>();
  for (const file of new Bun.Glob("**/*.{js,mjs,cjs}").scanSync(directory)) {
    if (file.includes("node_modules/")) continue;
    let text: string;
    try {
      text = readFileSync(join(directory, file), "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(BUNDLED_SOURCE)) {
      found.add(`${match[1]!.replace("+", "/")}@${match[2]}`);
    }
  }
  return found;
}

/**
 * Runtime dependencies known to bundle packages (#657). If one of these yields
 * nothing from the scan, a release changed or stripped the markers, and the
 * packages it bundles would drop out of THIRD_PARTY_NOTICES.md with no error.
 */
export const KNOWN_BUNDLERS: ReadonlySet<string> = new Set(["@modelcontextprotocol/server"]);

/** Whether a dependency is a known bundler whose scan found nothing. */
export function isSilentBundler(name: string, bundled: ReadonlySet<string>): boolean {
  return KNOWN_BUNDLERS.has(name) && bundled.size === 0;
}

/** The error for known bundlers whose scan found nothing, or null when there are none. */
export function silentBundlerError(ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  return [
    "A dependency known to bundle packages yielded none from the marker scan:",
    ...[...ids].sort().map((id) => `  ${id}`),
    "Its bundler may have changed or stripped the `node_modules/.pnpm/<name>@<version>` markers the scan reads.",
    "Check its dist for the bundled packages by hand, then update the scan in scripts/third-party-bundled.ts or the license texts under scripts/third-party-embedded/.",
  ].join("\n");
}
