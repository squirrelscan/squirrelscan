import { realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, parse, sep } from "node:path";

import { type Result, ok, err, commandError } from "@/controllers/types";

import type { Platform, PlatformArch } from "./types";

// Squirrel directory paths - consolidated under ~/.squirrel
export interface SquirrelPaths {
  data: string; // ~/.squirrel (base data directory)
  config: string; // ~/.squirrel (settings.json)
  bin: string; // ~/.local/bin (symlink location)
  releases: string; // ~/.squirrel/releases
  projects: string; // ~/.squirrel/projects
  cache: string; // System cache (~/Library/Caches/squirrel, ~/.cache/squirrel, etc.)
  logs: string; // ~/.squirrel/logs
}

const RELEASE_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Release directory names must be canonical SemVer and a single path segment. */
export function isValidReleaseVersion(version: string): boolean {
  return RELEASE_VERSION_PATTERN.test(version);
}

export function getSquirrelPaths(): SquirrelPaths {
  const home = homedir();
  const os = platform() as Platform;

  if (os === "win32") {
    // Windows: use LOCALAPPDATA
    const localAppData =
      process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const baseDir = join(localAppData, "squirrel");
    return {
      data: baseDir,
      config: baseDir,
      bin: join(baseDir, "bin"),
      releases: join(baseDir, "releases"),
      projects: join(baseDir, "projects"),
      cache: join(baseDir, "cache"),
      logs: join(baseDir, "logs"),
    };
  }

  // Unix: consolidated under ~/.squirrel
  const baseDir = join(home, ".squirrel");

  // macOS: ~/Library/Caches/squirrel
  // Linux: XDG_CACHE_HOME or ~/.cache/squirrel
  let cachePath: string;
  if (os === "darwin") {
    cachePath = join(home, "Library", "Caches", "squirrel");
  } else {
    const xdgCache = process.env.XDG_CACHE_HOME ?? join(home, ".cache");
    cachePath = join(xdgCache, "squirrel");
  }

  return {
    data: baseDir,
    config: baseDir,
    bin: join(home, ".local", "bin"),
    releases: join(baseDir, "releases"),
    projects: join(baseDir, "projects"),
    cache: cachePath,
    logs: join(baseDir, "logs"),
  };
}

export function getLogsPath(): string {
  return getSquirrelPaths().logs;
}

export function getSettingsPath(): string {
  return join(getSquirrelPaths().config, "settings.json");
}

export function getProjectsPath(): string {
  return getSquirrelPaths().projects;
}

export function getCachePath(): string {
  return getSquirrelPaths().cache;
}

export function getLinkCachePath(): string {
  return join(getSquirrelPaths().data, "link-cache.db");
}

export function getContentStorePath(): string {
  return (
    process.env.SQUIRREL_CONTENT_STORE_PATH ??
    join(getSquirrelPaths().data, "content-store.db")
  );
}

// Find local .squirrel/settings.json by walking up from cwd, stopping at
// home directory to avoid finding user settings as local.
//
// Uses statSync + ENOENT-only-missing (not existsSync) per candidate: existsSync
// swallows EACCES on an unreadable parent dir the same way it does for the
// settings file itself (#805/#1037), which would silently skip a level that
// actually has settings and keep walking up as if it were simply absent.
// EACCES (or any other stat error) now surfaces as err() so callers can warn
// loudly instead of treating settings as missing (#1057).
export function findLocalSettingsPath(): Result<string | null> {
  let dir = process.cwd();
  const root = parse(dir).root;
  const home = homedir();

  while (dir !== root && dir !== home) {
    const settingsPath = join(dir, ".squirrel", "settings.json");
    try {
      statSync(settingsPath);
      return ok(settingsPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return err(
          commandError(
            code ?? "FILE_READ_ERROR",
            `Failed to check for local settings at ${settingsPath}: ${(error as Error).message}`
          )
        );
      }
    }
    dir = dirname(dir);
  }

  return ok(null);
}

// Get local settings path in cwd (for creating)
export function getLocalSettingsPath(): string {
  return join(process.cwd(), ".squirrel", "settings.json");
}

// Get local settings directory in cwd
export function getLocalSettingsDir(): string {
  return join(process.cwd(), ".squirrel");
}

export function getReleasePath(version: string): string {
  if (!isValidReleaseVersion(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return join(getSquirrelPaths().releases, version);
}

export function getBinaryPath(version: string): string {
  const os = platform() as Platform;
  const ext = os === "win32" ? ".exe" : "";
  return join(getReleasePath(version), `squirrel${ext}`);
}

export function getSymlinkPath(customBinDir?: string): string {
  const os = platform() as Platform;
  const ext = os === "win32" ? ".exe" : "";
  const binDir = customBinDir ?? getSquirrelPaths().bin;
  return join(binDir, `squirrel${ext}`);
}

export function detectPlatformArch(): PlatformArch {
  const os = platform();
  const arch = process.arch;

  if (os === "darwin") {
    return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (os === "linux") {
    return arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
  if (os === "win32") {
    return "windows-x64";
  }

  throw new Error(`Unsupported platform: ${os}-${arch}`);
}

export function getUpdateLockPath(): string {
  return join(getSquirrelPaths().data, "update.lock");
}

/**
 * True when the running binary lives in the managed releases directory
 * (~/.squirrel/releases/{version}/squirrel), i.e. it was installed by
 * `self install` / install.sh / npm postinstall and `self update` can
 * safely swap the symlink. False for npm-fallback binaries inside
 * node_modules, manual copies, and dev mode (execPath = bun itself).
 */
export function isManagedInstall(): boolean {
  try {
    const exe = realpathSync(process.execPath);
    const releases = realpathSync(getSquirrelPaths().releases);
    return exe.startsWith(releases + sep);
  } catch {
    // releases dir missing or execPath unresolvable → not managed
    return false;
  }
}

/**
 * The command users should run to update a non-managed install.
 * npm-installed fallback binaries live inside node_modules; everything
 * else gets the generic installer URL.
 */
export function getUnmanagedUpdateHint(): string {
  const exe = process.execPath;
  if (exe.includes(`${sep}node_modules${sep}`)) {
    return "npm install -g squirrelscan@latest";
  }
  return "re-install from https://install.squirrelscan.com";
}

export function isBinInPath(customBinDir?: string): boolean {
  const binDir = customBinDir ?? getSquirrelPaths().bin;
  const pathEnv = process.env.PATH ?? "";
  const separator = platform() === "win32" ? ";" : ":";
  return pathEnv.split(separator).includes(binDir);
}
