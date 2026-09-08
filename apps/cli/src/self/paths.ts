import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, parse, sep } from "node:path";

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
  // Bun 1.4 surfaces the underlying getcwd(3) failure (EACCES when an ancestor
  // dir lost +x under us); 1.3 returned a cached path instead. Uncaught, that
  // turns the err() contract above back into the throw #1057 removed.
  let dir: string;
  try {
    dir = process.cwd();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return err(
      commandError(
        code ?? "FILE_READ_ERROR",
        `Failed to resolve the current directory: ${(error as Error).message}`
      )
    );
  }
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

/**
 * Validate a caller-supplied custom bin directory before it is used to build a
 * symlink/rename/unlink target. `customBinDir` can originate from an untrusted
 * source (a repo-local .squirrel/settings.json's `install_bin_dir`, threaded
 * through the auto-updater as customBinDir), so a hostile value must not be
 * able to plant the `squirrel` symlink at an attacker-chosen path (#1398).
 * Rejects empty strings, embedded NUL (truncates past the C-string boundary),
 * any relative path (must be absolute), and any `..` traversal segment. The
 * trusted default from getSquirrelPaths().bin never routes through here.
 */
function assertSafeBinDir(dir: string): void {
  if (dir === "") {
    throw new Error("Invalid bin directory: must not be empty");
  }
  if (dir.includes("\0")) {
    throw new Error("Invalid bin directory: must not contain a NUL byte");
  }
  if (!isAbsolute(dir)) {
    throw new Error(`Invalid bin directory: must be an absolute path: ${dir}`);
  }
  // Split on BOTH separators so a `..` segment is caught regardless of the
  // slash style the value was written with (Windows accepts either).
  if (dir.split(/[/\\]/).includes("..")) {
    throw new Error(`Invalid bin directory: must not contain '..': ${dir}`);
  }
}

export function getSymlinkPath(customBinDir?: string): string {
  const os = platform() as Platform;
  const ext = os === "win32" ? ".exe" : "";
  // Only a caller-supplied dir is untrusted; the default is trusted as-is.
  if (customBinDir !== undefined) {
    assertSafeBinDir(customBinDir);
  }
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
 *
 * Windows is the exception: `self install` lands a COPY at the managed bin
 * path there (symlinks need a privilege most users don't have — see
 * link-binary.ts), so the running exe is never under releases/. Without the
 * win32 branch every Windows install would read as hand-rolled and both
 * `self update` and auto-update would refuse to run (#1538). Only the DEFAULT
 * bin path counts; a --bin-dir install stays unmanaged, as it was before.
 */
export function isManagedInstall(): boolean {
  try {
    const exe = realpathSync(process.execPath);
    const releases = realpathSync(getSquirrelPaths().releases);
    if (exe.startsWith(releases + sep)) return true;
    if (platform() === "win32") {
      return exe === realpathSync(getSymlinkPath());
    }
    return false;
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

/**
 * realpathSync that degrades to the input instead of throwing. A dangling
 * symlink (release directory pruned) and a path that simply isn't there both
 * still have to be reportable — the caller is diagnosing exactly that.
 */
export function safeRealpath(
  path: string,
  realpath: (p: string) => string = realpathSync
): string {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

export interface PathBinary {
  /** The entry PATH resolves, e.g. /usr/local/bin/squirrel. */
  binary: string;
  /** What that entry actually runs, symlinks and the npm wrapper followed. */
  target: string;
  /**
   * The npm wrapper script standing between the two, when PATH resolves to an
   * `npm install -g squirrelscan`. null for a direct binary.
   */
  via: string | null;
}

export interface ResolveOnPathDeps {
  which?: (command: string) => string | null;
  realpath?: (path: string) => string;
  exists?: (path: string) => boolean;
  isWindows?: boolean;
}

/**
 * True for the npm package's `bin/squirrel.js` wrapper (npm links it onto PATH
 * as `squirrel`).
 *
 * The full installed path is matched, not merely "a .js under node_modules":
 * emulating this wrapper's dispatch means reporting the managed binary as what
 * runs, so mistaking SOMEONE ELSE'S launcher for it would turn a real mismatch
 * into a confident "same" and hide the very thing #293 is about. The
 * `node_modules` half of the test is the same one getUnmanagedUpdateHint uses.
 *
 * Known misses, both erring toward an honest "different": npm on Windows
 * installs a `squirrel.cmd` shim rather than a link to the .js, and `npm link`
 * points at a checkout outside node_modules.
 */
export function isNpmWrapper(path: string): boolean {
  return (
    path.includes(`${sep}node_modules${sep}`) &&
    path.endsWith(`${sep}squirrelscan${sep}bin${sep}squirrel.js`)
  );
}

/**
 * The binaries npm/bin/squirrel.js tries, in its order, ending with the copy
 * bundled in the package.
 *
 * MIRRORS that file deliberately: a wrapper on PATH runs the FIRST of these
 * that exists, so "will my next squirrel be the version I just installed?"
 * cannot be answered without walking the same list. The managed default bin
 * path leads it, which is why an ordinary npm install DOES pick up
 * `self update` and must not be warned about. tests/self/paths.test.ts asserts
 * this list still matches the wrapper.
 */
export function npmWrapperCandidates(
  wrapperPath: string,
  isWindows: boolean
): string[] {
  const home = homedir();
  const bundled = join(
    dirname(wrapperPath),
    `squirrel${isWindows ? ".exe" : ""}`
  );
  return isWindows
    ? [
        join(home, "AppData", "Local", "squirrel", "bin", "squirrel.exe"),
        join(home, ".local", "bin", "squirrel.exe"),
        bundled,
      ]
    : [
        join(home, ".local", "bin", "squirrel"),
        "/usr/local/bin/squirrel",
        "/opt/homebrew/bin/squirrel",
        bundled,
      ];
}

/**
 * The `squirrel` the user's PATH would run, or null when PATH has none.
 *
 * `self update` flips the link recorded at install time, which is not
 * necessarily the binary the user's shell resolves: a stale `install_bin_dir`,
 * a second install earlier on PATH, or a bin dir that was never added to PATH
 * all leave the update landing somewhere invisible while the CLI reports
 * success (#293). Answering "what will actually run next time" needs the PATH
 * lookup, not the recorded path.
 *
 * An npm install puts a WRAPPER on PATH, not a binary, so the lookup follows
 * its dispatch too: the wrapper runs the first of npmWrapperCandidates that
 * exists, which is normally the managed link `self update` just flipped.
 * Stopping at the wrapper would report every npm user as running something
 * else and warn them after every single update.
 */
export function resolveSquirrelOnPath(
  deps: ResolveOnPathDeps = {}
): PathBinary | null {
  const isWindows = deps.isWindows ?? platform() === "win32";
  const which =
    deps.which ??
    ((command: string) =>
      typeof Bun === "undefined" ? null : Bun.which(command));

  let found: string | null = null;
  try {
    found = which("squirrel");
    // Bun.which resolves PATHEXT itself, but ask for the explicit name too so
    // a lookup that only matches the extension still finds the binary.
    if (!found && isWindows) found = which("squirrel.exe");
  } catch {
    return null;
  }
  if (!found) return null;

  const resolved = safeRealpath(found, deps.realpath);
  if (!isNpmWrapper(resolved)) {
    return { binary: found, target: resolved, via: null };
  }

  // existsSync, matching the wrapper: it FOLLOWS symlinks, so a link whose
  // release directory was pruned is skipped there and must be skipped here.
  const exists = deps.exists ?? existsSync;
  for (const candidate of npmWrapperCandidates(resolved, isWindows)) {
    if (!exists(candidate)) continue;
    return {
      binary: found,
      target: safeRealpath(candidate, deps.realpath),
      via: resolved,
    };
  }

  // No candidate exists: the wrapper would print its "binary not found" error.
  return { binary: found, target: resolved, via: resolved };
}

/**
 * Path equality for comparing resolved binaries. Windows paths are compared
 * case-insensitively; POSIX paths are not (two names differing only in case
 * are two different files there).
 */
export function samePath(a: string, b: string, isWindows: boolean): boolean {
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isBinInPath(customBinDir?: string): boolean {
  const binDir = customBinDir ?? getSquirrelPaths().bin;
  const pathEnv = process.env.PATH ?? "";
  const separator = platform() === "win32" ? ";" : ":";
  return pathEnv.split(separator).includes(binDir);
}
