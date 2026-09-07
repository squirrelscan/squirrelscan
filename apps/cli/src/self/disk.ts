// What `~/.squirrel` is costing, per project and in total (#1912).
//
// A re-audit of the same project writes a whole new crawl and retires nothing,
// so `project.db` grows by about one audit every time. Measured on a 1,000-page
// site: 95 MB after one audit, 189 MB after two, with `rule_results` and its two
// indexes accounting for 69.6% of the file and `pages` for another 28.2%.
//
// There is currently no way for anyone to discover that, which is the first
// thing to fix: a 10,000-page site audited weekly adds most of a gigabyte a
// week and nothing says so. This reports; it does not delete.

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
  ruleResultRows: number;
  unreadable?: string;
} {
  if (!existsSync(dbPath)) return { crawls: 0, ruleResultRows: 0 };
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const crawls = db.query("SELECT COUNT(*) AS c FROM crawls").get() as {
      c: number;
    } | null;
    const rules = db.query("SELECT COUNT(*) AS c FROM rule_results").get() as {
      c: number;
    } | null;
    return {
      crawls: crawls?.c ?? 0,
      ruleResultRows: rules?.c ?? 0,
    };
  } catch (error) {
    // A database from an older schema, or one a concurrent audit holds locked,
    // still has a size worth reporting. Say why the counts are missing rather
    // than dropping the project from the table.
    return {
      crawls: 0,
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
