// The rules version for the per-page rule-result cache key: a hash of the source
// the page rules run, so a rule CODE change misses the cache even when the release
// version has not moved (a dev checkout, or any build before a version bump).
//
// The release version alone was not enough: a leaked-secrets precision fix changed
// `scanContent` and nothing else, and a re-audit of the same pages replayed the
// pre-fix findings until `--refresh` was passed. Only the code changed, so only a
// hash of the code can see it.
//
// It is evaluated by a Bun macro (`rules-version.ts`), so a compiled binary carries
// the hash of the tree it was built from and reads no source at runtime, while
// `bun run` from a checkout re-hashes the tree it is running.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What the hash covers, relative to the repo root: the rules, everything they
 * import from the workspace (parser, utils, core-contracts), the engine code that
 * produces the rest of a cached entry (page features and collected signals), and
 * the lockfile, because a `linkedom` upgrade changes what a rule sees without
 * changing a line of ours. Widening this is safe; a miss costs one cold run.
 */
export const RULES_FINGERPRINT_SOURCES = [
  "packages/rules/src",
  "packages/parser/src",
  "packages/utils/src",
  "packages/core-contracts/src",
  "packages/audit-engine/src",
  "bun.lock",
] as const;

/**
 * SHA-256 over every file under `sources`, path and bytes, in sorted path order.
 * A source that does not exist contributes its name and nothing else, so the
 * result is deterministic whatever the tree holds.
 */
export function fingerprintRuleSources(
  root: string,
  sources: readonly string[] = RULES_FINGERPRINT_SOURCES
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const source of sources) {
    hasher.update(`source\0${source}\0`);
    const path = join(root, source);
    if (!existsSync(path)) continue;
    if (statSync(path).isFile()) {
      hasher.update(readFileSync(path));
      continue;
    }
    const files = [
      ...new Bun.Glob("**/*").scanSync({ cwd: path, onlyFiles: true }),
    ]
      .map((rel) => rel.split("\\").join("/"))
      .sort();
    for (const rel of files) {
      hasher.update(`file\0${rel}\0`);
      hasher.update(readFileSync(join(path, rel)));
      hasher.update("\0");
    }
  }
  return hasher.digest("hex");
}

/** Macro entry point: the fingerprint of the repo this file sits in. */
export function rulesSourceFingerprint(): string {
  return fingerprintRuleSources(join(import.meta.dir, "../../../.."));
}
