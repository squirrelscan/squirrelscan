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
import {
  existsSync,
  readdirSync,
  statfsSync,
  statSync,
  type Dirent,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

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

/** An unfinished crawl, as prune lists it. */
export interface CrawlRef {
  readonly id: string;
  readonly status: string;
  readonly startedAt: number;
  /** Latest page or frontier timestamp; set on skipped crawls. */
  readonly lastActivityAt?: number;
  /** The crawl lease (#946): which process holds it and when it last beat. */
  readonly ownerPid?: number;
  readonly ownerHost?: string;
  readonly heartbeatAt?: number;
}

/** What retiring would remove from one project. */
export interface ProjectPrunePlan {
  readonly name: string;
  readonly path: string;
  /** Audits that would stop being renderable, oldest first. */
  readonly retiring: ReadonlyArray<{ id: string; startedAt: number }>;
  /**
   * Crawls from audits that never finished (killed, `kill -9`, OOM), older than
   * the project's newest finished audit and idle for 30 minutes (#941), or whose
   * recorded owner is gone (#946, see isCrawlAbandoned). Retired along with
   * `retiring`, and they take no slot of the `--keep` window. Oldest first.
   */
  readonly abandoned: ReadonlyArray<CrawlRef>;
  /**
   * Unfinished crawls NEWER than the newest finished audit, active in the
   * last 30 minutes, or held by a live lease (#946): possibly a live audit, possibly a `crawled` crawl awaiting `analyze`. Never retired; listed
   * so the skip is stated rather than silent. Newest first.
   */
  readonly skippedLive: ReadonlyArray<CrawlRef>;
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
    const abandoned = await Effect.runPromise(storage.listAbandonedCrawls());
    // A crawl still stamped `building` whose report may be in the making (#288) is
    // planned around like a possibly live audit: retiring it would be skipped by
    // the transaction, so the plan names it instead of counting it.
    const buildingLive = (
      await Effect.runPromise(storage.listLiveBuildingReports())
    ).map(
      (c): CrawlRef => ({
        id: c.id,
        status: "building",
        startedAt: c.startedAt,
        lastActivityAt: c.startedAt,
      })
    );
    const skippedLive = [
      ...(await Effect.runPromise(storage.listPossiblyLiveCrawls())),
      ...buildingLive,
    ];
    const unfinished = new Set([
      ...abandoned.map((c) => c.id),
      ...skippedLive.map((c) => c.id),
    ]);
    // listCrawls is newest first; everything past the window retires, except
    // what an audit already retired — re-retiring deletes nothing and would
    // print an audit as going when it went days ago. Unfinished crawls are
    // planned separately: a killed audit is not one of the audits being kept,
    // so it neither takes a slot nor pushes a finished audit out of the window.
    // Already-retired crawls are dropped BEFORE the window is applied: they
    // cannot be opened, so they must not hold a slot. Otherwise a retired
    // abandoned crawl sitting between two finished audits would push the older
    // one out of the window on the second prune.
    const retiring = crawls
      .filter((c) => !unfinished.has(c.id) && c.retiredAt === undefined)
      .slice(Math.max(0, keep))
      .map((c) => ({
        id: c.id,
        startedAt: c.startedAt,
      }));
    // Audits that can still be opened after this runs. Counting every crawl row
    // would include the ones an earlier pass already retired and describe a
    // history the user does not have: seven listed, four retired, "keeping 6".
    const stillRenderable = crawls.filter(
      (c) => c.retiredAt === undefined && !unfinished.has(c.id)
    ).length;

    const toRetire = [
      ...retiring.map((c) => c.id),
      ...abandoned.map((c) => c.id),
    ];
    const preview =
      toRetire.length > 0
        ? await Effect.runPromise(storage.previewRetireCrawls(toRetire))
        : { totalRows: 0 };
    // Row count is not the test for "is there anything to do". An audit outside
    // the window with nothing deletable left in it is still retired by this —
    // stamped, and refused by `report` afterwards — so a plan with no rows and
    // an audit in it is a plan, and the caller has to describe it as one.
    if (
      retiring.length === 0 &&
      abandoned.length === 0 &&
      skippedLive.length === 0 &&
      preview.totalRows === 0 &&
      reclaimableBytes < RECLAIM_FLOOR_BYTES
    ) {
      return null;
    }

    return {
      name: dbPath,
      path: dbPath,
      retiring: [...retiring].reverse(),
      abandoned: [...abandoned].reverse(),
      skippedLive,
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
export async function runProjectPrune(plan: ProjectPrunePlan): Promise<{
  rows: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Why the file was not rebuilt, when it was not. The crawls still retired. */
  vacuumSkipped?: string;
  /** Crawls the transaction held back because they no longer qualified (resumed, or a report being built). */
  skippedCrawls?: string[];
}> {
  const { SQLiteStorage } = await import("@/crawler/storage/sqlite");
  const { Effect } = await import("effect");

  const storage = new SQLiteStorage(plan.path);
  let rows = 0;
  let skippedCrawls: string[] = [];
  let vacuumSkipped: string | undefined;
  try {
    await Effect.runPromise(storage.init());
    // The one-time repair of rows superseded before automatic retention (#289),
    // chunked and marked done; a project pruned before it ever ran an audit
    // since the upgrade is repaired here.
    await Effect.runPromise(
      storage
        .repairSupersededPagesOnce()
        .pipe(Effect.catchAll(() => Effect.void))
    );
    // `allowAbandoned` lets the unfinished ones through, and only those that
    // still satisfy the abandoned predicate inside the retiring transaction: a
    // crawl resumed since the plan was made is skipped, not gutted, and the
    // rest of the project is still retired.
    const retired = await Effect.runPromise(
      storage.retireCrawlsDetailed(
        [...plan.retiring, ...plan.abandoned].map((c) => c.id),
        Date.now(),
        { allowAbandoned: true }
      )
    );
    rows = retired.deleted;
    skippedCrawls = retired.skipped;
    // VACUUM writes a full copy next to the file before swapping it in.
    vacuumSkipped = lowDiskReason(plan.path);
    if (vacuumSkipped === undefined) await Effect.runPromise(storage.vacuum());
  } finally {
    await Effect.runPromise(storage.close());
  }
  // Measured AFTER the connection closes. With it open the `-wal` still holds
  // the rewrite and the family reads larger than it started.
  return {
    rows,
    bytesBefore: plan.bytesBefore,
    bytesAfter: dbFamilyBytes(plan.path),
    skippedCrawls,
    ...(vacuumSkipped === undefined ? {} : { vacuumSkipped }),
  };
}

/**
 * A reason not to VACUUM when the volume cannot hold a second copy of the file,
 * else undefined. An unreadable free-space figure does not block the rebuild.
 */
export function lowDiskReason(
  dbPath: string,
  freeBytes: number | undefined = freeBytesAt(dirname(dbPath))
): string | undefined {
  if (freeBytes === undefined) return undefined;
  const needed = Math.ceil(dbFamilyBytes(dbPath) * 1.1) + 64 * 1024 * 1024;
  if (freeBytes >= needed) return undefined;
  return `not enough free disk to rebuild (needs ${formatBytes(needed)}, ${formatBytes(freeBytes)} free)`;
}

function freeBytesAt(dir: string): number | undefined {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

/** How one project went through a prune. */
export interface PruneOutcome {
  readonly name: string;
  /** `skipped` is not a failure: nothing was wrong, or it was held back safely. */
  readonly status: "ok" | "skipped" | "failed";
  readonly reason?: string;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  /** Crawls the retiring transaction held back (#288): still being built, or resumed. */
  readonly skippedCrawls?: number;
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Plan every project, one failure at a time: a locked or unreadable database
 * is reported against its project and the rest are still planned (#941).
 */
export async function planProjects(
  entries: ReadonlyArray<{ name: string; dbPath: string }>,
  keep: number,
  plan: typeof planProjectPrune = planProjectPrune
): Promise<{
  plans: Array<{ name: string; plan: ProjectPrunePlan }>;
  failed: PruneOutcome[];
}> {
  const plans: Array<{ name: string; plan: ProjectPrunePlan }> = [];
  const failed: PruneOutcome[] = [];
  for (const { name, dbPath } of entries) {
    try {
      const p = await plan(dbPath, keep);
      if (p) plans.push({ name, plan: p });
    } catch (e) {
      failed.push({
        name,
        status: "failed",
        reason: `could not plan: ${errorMessage(e)}`,
        bytesBefore: 0,
        bytesAfter: 0,
      });
    }
  }
  return { plans, failed };
}

/** Whether a plan has anything to act on, or only skipped crawls to report. */
export function planIsActionable(plan: ProjectPrunePlan): boolean {
  return (
    plan.retiring.length > 0 ||
    plan.abandoned.length > 0 ||
    plan.rows > 0 ||
    plan.reclaimableBytes >= RECLAIM_FLOOR_BYTES
  );
}

/** Run the plans, isolating each project so one failure cannot stop the rest. */
export async function runPrunePlans(
  plans: ReadonlyArray<{ name: string; plan: ProjectPrunePlan }>,
  run: typeof runProjectPrune = runProjectPrune
): Promise<PruneOutcome[]> {
  const outcomes: PruneOutcome[] = [];
  for (const { name, plan } of plans) {
    if (!planIsActionable(plan)) continue;
    try {
      const result = await run(plan);
      outcomes.push({
        name,
        status: result.vacuumSkipped === undefined ? "ok" : "skipped",
        ...(result.vacuumSkipped === undefined
          ? {}
          : { reason: result.vacuumSkipped }),
        bytesBefore: result.bytesBefore,
        bytesAfter: result.bytesAfter,
        ...(result.skippedCrawls?.length
          ? { skippedCrawls: result.skippedCrawls.length }
          : {}),
      });
    } catch (e) {
      outcomes.push({
        name,
        status: "failed",
        reason: errorMessage(e),
        bytesBefore: plan.bytesBefore,
        bytesAfter: plan.bytesBefore,
      });
    }
  }
  return outcomes;
}

/** 1 when any project failed; skips are not failures. */
export function pruneExitCode(outcomes: ReadonlyArray<PruneOutcome>): 0 | 1 {
  return outcomes.some((o) => o.status === "failed") ? 1 : 0;
}

/** "3d", "5h", "12m": how long ago, coarse on purpose. */
export function formatAge(startedAt: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (minutes >= 2880) return `${Math.floor(minutes / 1440)}d`;
  if (minutes >= 120) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}
