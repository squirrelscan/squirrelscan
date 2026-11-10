import { mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

import type { InstallResult } from "@/self/types";
import type { UserSettings } from "@/self/types";

import { type Result, ok, err, commandError } from "@/controllers/types";
import { readInstallSourceEnv, readPathSetupEnv } from "@/self/install-meta";
import { linkBinary, unlinkIfPresent } from "@/self/link-binary";
import {
  getSquirrelPaths,
  getReleasePath,
  getBinaryPath,
  getSymlinkPath,
  isBinInPath,
} from "@/self/paths";
import {
  saveSettings,
  updateSettingsWith,
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

    // Create/update symlink (a copy on Windows, where symlinks need privilege).
    // unlinkIfPresent, not an existsSync guard: existsSync follows the link, so
    // a dangling one survived the guard and made linkBinary throw EEXIST.
    unlinkIfPresent(symlinkPath);
    linkBinary(binaryPath, symlinkPath);

    // Initialize settings — preserve anything already there (auth, telemetry
    // opt-out, channel); a reinstall/upgrade must never reset user state.
    // Under the settings lock (#1660): an auto-updater or a login running at the same time keeps its keys.
    const patch = (existing: Partial<UserSettings>): Partial<UserSettings> => ({
      last_update_check: new Date().toISOString(),
      // Remember a custom bin dir so future updates flip the right symlink
      install_bin_dir: options.binDir ?? null,
      // Registration runs on the next command, where the env var is gone.
      // Persist a valid stamp; keep any earlier one when this run has none.
      install_source: readInstallSourceEnv() ?? existing.install_source ?? null,
      path_setup: readPathSetupEnv() ?? existing.path_setup ?? null,
    });
    let settingsResult: Result<unknown> = updateSettingsWith(patch);
    if (!settingsResult.ok) {
      // Settings that cannot be read (corrupt) are reset to defaults by an install, as before.
      settingsResult = saveSettings({ ...DEFAULT_SETTINGS, ...patch({}) });
    }

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
