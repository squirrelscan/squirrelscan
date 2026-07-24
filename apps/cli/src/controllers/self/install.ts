import {
  existsSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";

import type { InstallResult } from "@/self/types";

import { type Result, ok, err, commandError } from "@/controllers/types";
import {
  getSquirrelPaths,
  getReleasePath,
  getBinaryPath,
  getSymlinkPath,
  isBinInPath,
} from "@/self/paths";
import {
  loadUserSettings,
  saveSettings,
  DEFAULT_SETTINGS,
} from "@/self/settings";

export interface SelfInstallOptions {
  /** Custom bin directory for symlink (overrides default ~/.local/bin) */
  binDir?: string;
}

/**
 * Install squirrel from the currently running binary
 * This is used for self-bootstrap after curl install
 */
export async function runSelfInstall(
  version: string,
  options: SelfInstallOptions = {}
): Promise<Result<InstallResult>> {
  const paths = getSquirrelPaths();
  const releasePath = getReleasePath(version);
  const binaryPath = getBinaryPath(version);
  const symlinkPath = getSymlinkPath(options.binDir);

  try {
    // Create directories
    mkdirSync(releasePath, { recursive: true });
    mkdirSync(dirname(symlinkPath), { recursive: true });
    mkdirSync(paths.config, { recursive: true });

    // Copy current executable to release directory
    const currentExe = process.execPath;
    if (currentExe !== binaryPath) {
      copyFileSync(currentExe, binaryPath);
      chmodSync(binaryPath, 0o755);
    }

    // Create/update symlink
    if (existsSync(symlinkPath)) {
      unlinkSync(symlinkPath);
    }
    symlinkSync(binaryPath, symlinkPath);

    // Initialize settings — preserve anything already there (auth, telemetry
    // opt-out, channel); a reinstall/upgrade must never reset user state.
    const existing = loadUserSettings();
    const settingsResult = saveSettings({
      ...DEFAULT_SETTINGS,
      ...(existing.ok ? existing.data : {}),
      last_update_check: new Date().toISOString(),
      // Remember a custom bin dir so future updates flip the right symlink
      install_bin_dir: options.binDir ?? null,
    });

    if (!settingsResult.ok) {
      return settingsResult;
    }

    return ok({
      version,
      install_path: binaryPath,
      symlink_path: symlinkPath,
      bin_in_path: isBinInPath(options.binDir),
    });
  } catch (error) {
    return err(
      commandError(
        "INSTALL_FAILED",
        `Installation failed: ${(error as Error).message}`
      )
    );
  }
}
