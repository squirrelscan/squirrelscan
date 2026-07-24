import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
} from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

import { type Result, ok } from "@/controllers/types";

import type { DoctorCheck, DoctorReport } from "./types";

import { version } from "../../package.json";
import { updateSuppressedReason } from "./install-meta";
import {
  findLocalSettingsPath,
  getSquirrelPaths,
  getSymlinkPath,
  getBinaryPath,
  getSettingsPath,
  getLogsPath,
  getUnmanagedUpdateHint,
  isManagedInstall,
} from "./paths";
import {
  loadSettings,
  loadUserSettings,
  DEFAULT_UPDATE_CHECK_INTERVAL_HOURS,
} from "./settings";

export function runDoctorChecks(): Result<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(checkSettingsFile());
  checks.push(checkSymlink());
  checks.push(checkBinaryExecutable());
  checks.push(checkPathEnv());
  checks.push(checkReleasesDir());
  checks.push(checkUpdateStatus());
  checks.push(checkLogging());

  const passed = checks.filter((c) => c.status === "pass").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  return ok({ checks, passed, warnings, failed });
}

// deps injectable for tests only (#1037-style seam) — production callers omit.
export function checkSettingsFile(
  deps: {
    loadUser?: typeof loadUserSettings;
    findLocal?: typeof findLocalSettingsPath;
    settingsPath?: string;
  } = {}
): DoctorCheck {
  const path = deps.settingsPath ?? getSettingsPath();
  // User settings only: the merged load walks the cwd for local settings,
  // and an unreadable cwd ancestor (EACCES) would misread as a corrupt
  // ~/.squirrel/settings.json with a delete-it fix hint (broke the v0.0.74
  // install-test running doctor from another user's checkout).
  const result = (deps.loadUser ?? loadUserSettings)();

  if (!existsSync(path)) {
    return {
      name: "Settings file",
      status: "warn",
      message: "Settings file not found (will use defaults)",
      fix: "Run 'squirrel self install' to create settings",
    };
  }

  if (!result.ok) {
    // Branch on error class (#1093): only genuinely malformed content
    // (bad JSON / schema) warrants the destructive "delete the file" hint.
    // A read failure (EACCES / other I/O) is a permissions problem, not
    // corruption — deleting wouldn't help and the file may be fine — so warn
    // without the delete hint, mirroring the cwd-walk handling from #1092.
    const corrupt =
      result.error.code === "INVALID_JSON" ||
      result.error.code === "INVALID_SETTINGS";
    if (corrupt) {
      return {
        name: "Settings file",
        status: "fail",
        message: `Settings file corrupted: ${result.error.message}`,
        fix: "Delete ~/.squirrel/settings.json and run 'squirrel self install'",
      };
    }
    return {
      name: "Settings file",
      status: "warn",
      message: `Settings file unreadable: ${result.error.message}`,
      fix: "Check permissions on ~/.squirrel/settings.json (e.g. chmod u+rw), or run from an account that can read it",
    };
  }

  const localWalk = (deps.findLocal ?? findLocalSettingsPath)();
  if (!localWalk.ok) {
    return {
      name: "Settings file",
      status: "warn",
      message: `Settings OK (channel: ${result.data.channel}); local settings unreadable from this directory: ${localWalk.error.message}`,
      fix: "Check directory permissions, or run from a directory you can read",
    };
  }

  return {
    name: "Settings file",
    status: "pass",
    message: `Settings OK (channel: ${result.data.channel})`,
  };
}

function checkSymlink(): DoctorCheck {
  const symlinkPath = getSymlinkPath();

  if (!existsSync(symlinkPath)) {
    return {
      name: "Symlink",
      status: "fail",
      message: "Symlink not found",
      fix: "Run 'squirrel self install' to create symlink",
    };
  }

  try {
    const stats = lstatSync(symlinkPath);
    if (!stats.isSymbolicLink()) {
      return {
        name: "Symlink",
        status: "warn",
        message: "Binary exists but is not a symlink (manual install?)",
      };
    }

    const target = readlinkSync(symlinkPath);
    if (!existsSync(target)) {
      return {
        name: "Symlink",
        status: "fail",
        message: `Symlink target does not exist: ${target}`,
        fix: "Run 'squirrel self update' to reinstall",
      };
    }

    return {
      name: "Symlink",
      status: "pass",
      message: `Points to: ${target}`,
    };
  } catch (error) {
    return {
      name: "Symlink",
      status: "fail",
      message: (error as Error).message,
    };
  }
}

function checkBinaryExecutable(): DoctorCheck {
  const binaryPath = getBinaryPath(version);

  if (!existsSync(binaryPath)) {
    return {
      name: "Binary",
      status: "fail",
      message: `Binary not found for v${version}`,
      fix: "Run 'squirrel self update' to reinstall",
    };
  }

  return {
    name: "Binary",
    status: "pass",
    message: `v${version} installed`,
  };
}

function checkPathEnv(): DoctorCheck {
  const paths = getSquirrelPaths();
  const pathEnv = process.env.PATH ?? "";
  const binDir = paths.bin;
  const separator = platform() === "win32" ? ";" : ":";

  if (!pathEnv.split(separator).includes(binDir)) {
    const shell = process.env.SHELL ?? "/bin/bash";
    const rcFile = shell.includes("zsh")
      ? "~/.zshrc"
      : shell.includes("fish")
        ? "~/.config/fish/config.fish"
        : "~/.bashrc";

    return {
      name: "PATH",
      status: "warn",
      message: `${binDir} not in PATH`,
      fix: `Add to ${rcFile}: export PATH="${binDir}:$PATH"`,
    };
  }

  return {
    name: "PATH",
    status: "pass",
    message: "bin directory in PATH",
  };
}

function checkReleasesDir(): DoctorCheck {
  const paths = getSquirrelPaths();

  if (!existsSync(paths.releases)) {
    return {
      name: "Releases cache",
      status: "warn",
      message: "No cached releases",
    };
  }

  return {
    name: "Releases cache",
    status: "pass",
    message: `Cache at ${paths.releases}`,
  };
}

// A check older than this suggests the background updater isn't running (or
// the CLI is used rarely) — worth flagging so a stuck updater is visible.
const STALE_UPDATE_CHECK_HOURS = 24 * 7;

export function formatHoursAgo(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function checkUpdateStatus(): DoctorCheck {
  const name = "Auto-update";

  // Suppressed (CI / SQUIRREL_NO_UPDATE) is the expected, healthy state for
  // those environments — report it, don't warn.
  const suppressed = updateSuppressedReason();
  if (suppressed) {
    return {
      name,
      status: "pass",
      message: `Background updates off (${suppressed})`,
    };
  }

  if (!isManagedInstall()) {
    return {
      name,
      status: "warn",
      message: "Not a managed install — won't self-update",
      fix: getUnmanagedUpdateHint(),
    };
  }

  const result = loadSettings();
  if (!result.ok) {
    // The background updater also bails when settings can't load, so don't
    // report a healthy update state. The Settings file check carries the fix.
    return {
      name,
      status: "warn",
      message: "Can't read settings — see the Settings file check",
    };
  }
  const settings = result.data;

  // Computed before the auto_update branch so a manually-updatable pending
  // version still surfaces even when automatic updates are off.
  const pending = settings.pending_update_notification;
  const pendingNote = pending
    ? ` — update ready: v${pending.from_version} → v${pending.to_version}`
    : "";

  if (!settings.auto_update) {
    return {
      name,
      status: "pass",
      message: `auto_update is off (manual updates only)${pendingNote}`,
      fix: "Enable: squirrel self settings set auto_update true",
    };
  }

  const interval =
    settings.update_check_interval_hours ?? DEFAULT_UPDATE_CHECK_INTERVAL_HOURS;

  if (!settings.last_update_check) {
    return {
      name,
      status: "pass",
      message: `Enabled (every ${interval}h, not checked yet)${pendingNote}`,
    };
  }

  const lastMs = Date.parse(settings.last_update_check);
  if (Number.isNaN(lastMs)) {
    return {
      name,
      status: "warn",
      message: `Invalid last-check timestamp — will re-check${pendingNote}`,
    };
  }

  const hoursAgo = (Date.now() - lastMs) / (1000 * 60 * 60);
  // Only "stale" if it's overdue beyond a normal interval — a long configured
  // interval (e.g. monthly) must not trip the default 7-day threshold.
  const staleThreshold = Math.max(STALE_UPDATE_CHECK_HOURS, interval * 2);
  if (hoursAgo > staleThreshold) {
    return {
      name,
      status: "warn",
      message: `Last checked ${formatHoursAgo(hoursAgo)} ago — stale${pendingNote}`,
      fix: "Verify update access: squirrel self update --check",
    };
  }

  return {
    name,
    status: "pass",
    message: `Last checked ${formatHoursAgo(hoursAgo)} ago, every ${interval}h${pendingNote}`,
  };
}

function checkLogging(): DoctorCheck {
  const logDir = getLogsPath();
  const settings = loadSettings();
  const logLevel = settings.ok ? (settings.data.log_level ?? "error") : "error";
  const envOverride = process.env.SQUIRREL_LOG_LEVEL;

  // Check if log directory exists
  if (!existsSync(logDir)) {
    // Try to create it
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      return {
        name: "Logging",
        status: "fail",
        message: `Cannot create log directory: ${logDir}`,
        fix: `Create directory manually: mkdir -p ${logDir}`,
      };
    }
  }

  // Check write permissions
  try {
    accessSync(logDir, constants.W_OK);
  } catch {
    return {
      name: "Logging",
      status: "fail",
      message: `Log directory not writable: ${logDir}`,
      fix: `Fix permissions: chmod u+w ${logDir}`,
    };
  }

  // Check if debug.log exists and is writable
  const debugLogPath = join(logDir, "debug.log");
  if (existsSync(debugLogPath)) {
    try {
      accessSync(debugLogPath, constants.W_OK);
    } catch {
      return {
        name: "Logging",
        status: "fail",
        message: `Log file not writable: ${debugLogPath}`,
        fix: `Fix permissions: chmod u+w ${debugLogPath}`,
      };
    }
  }

  // Build status message
  const effectiveLevel = envOverride ?? logLevel;
  const levelInfo = envOverride
    ? `${effectiveLevel} (env override)`
    : effectiveLevel;

  return {
    name: "Logging",
    status: "pass",
    message: `Level: ${levelInfo}, path: ${logDir}`,
  };
}
