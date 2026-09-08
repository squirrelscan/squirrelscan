// What `~/.squirrel` is costing, per project and in total (#1912).
//
// A re-audit of the same project writes a whole new crawl and retires nothing,
// so `project.db` grows by about one audit every time. Measured on a 1,000-page
// site: 95 MB after one audit, 189 MB after two, with `rule_results` and its two
// indexes accounting for 69.6% of the file and `pages` for another 28.2%.
//
// A successful audit now retires the audits outside `[storage] keep_audits`
// (#1912), so that growth has a ceiling — but the ceiling is still a multiple of
// one audit, the window is configurable, and retired rows stay in the file until
// something rebuilds it. This reports what is there; `--prune` below is the only
// part of it that deletes.

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { type Result, ok } from "@/controllers/types";

import {
  getContentStorePath,
  getLinkCachePath,
  getLogsPath,
  getProjectsPath,
  getSquirrelPaths,
} from "./paths";

export interface ProjectDiskUsage {
  /** Directory name under `projects/`, which is the slugified project name. */
  readonly name: string;
  readonly path: string;
  /** `project.db` plus its `-wal` and `-shm` siblings. */
  readonly bytes: number;
  /** Crawl rows, i.e. audits this project has recorded. */
  readonly crawls: number;
  /**
   * Rows in `rule_results`. Called out because it is the growth: about 204 rows
   * per page per audit, and with its indexes about 70% of the file.
   */
  readonly ruleResultRows: number;
  /**
   * Crawls already retired, whose reports can no longer be opened. Counted
   * because the difference between "7 audits" and "7 audits, 4 of them gone" is
   * the whole point of keeping the rows.
   */
  readonly retiredCrawls: number;
  /** Set when the database could not be read; the size is still reported. */
  readonly unreadable?: string;
}

export interface DiskUsage {
  readonly projects: readonly ProjectDiskUsage[];
  readonly projectsBytes: number;
  /** The global content store, shared by every project. */
  readonly contentStoreBytes: number;
  /** The global external-link cache, also shared by every project. */
  readonly linkCacheBytes: number;
  readonly releasesBytes: number;
  readonly logsBytes: number;
  readonly totalBytes: number;
}

/** Bytes of a file and its SQLite sidecars; 0 when absent. */
function dbFamilyBytes(dbPath: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    try {
      if (existsSync(path)) total += statSync(path).size;
    } catch {
      // A file that vanished mid-walk contributes nothing, which is the truth.
    }
  }
  return total;
}

/**
 * Bytes under a directory, following no symlinks and never throwing.
 *
 * A symlink loop cannot happen: `readdirSync` with `withFileTypes` reports link
 * entries by lstat, so a symlink to a directory answers false to `isDirectory()`
 * and is never recursed into. The depth limit is only a backstop against a
 * pathological real tree, and is set well beyond anything squirrel writes
 * (`releases/` is two levels, a project one) so that it cannot silently
 * understate a total.
 */
function directoryBytes(dir: string, depth = 16): number {
  if (depth < 0 || !existsSync(dir)) return 0;
  let total = 0;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directoryBytes(path, depth - 1);
      else if (entry.isFile()) total += statSync(path).size;
    } catch {
      // Unreadable entry: skip it rather than fail the whole report.
    }
  }
  return total;
}

/** Crawl and rule-result counts, or the reason they could not be read. */
function readProjectCounts(dbPath: string): {
  crawls: number;
  retiredCrawls: number;
  ruleResultRows: number;
  unreadable?: string;
} {
  if (!existsSync(dbPath))
    return { crawls: 0, retiredCrawls: 0, ruleResultRows: 0 };
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const crawls = db.query("SELECT COUNT(*) AS c FROM crawls").get() as {
      c: number;
    } | null;
    const rules = db.query("SELECT COUNT(*) AS c FROM rule_results").get() as {
      c: number;
    } | null;
    // Its own try: `retired_at` arrived in migration 25 and this connection is
    // read-only, so it cannot add the column to an older project. Not knowing
    // how many are retired is not a reason to report the project as unreadable.
    let retiredCrawls = 0;
    try {
      const retired = db
        .query("SELECT COUNT(*) AS c FROM crawls WHERE retired_at IS NOT NULL")
        .get() as { c: number } | null;
      retiredCrawls = retired?.c ?? 0;
    } catch {
      retiredCrawls = 0;
    }
    return {
      crawls: crawls?.c ?? 0,
      retiredCrawls,
      ruleResultRows: rules?.c ?? 0,
    };
  } catch (error) {
    // A database from an older schema, or one a concurrent audit holds locked,
    // still has a size worth reporting. Say why the counts are missing rather
    // than dropping the project from the table.
    return {
      crawls: 0,
      retiredCrawls: 0,
      ruleResultRows: 0,
      unreadable: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

/**
 * Where to look. Defaults to the real install; a caller passes its own so a test
 * does not have to move `$HOME` — `getSquirrelPaths` reads `os.homedir()`, which
 * does not follow the environment variable, so a test that set `HOME` would
 * quietly measure the developer's actual `~/.squirrel` instead.
 */
export interface DiskUsageRoots {
  readonly projects: string;
  readonly releases: string;
  readonly logs: string;
  readonly contentStore: string;
  readonly linkCache: string;
}

export function defaultDiskUsageRoots(): DiskUsageRoots {
  const paths = getSquirrelPaths();
  return {
    projects: getProjectsPath(),
    releases: paths.releases,
    logs: getLogsPath(),
    contentStore: getContentStorePath(),
    linkCache: getLinkCachePath(),
  };
}

/** Per-project and total disk use under the squirrel data directory. */
export function collectDiskUsage(
  roots: DiskUsageRoots = defaultDiskUsageRoots()
): Result<DiskUsage> {
  const projectsRoot = roots.projects;

  const projects: ProjectDiskUsage[] = [];
  if (existsSync(projectsRoot)) {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(projectsRoot, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(projectsRoot, entry.name);
      const dbPath = join(dir, "project.db");
      const counts = readProjectCounts(dbPath);
      projects.push({
        name: entry.name,
        path: dir,
        // The whole directory, not just project.db: a project may hold other
        // artefacts and the point of this command is "what is this costing me".
        bytes: directoryBytes(dir),
        ...counts,
      });
    }
  }

  // Biggest first — the reason anyone runs this is to find what to act on.
  projects.sort((a, b) => b.bytes - a.bytes);

  const projectsBytes = projects.reduce((sum, p) => sum + p.bytes, 0);
  const releasesBytes = directoryBytes(roots.releases);
  const logsBytes = directoryBytes(roots.logs);

  // The two shared databases are normally siblings of `projects/`, but
  // SQUIRREL_CONTENT_STORE_PATH can put the store anywhere, including inside a
  // project, which is what the benchmark harnesses do. Counting it on its own
  // line AND inside that project's directory would inflate the total and, worse,
  // blame a project for bytes it does not own.
  const countedDirs = [roots.projects, roots.releases, roots.logs];
  const sharedBytes = (path: string): number =>
    countedDirs.some((dir) => isInside(path, dir)) ? 0 : dbFamilyBytes(path);
  const contentStoreBytes = sharedBytes(roots.contentStore);
  const linkCacheBytes = sharedBytes(roots.linkCache);

  return ok({
    projects,
    projectsBytes,
    contentStoreBytes,
    linkCacheBytes,
    releasesBytes,
    logsBytes,
    totalBytes:
      projectsBytes +
      contentStoreBytes +
      linkCacheBytes +
      releasesBytes +
      logsBytes,
  });
}

/** Whether `path` sits under `dir`, without resolving symlinks. */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Human-readable bytes, at the precision someone deciding what to delete needs. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

// ── Reclaiming (#1912) ──────────────────────────────────────────────────────
//
// Explicit and user-driven, and separate from the automatic retention an audit
// runs (`[storage] keep_audits`). This is the half that rebuilds the file, which
// is the only way the space returns to the filesystem and far too expensive to
// do per audit. It also reaches projects an audit has not touched since
// retention arrived, and can prune below the automatic window.
//
// `--keep` stays required: retiring a crawl makes its report unrenderable, and
// `report --list`, `--diff` and `--regression-since <audit-id>` all reach back
// into that history, so a one-off destructive command does not get to pick the
// number.

/**
 * Space an audit's retention pass already freed inside a file, below which
 * rebuilding it is not worth offering. A few pages back is not a reclaim.
 */
const RECLAIM_FLOOR_BYTES = 1024 * 1024;

/** What retiring would remove from one project. */
export interface ProjectPrunePlan {
  readonly name: string;
  readonly path: string;
  /** Audits that would stop being renderable, oldest first. */
  readonly retiring: ReadonlyArray<{ id: string; startedAt: number }>;
  /**
   * Audits that stay fully renderable afterwards. Excludes the ones an earlier
   * pass already retired, which are listed but cannot be opened.
   */
  readonly keeping: number;
  readonly rows: number;
  /**
   * Space already free inside the file, which only a rebuild returns to the
   * filesystem. Non-zero on its own is a reason to run: automatic retention
   * deletes the rows but deliberately does not rewrite the file, so a project
   * can have nothing left to retire and still be holding a quarter of itself
   * in freed pages.
   */
  readonly reclaimableBytes: number;
  /** File size before, so the caller can report what was actually returned. */
  readonly bytesBefore: number;
}

/**
 * Plan the retirement of every audit outside the newest `keep` for one project.
 *
 * Reads only. The counts come from the same predicate the delete uses, because
 * a user confirms on these numbers.
 *
 * Returns a plan when there is something to retire OR something to reclaim.
 * Those came to the same thing before automatic retention existed and no longer
 * do: the common state now is an audit-retired project whose rows are already
 * gone and whose file is still the size they made it.
 */
export async function planProjectPrune(
  dbPath: string,
  keep: number
): Promise<ProjectPrunePlan | null> {
  if (!existsSync(dbPath)) return null;
  const { SQLiteStorage } = await import("@/crawler/storage/sqlite");
  const { Effect } = await import("effect");

  const storage = new SQLiteStorage(dbPath);
  try {
    await Effect.runPromise(storage.init());
    const crawls = await Effect.runPromise(storage.listCrawls());
    const stats = await Effect.runPromise(storage.databasePageStats());
    const reclaimableBytes = stats.freelistPages * stats.pageSize;
    // listCrawls is newest first; everything past the window retires, except
    // what an audit already retired — re-retiring deletes nothing and would
    // print an audit as going when it went days ago.
    const retiring = crawls
      .slice(Math.max(0, keep))
      .filter((c) => c.retiredAt === undefined)
      .map((c) => ({
        id: c.id,
        startedAt: c.startedAt,
      }));
    // Audits that can still be opened after this runs. Counting every crawl row
    // would include the ones an earlier pass already retired and describe a
    // history the user does not have: seven listed, four retired, "keeping 6".
    const stillRenderable = crawls.filter(
      (c) => c.retiredAt === undefined
    ).length;

    const preview =
      retiring.length > 0
        ? await Effect.runPromise(
            storage.previewRetireCrawls(retiring.map((c) => c.id))
          )
        : { totalRows: 0 };
    // Row count is not the test for "is there anything to do". An audit outside
    // the window with nothing deletable left in it is still retired by this —
    // stamped, and refused by `report` afterwards — so a plan with no rows and
    // an audit in it is a plan, and the caller has to describe it as one.
    if (
      retiring.length === 0 &&
      preview.totalRows === 0 &&
      reclaimableBytes < RECLAIM_FLOOR_BYTES
    ) {
      return null;
    }

    return {
      name: dbPath,
      path: dbPath,
      retiring: [...retiring].reverse(),
      keeping: stillRenderable - retiring.length,
      rows: preview.totalRows,
      reclaimableBytes,
      bytesBefore: dbFamilyBytes(dbPath),
    };
  } finally {
    // close() is a lazy Effect; calling it without running it leaves the
    // connection, and its -wal, open.
    await Effect.runPromise(storage.close());
  }
}

/**
 * Carry out a plan: retire the crawls, then rebuild the file so the space
 * actually returns to the filesystem.
 *
 * VACUUM is here rather than inside `retireCrawls` because it rewrites the
 * whole database. That is fine once, on request, and would be a serious
 * regression if it ever ran as part of an audit.
 */
export async function runProjectPrune(
  plan: ProjectPrunePlan
): Promise<{ rows: number; bytesBefore: number; bytesAfter: number }> {
  const { SQLiteStorage } = await import("@/crawler/storage/sqlite");
  const { Effect } = await import("effect");

  const storage = new SQLiteStorage(plan.path);
  let rows = 0;
  try {
    await Effect.runPromise(storage.init());
    rows = await Effect.runPromise(
      storage.retireCrawls(plan.retiring.map((c) => c.id))
    );
    await Effect.runPromise(storage.vacuum());
  } finally {
    await Effect.runPromise(storage.close());
  }
  // Measured AFTER the connection closes. With it open the `-wal` still holds
  // the rewrite and the family reads larger than it started.
  return {
    rows,
    bytesBefore: plan.bytesBefore,
    bytesAfter: dbFamilyBytes(plan.path),
  };
}
