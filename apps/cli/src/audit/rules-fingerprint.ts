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

import { readFileSync } from "node:fs";
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
 * Test files are skipped: they never reach a rule's output, and editing one must
 * not cost a cold run. A source that does not exist contributes its name and
 * nothing else, so the result is deterministic whatever the tree holds, unless
 * `strict` is set, which throws instead: a build that cannot see a source would
 * ship a hash that no longer tracks code changes.
 */
export function fingerprintRuleSources(
  root: string,
  sources: readonly string[] = RULES_FINGERPRINT_SOURCES,
  { strict = false }: { strict?: boolean } = {}
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const source of sources) {
    hasher.update(`source\0${source}\0`);
    const path = join(root, source);
    // Read first and classify by the error, so there is no check-then-use gap:
    // a file reads, a directory fails EISDIR, a missing source fails ENOENT.
    try {
      hasher.update(readFileSync(path));
      continue;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EISDIR") {
        if (strict) {
          throw new Error(`rules fingerprint: source not found: ${path}`);
        }
        continue;
      }
    }
    const files = [
      ...new Bun.Glob("**/*").scanSync({ cwd: path, onlyFiles: true }),
    ]
      .map((rel) => rel.split("\\").join("/"))
      .filter((rel) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel))
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
  return fingerprintRuleSources(
    join(import.meta.dir, "../../../.."),
    RULES_FINGERPRINT_SOURCES,
    { strict: true }
  );
}
