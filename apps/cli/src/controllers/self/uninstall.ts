import {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from "node:path";

import { type Result, ok, err, commandError } from "@/controllers/types";
import {
  getSquirrelPaths,
  getSymlinkPath,
  isManagedInstall,
  samePath,
} from "@/self/paths";
import { loadUserSettings } from "@/self/settings";

// `self uninstall` deletes files, so every target is proven to be one that
// `self install` (or install.sh / install.ps1, which lay out the same tree)
// created before it is touched:
//
//   - the `squirrel` link in the default bin dir and in the recorded
//     install_bin_dir, but only when it is a symlink whose target resolves
//     inside ~/.squirrel/releases (on Windows, the plain copy install falls
//     back to: see link-binary.ts);
//   - ~/.squirrel/releases itself, only while it is a real directory inside
//     the data dir, never a symlink to somewhere else;
//   - with --purge, the data dir (~/.squirrel) and the cache dir, again only
//     as real directories.
//
// Everything is resolved with realpath and compared against the resolved
// managed roots. A path that fails a check is reported as skipped, never
// deleted. rmSync's recursive delete unlinks symlinks it meets inside the
// tree rather than following them, so a link planted inside releases cannot
// carry the delete out of it. Each target is lstat'd again right before it
// goes, and skipped if it is no longer the same file the plan described.

export type UninstallTargetKind =
  | "link"
  | "replaced-binary"
  | "releases"
  | "data"
  | "cache";

export interface UninstallTarget {
  kind: UninstallTargetKind;
  path: string;
  /**
   * dev/ino from planning time, re-checked before deleting. bigint, because
   * Windows file indexes are 64-bit and lose precision as a JS number. Best
   * effort where a filesystem reports 0 (FAT, some network shares): there
   * the realpath containment and directory checks are what still hold.
   */
  dev: bigint;
  ino: bigint;
  /** Windows: this link is the exe that is running right now. */
  running?: boolean;
}

export interface SkippedPath {
  path: string;
  reason: string;
}

export interface UninstallPlan {
  targets: UninstallTarget[];
  skipped: SkippedPath[];
  /** What stays behind without --purge (settings, credentials, audits). */
  kept: string | null;
  /** Problems reading the install record, worth telling the user. */
  notes: string[];
  /** The running binary is managed, or is the managed link itself. */
  runningIsManaged: boolean;
  /** realpath of the running binary, for the Windows move-aside. */
  runningExe: string | null;
}

export interface UninstallOptions {
  purge: boolean;
  yes: boolean;
}

export interface UninstallDeps {
  /** The binary doing the uninstall. Defaults to process.execPath. */
  execPath?: string;
  isWindows?: boolean;
  /**
   * The install_bin_dir recorded at install time. undefined reads it from
   * ~/.squirrel/settings.json; null means none was recorded.
   */
  recordedBinDir?: string | null;
  /** Whether a prompt can be answered. Defaults to stdin and stdout TTYs. */
  isInteractive?: boolean;
  /** Ask the user to go ahead with `plan`. Required when interactive. */
  confirm?: (plan: UninstallPlan) => Promise<boolean>;
  pid?: number;
  /**
   * Windows: where the locked, running exe is moved so the directory holding
   * it can be deleted. Defaults to os.tmpdir(), on the same volume as
   * %LOCALAPPDATA% in a standard profile.
   */
  asideDir?: string;
  /** Test seam: deletes the moved-aside exe (a lock makes this throw). */
  unlinkAside?: (path: string) => void;
}

export type UninstallStatus = "removed" | "nothing-to-remove" | "cancelled";

export interface UninstallResult {
  status: UninstallStatus;
  plan: UninstallPlan;
  removed: string[];
  failed: SkippedPath[];
  /** Windows: the running exe, renamed aside because it cannot be deleted. */
  leftover: string[];
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function tryLstat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** True when `child` is strictly below `parent`. Both must be absolute. */
export function isInside(
  child: string,
  parent: string,
  isWindows: boolean
): boolean {
  const c = isWindows ? child.toLowerCase() : child;
  const p = isWindows ? parent.toLowerCase() : parent;
  const rel = relative(p, c);
  if (rel === "" || isAbsolute(rel)) return false;
  return rel.split(/[/\\]/)[0] !== "..";
}

/**
 * The filesystem root, the home directory, and anything above it are never
 * deletable, whatever the paths module says. getSquirrelPaths always appends
 * a squirrel-specific segment, so this only fires if that ever regresses.
 */
function isProtected(path: string, home: string, isWindows: boolean): boolean {
  if (samePath(path, parse(path).root, isWindows)) return true;
  if (samePath(path, home, isWindows)) return true;
  return isInside(home, path, isWindows);
}

function recordedBinDirFromSettings(notes: string[]): string | null {
  const settings = loadUserSettings();
  if (!settings.ok) {
    notes.push(
      `Could not read ${settings.error.message}; only the default bin directory was checked.`
    );
    return null;
  }
  return settings.data.install_bin_dir ?? null;
}

/**
 * Work out what `self uninstall` would delete, without deleting anything.
 */
export function planUninstall(
  options: Pick<UninstallOptions, "purge">,
  deps: UninstallDeps = {}
): UninstallPlan {
  const isWindows = deps.isWindows ?? platform() === "win32";
  const execPath = deps.execPath ?? process.execPath;
  const paths = getSquirrelPaths();
  const home = tryRealpath(homedir()) ?? homedir();
  const notes: string[] = [];
  const targets: UninstallTarget[] = [];
  const skipped: SkippedPath[] = [];

  const dataStat = tryLstat(paths.data);
  const dataReal =
    dataStat && dataStat.isDirectory() ? tryRealpath(paths.data) : null;
  const releasesStat = tryLstat(paths.releases);
  const releasesReal =
    releasesStat && releasesStat.isDirectory()
      ? tryRealpath(paths.releases)
      : null;
  const execReal = tryRealpath(execPath);

  // ── The `squirrel` link(s) ────────────────────────────────────────────────
  const recorded =
    deps.recordedBinDir !== undefined
      ? deps.recordedBinDir
      : recordedBinDirFromSettings(notes);
  const linkPaths: string[] = [];
  if (recorded) {
    try {
      linkPaths.push(getSymlinkPath(recorded));
    } catch (error) {
      notes.push(
        `Ignored the recorded install_bin_dir: ${(error as Error).message}`
      );
    }
  }
  const defaultLink = getSymlinkPath();
  if (!linkPaths.some((p) => samePath(p, defaultLink, isWindows))) {
    linkPaths.push(defaultLink);
  }

  let runningIsLink = false;
  for (const link of linkPaths) {
    const stat = tryLstat(link);
    if (!stat) continue;

    if (stat.isSymbolicLink()) {
      const real = tryRealpath(link);
      let inside: boolean;
      if (real) {
        inside =
          releasesReal !== null && isInside(real, releasesReal, isWindows);
      } else {
        // Dangling (its release was pruned): judge the link text, lexically.
        const target = resolve(dirname(link), readlinkSync(link));
        // HOME reached through a symlink leaves the text unresolved, so
        // accept either spelling of the releases dir.
        inside =
          isInside(target, paths.releases, isWindows) ||
          (releasesReal !== null && isInside(target, releasesReal, isWindows));
      }
      if (!inside) {
        skipped.push({
          path: link,
          reason: `points outside ${paths.releases}, so it is not a squirrelscan install`,
        });
        continue;
      }
      targets.push({ kind: "link", path: link, dev: stat.dev, ino: stat.ino });
      continue;
    }

    // Windows lays a COPY here when symlinks need a privilege the user lacks
    // (link-binary.ts). Accept it only where install puts it by default, under
    // the data dir, or when it is the very exe running this uninstall.
    if (isWindows && stat.isFile()) {
      const real = tryRealpath(link);
      const isRunning =
        real !== null && execReal !== null && samePath(real, execReal, true);
      const underData =
        real !== null && dataReal !== null && isInside(real, dataReal, true);
      if (isRunning || underData) {
        if (isRunning) runningIsLink = true;
        targets.push({
          kind: "link",
          path: link,
          dev: stat.dev,
          ino: stat.ino,
          running: isRunning,
        });
        // Old exes a Windows update renamed aside (updater.ts).
        const prefix = `${basename(link)}.old-`.toLowerCase();
        let siblings: string[] = [];
        try {
          siblings = readdirSync(dirname(link));
        } catch (error) {
          notes.push(
            `Could not list ${dirname(link)} for old update leftovers: ${(error as Error).message}`
          );
        }
        for (const entry of siblings) {
          if (!entry.toLowerCase().startsWith(prefix)) continue;
          const old = join(dirname(link), entry);
          const oldStat = tryLstat(old);
          if (oldStat?.isFile()) {
            targets.push({
              kind: "replaced-binary",
              path: old,
              dev: oldStat.dev,
              ino: oldStat.ino,
            });
          }
        }
        continue;
      }
    }

    skipped.push({
      path: link,
      reason: `is not a link into ${paths.releases}, so it is not a squirrelscan install`,
    });
  }

  // ── Release binaries ─────────────────────────────────────────────────────
  if (releasesStat) {
    if (!releasesStat.isDirectory()) {
      skipped.push({
        path: paths.releases,
        reason: releasesStat.isSymbolicLink()
          ? "is a symlink; squirrelscan never follows one out of its own directories"
          : "is not a directory",
      });
    } else if (
      releasesReal === null ||
      dataReal === null ||
      !isInside(releasesReal, dataReal, isWindows) ||
      isProtected(releasesReal, home, isWindows)
    ) {
      skipped.push({
        path: paths.releases,
        reason: `does not resolve inside ${paths.data}`,
      });
    } else {
      targets.push({
        kind: "releases",
        path: paths.releases,
        dev: releasesStat.dev,
        ino: releasesStat.ino,
      });
    }
  }

  // ── --purge: settings, credentials, audits, cache ──────────────────────────
  if (options.purge) {
    for (const [kind, dir] of [
      ["data", paths.data],
      ["cache", paths.cache],
    ] as const) {
      const stat = tryLstat(dir);
      if (!stat) continue;
      const real = stat.isDirectory() ? tryRealpath(dir) : null;
      if (!stat.isDirectory() || real === null) {
        skipped.push({
          path: dir,
          reason: stat.isSymbolicLink()
            ? "is a symlink; remove it yourself if you mean to"
            : "is not a directory",
        });
        continue;
      }
      if (isProtected(real, home, isWindows)) {
        skipped.push({
          path: dir,
          reason: "resolves to a protected directory",
        });
        continue;
      }
      // Already covered by the data dir delete.
      if (
        kind === "cache" &&
        dataReal !== null &&
        isInside(real, dataReal, isWindows)
      ) {
        continue;
      }
      targets.push({ kind, path: dir, dev: stat.dev, ino: stat.ino });
    }
  }

  const runningIsManaged = isManagedInstall(execPath) || runningIsLink;

  return {
    targets,
    skipped,
    kept: !options.purge && dataStat ? paths.data : null,
    notes,
    runningIsManaged,
    runningExe: execReal,
  };
}

/**
 * Windows refuses to delete a loaded exe but lets it be renamed, across
 * directories on the same volume too. Move it out of the tree being deleted
 * (into `asideDir`, falling back to a sibling `.old-<pid>` name the way
 * updater.ts does), then try to delete it; if it is still locked, report it.
 */
function moveRunningExeAside(
  path: string,
  pid: number,
  asideDir: string,
  leftover: string[],
  unlinkAside: (path: string) => void
): void {
  const candidates = [
    join(asideDir, `squirrel-uninstalled-${pid}-${basename(path)}`),
    `${path}.old-${pid}`,
  ];
  let aside: string | null = null;
  let lastError: Error = new Error(`Could not move ${path} aside`);
  for (const candidate of candidates) {
    try {
      renameSync(path, candidate);
      aside = candidate;
      break;
    } catch (error) {
      lastError = error as Error;
    }
  }
  if (aside === null) throw lastError;
  try {
    unlinkAside(aside);
  } catch {
    leftover.push(aside);
  }
}

function removeTarget(
  target: UninstallTarget,
  plan: UninstallPlan,
  isWindows: boolean,
  pid: number,
  asideDir: string,
  leftover: string[],
  unlinkAside: (path: string) => void
): void {
  if (target.kind === "link" || target.kind === "replaced-binary") {
    if (isWindows && target.running) {
      moveRunningExeAside(target.path, pid, asideDir, leftover, unlinkAside);
      return;
    }
    unlinkSync(target.path);
    return;
  }
  // The running exe can sit inside a directory being deleted: under releases
  // when Windows made a real symlink, or under the data dir's bin folder with
  // --purge. Move it out first, or the recursive delete fails on it.
  if (isWindows && plan.runningExe) {
    const real = tryRealpath(target.path);
    if (
      real !== null &&
      isInside(plan.runningExe, real, true) &&
      tryLstat(plan.runningExe)?.isFile()
    ) {
      try {
        moveRunningExeAside(
          plan.runningExe,
          pid,
          asideDir,
          leftover,
          unlinkAside
        );
      } catch {
        // Still in place: the delete below reports the failure.
      }
    }
  }
  rmSync(target.path, { recursive: true, force: true });
}

/**
 * Execute a plan. Each target is lstat'd again first: if it is gone, it is
 * skipped quietly; if it is a different file now (swapped for a symlink, say),
 * it is reported and left alone.
 */
export function executeUninstall(
  plan: UninstallPlan,
  deps: Pick<
    UninstallDeps,
    "isWindows" | "pid" | "asideDir" | "unlinkAside"
  > = {}
): Pick<UninstallResult, "removed" | "failed" | "leftover"> {
  const isWindows = deps.isWindows ?? platform() === "win32";
  const pid = deps.pid ?? process.pid;
  const asideDir = deps.asideDir ?? tmpdir();
  const unlinkAside = deps.unlinkAside ?? unlinkSync;
  const removed: string[] = [];
  const failed: SkippedPath[] = [];
  const leftover: string[] = [];

  for (const target of plan.targets) {
    let now: BigIntStats | null;
    try {
      now = tryLstat(target.path);
    } catch (error) {
      failed.push({ path: target.path, reason: (error as Error).message });
      continue;
    }
    if (!now) continue;
    const isDirTarget =
      target.kind === "releases" ||
      target.kind === "data" ||
      target.kind === "cache";
    if (
      now.dev !== target.dev ||
      now.ino !== target.ino ||
      (isDirTarget && (!now.isDirectory() || now.isSymbolicLink()))
    ) {
      failed.push({
        path: target.path,
        reason: "changed while uninstalling, left alone",
      });
      continue;
    }
    try {
      removeTarget(
        target,
        plan,
        isWindows,
        pid,
        asideDir,
        leftover,
        unlinkAside
      );
      removed.push(target.path);
    } catch (error) {
      failed.push({ path: target.path, reason: (error as Error).message });
    }
  }

  // Without --purge the data dir stays for settings; drop it only if the
  // release delete left it empty. rmdir refuses a non-empty directory.
  if (plan.kept) {
    try {
      if (lstatSync(plan.kept).isDirectory()) rmdirSync(plan.kept);
    } catch {
      // Not empty (settings and credentials live here, as intended) or gone.
    }
  }

  return { removed, failed, leftover };
}

/**
 * Remove the managed install: the `squirrel` link, the release binaries, and
 * with --purge the settings, credentials, audit data and cache.
 *
 * Refuses (deleting nothing) when the running binary is not a managed install
 * and is not the managed link itself, and when confirmation is needed but
 * cannot be asked for. Running it again after a successful uninstall finds
 * nothing to remove and succeeds.
 */
export async function runSelfUninstall(
  options: UninstallOptions,
  deps: UninstallDeps = {}
): Promise<Result<UninstallResult>> {
  let plan: UninstallPlan;
  try {
    plan = planUninstall(options, deps);
  } catch (error) {
    return err(
      commandError(
        "UNINSTALL_FAILED",
        `Could not inspect the install: ${(error as Error).message}`
      )
    );
  }

  const empty = { removed: [], failed: [], leftover: [] };
  if (plan.targets.length === 0) {
    return ok({ status: "nothing-to-remove", plan, ...empty });
  }

  if (!plan.runningIsManaged) {
    const execPath = deps.execPath ?? process.execPath;
    return err(
      commandError(
        "NOT_MANAGED_INSTALL",
        `This squirrel (${execPath}) is not the managed install, so it will not delete one. ` +
          `Run the managed binary instead: ${getSymlinkPath()} self uninstall`,
        plan
      )
    );
  }

  if (!options.yes) {
    const interactive =
      deps.isInteractive ??
      Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive || !deps.confirm) {
      return err(
        commandError(
          "CONFIRMATION_REQUIRED",
          "Refusing to delete files without confirmation in a non-interactive session. Pass --yes to go ahead.",
          plan
        )
      );
    }
    if (!(await deps.confirm(plan))) {
      return ok({ status: "cancelled", plan, ...empty });
    }
  }

  const outcome = executeUninstall(plan, deps);
  return ok({ status: "removed", plan, ...outcome });
}

/**
 * `self install` and `self completion` never write completion files: the
 * script is printed and the user's shell config sources it. So there is no
 * file to delete, only a line in a file squirrelscan does not own.
 */
export const COMPLETION_NOTE =
  "squirrel never writes completion files: `self completion` prints a script and your shell config sources it. " +
  'If you added a line such as eval "$(squirrel self completion zsh)", remove it.';
