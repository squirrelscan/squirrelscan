// Write check for the local stores an audit needs (#403).
//
// SQLite opens a database file it cannot write READ-ONLY without saying so, so
// a store that is read-only for this process (a file owned by root after a
// `sudo squirrel` run, a coding agent's sandbox that blocks writes outside the
// project) opens fine and the audit dies at its first write with "attempt to
// write a readonly database". A content store that fails is worse: every page
// is fetched, fails to save, and the audit ends "No pages were crawled". This
// probes each store with a write that is rolled back, before the audit starts,
// and turns a failure into one line naming the file, the cause and the fix.

import { Database } from "bun:sqlite";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

import {
  getContentStorePath,
  getLinkCachePath,
  getProjectsPath,
  getSquirrelPaths,
} from "@/self/paths";

export interface StoreProblem {
  /** The file (or directory) that cannot be written. */
  path: string;
  /** Why, as a clause that follows "it": "is owned by another user (uid 0), ...". */
  problem: string;
  /** What to run or change. */
  fix: string;
}

// Short: a busy store means another squirrel run is writing to it, which the
// audit's own 15s busy timeout handles. The probe only needs to learn whether
// a write is possible at all, and a read-only file answers that without a lock.
const PROBE_BUSY_TIMEOUT_MS = 250;

// SQLite failures that mean "this process cannot write here", as opposed to
// the file being damaged, the disk being full, or another process holding it.
const PERMISSION_CODES = new Set([
  "SQLITE_READONLY",
  "SQLITE_READONLY_DIRECTORY",
  "SQLITE_READONLY_DBMOVED",
  "SQLITE_READONLY_CANTINIT",
  "SQLITE_READONLY_CANTLOCK",
  "SQLITE_READONLY_RECOVERY",
  "SQLITE_CANTOPEN",
  "SQLITE_PERM",
  "SQLITE_AUTH",
]);

/** Show a path the way a user would type it: `~/.squirrel/...`, not `/Users/name/...`. */
export function displayPath(path: string): string {
  const home = homedir();
  if (home && (path === home || path.startsWith(home + sep))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for the squirrel data directory (~/.squirrel) and anything inside it. */
function inDataDir(path: string): boolean {
  const data = getSquirrelPaths().data;
  return path === data || path.startsWith(data + sep);
}

/**
 * Explain why `target` (a file or directory that exists) is not writable by
 * this process. Inside ~/.squirrel the fix covers the whole data directory: a
 * sudo run or a sandbox affects every file there, not only the one that failed
 * first. Anywhere else (a custom SQUIRREL_CONTENT_STORE_PATH) it covers the
 * target alone, never a recursive change to a directory squirrel does not own.
 */
function permissionProblem(
  target: string,
  fallback: string
): Omit<StoreProblem, "path"> {
  let accessError: unknown;
  try {
    accessSync(target, constants.W_OK);
  } catch (error) {
    accessError = error;
  }
  const recursive = inDataDir(target);
  const scope = displayPath(recursive ? getSquirrelPaths().data : target);
  const r = recursive ? "-R " : "";

  // EPERM from access(2) is a policy, not the permission bits: the macOS
  // sandbox coding agents run commands in, an immutable flag, a MAC profile.
  if (errorCode(accessError) === "EPERM") {
    return {
      problem:
        "is blocked by a sandbox or security policy (often a coding agent's sandbox, which only allows writes inside the project)",
      fix: `allow writes to ${scope} in the sandbox settings, or run the audit outside the sandbox`,
    };
  }
  if (errorCode(accessError) === "EACCES") {
    const uid = process.getuid?.();
    let owner: number | undefined;
    try {
      owner = statSync(target).uid;
    } catch {
      owner = undefined;
    }
    if (uid !== undefined && owner !== undefined && owner !== uid) {
      return {
        problem: `is owned by another user (uid ${owner}), usually because squirrel once ran with sudo`,
        fix: `sudo chown ${r}"$(id -un)" ${scope}`,
      };
    }
    return { problem: "is read-only", fix: `chmod ${r}u+w ${scope}` };
  }
  return {
    problem: `cannot be written (${fallback})`,
    fix: `check the permissions on ${scope} and that nothing else holds it read-only`,
  };
}

/**
 * Explain why directory `dir` could not be created. `parent` is its nearest
 * existing ancestor, the directory that refused, and `error` is what mkdir
 * threw.
 */
function mkdirProblem(
  dir: string,
  parent: string,
  error: unknown,
  envVar?: string
): StoreProblem {
  // EPERM is a policy, as for access(2) above. The sandbox may cover only the
  // directory being created (~/.squirrel), not its parent, so read it off
  // mkdir's own error rather than probing the parent.
  if (errorCode(error) === "EPERM") {
    const scope = displayPath(inDataDir(dir) ? getSquirrelPaths().data : dir);
    return {
      path: dir,
      problem:
        "is blocked by a sandbox or security policy (often a coding agent's sandbox, which only allows writes inside the project)",
      fix: `allow writes to ${scope} in the sandbox settings, or run the audit outside the sandbox`,
    };
  }
  // Inside ~/.squirrel: the same causes and fixes as any store file there.
  if (inDataDir(parent)) {
    return { path: parent, ...permissionProblem(parent, errorMessage(error)) };
  }
  // Anywhere else, never suggest changing a directory squirrel does not own.
  return {
    path: dir,
    problem: `does not exist and cannot be created (${displayPath(parent)} is not writable)`,
    fix: envVar
      ? `set ${envVar} to a file in a directory you can write to`
      : `create ${displayPath(dir)} and give your user write access to it`,
  };
}

/** Turn a failed open or write probe into a problem, or null if it is not one. */
function classify(path: string, error: unknown): StoreProblem | null {
  const code = errorCode(error) ?? "";
  const message = errorMessage(error);

  // Another squirrel run is writing: not a reason to stop this one.
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
    return null;

  if (code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT")) {
    return {
      path,
      problem: "is not a readable SQLite database (it may be damaged)",
      fix: `move it aside (mv ${displayPath(path)} ${displayPath(path)}.bak) and squirrel creates a new one`,
    };
  }
  if (code === "SQLITE_FULL") {
    return {
      path,
      problem: "cannot grow because the disk is full",
      fix: "free some disk space",
    };
  }
  if (PERMISSION_CODES.has(code) || code.startsWith("SQLITE_IOERR")) {
    // A file that exists but cannot be written is the file's problem; a file
    // that cannot be created (or whose -wal/-shm cannot be) is its directory's.
    const dir = dirname(path);
    const fileExists = existsSync(path);
    const fileWritable = fileExists && isWritable(path);
    const target =
      fileExists && !fileWritable && code !== "SQLITE_READONLY_DIRECTORY"
        ? path
        : dir;
    return { path: target, ...permissionProblem(target, message) };
  }
  return {
    path,
    problem: `cannot be written (${message})`,
    fix: "check the file and its directory",
  };
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe one SQLite store: create its directory if needed, open it, and run a
 * write inside a transaction that is rolled back, so nothing in the file
 * changes. Returns null when the store is writable (or merely busy).
 *
 * `envVar` names the environment variable the path came from, when it did, so
 * a wrong value is blamed on the variable rather than on squirrel.
 */
export function checkStoreWritable(
  path: string,
  envVar?: string
): StoreProblem | null {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      // The nearest existing ancestor is the directory that refused.
      let parent = dir;
      while (!existsSync(parent) && dirname(parent) !== parent)
        parent = dirname(parent);
      return mkdirProblem(dir, parent, error, envVar);
    }
  }

  if (existsSync(path) && statSync(path).isDirectory()) {
    return {
      path,
      problem: "is a directory, not a database file",
      fix: envVar
        ? `set ${envVar} to a file path, such as ${displayPath(join(path, "content-store.db"))}`
        : "move the directory out of the way",
    };
  }

  let db: Database;
  try {
    db = new Database(path);
  } catch (error) {
    return classify(path, error);
  }
  try {
    db.run(`PRAGMA busy_timeout = ${PROBE_BUSY_TIMEOUT_MS}`);
    db.run("BEGIN IMMEDIATE");
    // A schema write, never committed. `BEGIN IMMEDIATE` alone succeeds on a
    // file SQLite opened read-only; an actual write is what fails.
    db.run("CREATE TABLE squirrel_write_probe (x)");
    return null;
  } catch (error) {
    return classify(path, error);
  } finally {
    try {
      db.run("ROLLBACK");
    } catch {
      // nothing to roll back: BEGIN itself failed
    }
    db.close();
  }
}

/**
 * Check every store a crawl or audit of `projectName` writes to: the project
 * database, the shared content store and, when external links will be checked,
 * the shared link cache. Returns one problem per store that cannot be written,
 * in that order.
 */
export function checkAuditStores(
  projectName: string,
  opts: { linkCache: boolean }
): StoreProblem[] {
  const contentStoreEnv = process.env.SQUIRREL_CONTENT_STORE_PATH
    ? "SQUIRREL_CONTENT_STORE_PATH"
    : undefined;
  const stores: { path: string; envVar?: string }[] = [
    // The name is validated by createStorage (getProjectDbPath) before any
    // project directory is created; an invalid one fails there, as before.
    ...(isPlainProjectName(projectName)
      ? [{ path: join(getProjectsPath(), projectName, "project.db") }]
      : []),
    { path: getContentStorePath(), envVar: contentStoreEnv },
    ...(opts.linkCache ? [{ path: getLinkCachePath() }] : []),
  ];
  const problems: StoreProblem[] = [];
  for (const store of stores) {
    const problem = checkStoreWritable(store.path, store.envVar);
    if (problem) problems.push(problem);
  }
  return problems;
}

// Mirrors the guard in getProjectDbPath: one path segment, not "." or "..".
// Anything else is left to that guard, which rejects it with its own message.
function isPlainProjectName(name: string): boolean {
  return (
    name.length > 0 && !/[/\\]/.test(name) && name !== "." && name !== ".."
  );
}

/** One line per problem: what cannot be written, why, and the fix. */
export function formatStoreProblems(problems: readonly StoreProblem[]): string {
  // Several stores in one directory usually fail for the same reason; say it once.
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of problems) {
    const key = `${p.problem}\n${p.fix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(
      `Cannot write to ${displayPath(p.path)}: it ${p.problem}. Fix: ${p.fix}`
    );
  }
  return lines.join("\n");
}
