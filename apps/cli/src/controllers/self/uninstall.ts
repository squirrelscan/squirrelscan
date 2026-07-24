import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";

import { type Result, ok, err, commandError } from "@/controllers/types";
import { getSquirrelPaths, getSymlinkPath } from "@/self/paths";

export interface UninstallResult {
  symlink_removed: boolean;
  releases_removed: boolean;
  releases_count: number;
  releases_size_bytes: number;
  settings_removed: boolean;
}

export interface UninstallOptions {
  purge: boolean;
  force: boolean;
}

/**
 * Calculate total size of a directory recursively
 */
function getDirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;

  let size = 0;
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = `${dirPath}/${entry.name}`;
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      size += statSync(fullPath).size;
    }
  }

  return size;
}

/**
 * Count release versions
 */
function countReleases(releasesPath: string): number {
  if (!existsSync(releasesPath)) return 0;
  return readdirSync(releasesPath, { withFileTypes: true }).filter((e) =>
    e.isDirectory()
  ).length;
}

/**
 * Uninstall squirrel from the system
 */
export async function runSelfUninstall(
  options: UninstallOptions
): Promise<Result<UninstallResult>> {
  const paths = getSquirrelPaths();
  const symlinkPath = getSymlinkPath();

  const result: UninstallResult = {
    symlink_removed: false,
    releases_removed: false,
    releases_count: 0,
    releases_size_bytes: 0,
    settings_removed: false,
  };

  try {
    // Gather stats before removal
    result.releases_count = countReleases(paths.releases);
    result.releases_size_bytes = getDirSize(paths.data);

    // Remove symlink
    if (existsSync(symlinkPath)) {
      unlinkSync(symlinkPath);
      result.symlink_removed = true;
    }

    // Remove releases directory (all cached binaries)
    if (existsSync(paths.releases)) {
      rmSync(paths.releases, { recursive: true, force: true });
      result.releases_removed = true;
    }

    // Remove data directory if empty
    if (existsSync(paths.data)) {
      const remaining = readdirSync(paths.data);
      if (remaining.length === 0) {
        rmSync(paths.data, { recursive: true, force: true });
      }
    }

    // Purge user settings if requested
    if (options.purge && existsSync(paths.config)) {
      rmSync(paths.config, { recursive: true, force: true });
      result.settings_removed = true;
    }

    return ok(result);
  } catch (error) {
    return err(
      commandError(
        "UNINSTALL_FAILED",
        `Uninstall failed: ${(error as Error).message}`
      )
    );
  }
}
