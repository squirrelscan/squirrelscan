/**
 * bun.lock records each workspace's package.json `version`, but
 * `bun install --frozen-lockfile` does not compare it (Bun 1.4.4). A release
 * bump that moved apps/cli/package.json without bun.lock left the lock a
 * version behind, and the next unrelated `bun install` picked up the stray
 * hunk (#2247). These helpers stamp the lock alongside a bump and report drift.
 */
import { join } from "node:path";

export const LOCKFILE = "bun.lock";

interface Lockfile {
  workspaces?: Record<string, { name?: string; version?: string }>;
}

// Workspace path -> version recorded in bun.lock. The root workspace ("") and
// workspaces without a version are left out.
export function lockWorkspaceVersions(lockText: string): Map<string, string> {
  const lock = Bun.JSONC.parse(lockText) as Lockfile;
  const out = new Map<string, string>();
  for (const [path, entry] of Object.entries(lock.workspaces ?? {})) {
    if (path !== "" && typeof entry?.version === "string")
      out.set(path, entry.version);
  }
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Rewrite one workspace's `version` in bun.lock text. A text edit (not a JSON
// round trip) so the diff stays one line and bun's trailing-comma format holds.
// Throws when the workspace entry has no version line to rewrite.
export function stampLockVersion(
  lockText: string,
  workspace: string,
  version: string
): string {
  const entry = new RegExp(
    `(\\n    "${escapeRegExp(workspace)}": \\{\\n(?:      (?!"version")[^\\n]*\\n)*?      "version": ")[^"]*(")`
  );
  if (!entry.test(lockText)) {
    throw new Error(
      `${LOCKFILE} has no version line for workspace ${workspace}`
    );
  }
  return lockText.replace(
    entry,
    (_m, head: string, tail: string) => `${head}${version}${tail}`
  );
}

export interface VersionDrift {
  workspace: string;
  packageVersion: string | undefined;
  lockVersion: string | undefined;
}

// Every workspace in bun.lock whose recorded version disagrees with its
// package.json. A package.json that no longer exists is not drift here: bun
// install reports that itself.
export async function lockVersionDrift(root: string): Promise<VersionDrift[]> {
  const lockText = await Bun.file(join(root, LOCKFILE)).text();
  const lock = Bun.JSONC.parse(lockText) as Lockfile;
  const drift: VersionDrift[] = [];
  for (const [workspace, entry] of Object.entries(lock.workspaces ?? {})) {
    if (workspace === "") continue;
    const pkgFile = Bun.file(join(root, workspace, "package.json"));
    if (!(await pkgFile.exists())) continue;
    const pkg = JSON.parse(await pkgFile.text()) as { version?: unknown };
    const packageVersion =
      typeof pkg.version === "string" ? pkg.version : undefined;
    const lockVersion =
      typeof entry?.version === "string" ? entry.version : undefined;
    if (packageVersion !== lockVersion)
      drift.push({ workspace, packageVersion, lockVersion });
  }
  return drift;
}

export function describeDrift(d: VersionDrift): string {
  const show = (v: string | undefined) => v ?? "(none)";
  return `${d.workspace}: package.json ${show(d.packageVersion)}, ${LOCKFILE} ${show(d.lockVersion)}`;
}
