/**
 * The squirrelscan agent skills, installed and kept current by the CLI itself:
 * no Node, no npx, no second tool's lock file (#2357).
 *
 * Source: squirrelscan/skills' manifest.json (skills-manifest.ts), which lists
 * every file with its sha256. Targets, per agent: `claude` is
 * `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`), `agents` is
 * `~/.agents/skills` (Codex, Cursor, Gemini CLI and the other Agent Skills
 * tools), or the same two under the current repo with `--project`. Skills are
 * real copies, so they work the same on Windows.
 *
 * What we wrote is recorded per target in `~/.squirrel/skills.json`. A file
 * whose hash no longer matches the record was edited locally and is never
 * overwritten silently: it is kept (and reported) unless `--force`, which backs
 * it up to `~/.squirrel/skills/backups/<timestamp>/` first.
 *
 * Every run plans first, then downloads and verifies every byte any target
 * needs, and only then writes, one target at a time, each built beside the
 * target and swapped in with a rename. A failed or mismatched download writes
 * nothing at all.
 *
 * Installs made earlier by `npx skills` are adopted: its copy becomes ours, its
 * symlinks become copies, and our entries leave its lock file (copied to
 * `<lock>.bak` first) so the two tools stop updating the same folders. A folder
 * holding someone else's skill of the same name, or linking elsewhere (a dev
 * checkout), is left alone.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

import { logger } from "@/utils/logger";

import type { UserSettings } from "./types";

import { version } from "../../package.json";
import { updateSuppressedReason } from "./install-meta";
import { getSquirrelPaths } from "./paths";
import { loadSettings } from "./settings";
import {
  type FetchDeps,
  type ManifestFile,
  type ManifestSkill,
  type SkillsManifest,
  downloadSkillFile,
  fetchSkillsManifest,
  sha256Hex,
} from "./skills-manifest";

export { SKILLS_REPOSITORY, SkillsFetchError } from "./skills-manifest";

/** The skills squirrelscan publishes today; the manifest is the authority. */
export const SKILL_NAMES = ["squirrelscan", "audit-website"] as const;

/** Agents whose skill folders the CLI knows. `all` means every one of them. */
export const AGENT_NAMES = ["claude", "agents"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
export type SkillsScope = "global" | "project";

// ── Where things live ───────────────────────────────────────────────────────

export interface SkillsEnv {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** squirrel's own data dir (~/.squirrel): state, backups, lock, markers. */
  dataDir: string;
}

export function defaultSkillsEnv(): SkillsEnv {
  return {
    home: homedir(),
    cwd: process.cwd(),
    env: process.env,
    dataDir: getSquirrelPaths().data,
  };
}

/**
 * The repo `--project` means: the nearest folder up from cwd holding a `.git`,
 * or cwd itself. The search stops below home, so a dotfiles repo in home is
 * never taken for the project.
 */
export function projectRoot(e: SkillsEnv): string {
  const home = canonical(e.home);
  for (let dir = e.cwd; canonical(dir) !== home; ) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return e.cwd;
}

/** A path as the disk sees it (links resolved, case folded on Windows), for comparing. */
function canonical(path: string): string {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // not there (yet): compare as given
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** The skills folder of one agent, globally or in the current repo. */
export function agentRoot(
  agent: AgentName,
  scope: SkillsScope,
  e: SkillsEnv
): string {
  if (scope === "project") {
    const root = projectRoot(e);
    return join(root, agent === "claude" ? ".claude" : ".agents", "skills");
  }
  if (agent === "claude") {
    return join(e.env.CLAUDE_CONFIG_DIR || join(e.home, ".claude"), "skills");
  }
  return join(e.home, ".agents", "skills");
}

/** The `npx skills` lock for a scope: global (XDG-aware) or the repo's own. */
export function skillsCliLockPath(scope: SkillsScope, e: SkillsEnv): string {
  if (scope === "project") return join(projectRoot(e), "skills-lock.json");
  return e.env.XDG_STATE_HOME
    ? join(e.env.XDG_STATE_HOME, "skills", ".skill-lock.json")
    : join(e.home, ".agents", ".skill-lock.json");
}

const statePath = (e: SkillsEnv) => join(e.dataDir, "skills.json");
export const backupRoot = (e: SkillsEnv) =>
  join(e.dataDir, "skills", "backups");
const opLockPath = (e: SkillsEnv) => join(e.dataDir, "skills.lock");

/** `~/…` for display. */
export function tildify(path: string, e: SkillsEnv): string {
  const rel = relative(e.home, path);
  return rel && !rel.startsWith("..") && !rel.includes(":")
    ? `~${sep}${rel}`
    : path;
}

// ── State: what we wrote ────────────────────────────────────────────────────

export interface TargetRecord {
  agent: AgentName;
  scope: SkillsScope;
  version: string;
  /** The squirrelscan/skills commit the files came from. */
  ref: string;
  updatedAt: string;
  /** Path (relative to the skill dir) → the sha256 we wrote. */
  files: Record<string, string>;
}

export interface SkillsState {
  schema: 1;
  /** skill name → absolute target dir → record */
  skills: Record<string, Record<string, TargetRecord>>;
  /**
   * What an unattended update did that the user should hear about (files it
   * backed up), shown by `squirrel skills status` until the next command run.
   */
  notices?: string[];
  /**
   * Folders `uninstall` left behind because they still hold edited files.
   * Updates don't take these back (the user removed the skill); `install` does.
   */
  released?: string[];
}

export function readState(e: SkillsEnv): SkillsState {
  try {
    const raw = JSON.parse(readFileSync(statePath(e), "utf8")) as SkillsState;
    if (raw?.schema === 1 && raw.skills && typeof raw.skills === "object") {
      return raw;
    }
  } catch {
    // missing or unreadable: nothing recorded
  }
  return { schema: 1, skills: {} };
}

/**
 * A recorded target this run looks at: every global one, and the project ones
 * of the repo it runs in (never from an unattended run). Other repos' copies
 * are theirs: they may be committed, and are updated from inside that repo.
 */
function inView(
  dir: string,
  record: Pick<TargetRecord, "agent" | "scope">,
  e: SkillsEnv,
  auto = false
): boolean {
  if (record.scope === "global") return true;
  return !auto && dirname(dir) === agentRoot(record.agent, "project", e);
}

/** `--project` from home would write the global folders under another name. */
function assertProjectScope(e: SkillsEnv): void {
  if (
    canonical(projectRoot(e)) === canonical(e.home) ||
    AGENT_NAMES.some(
      (a) =>
        canonical(agentRoot(a, "project", e)) ===
        canonical(agentRoot(a, "global", e))
    )
  ) {
    throw new SkillsUsageError(
      "--project needs to run inside a repo, not your home folder"
    );
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameRetry(tmp, path);
}

// ── What is on disk ─────────────────────────────────────────────────────────

export type TargetKind =
  | { kind: "absent" }
  | { kind: "dir" }
  /** A `npx skills` symlink into ~/.agents/skills: adopted as a copy. */
  | { kind: "npx-link"; to: string }
  /** A symlink anywhere else (a dev checkout), or not a directory: left alone. */
  | { kind: "foreign"; to?: string };

export function inspectTarget(dir: string, e: SkillsEnv): TargetKind {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return { kind: "absent" };
  }
  if (stat.isSymbolicLink()) {
    let to: string;
    try {
      to = realpathSync(dir);
    } catch {
      return { kind: "foreign" }; // dangling
    }
    let agents: string;
    try {
      agents = realpathSync(join(e.home, ".agents", "skills"));
    } catch {
      return { kind: "foreign", to };
    }
    const rel = relative(agents, to);
    const inside =
      rel && !rel.startsWith("..") && !rel.includes(":") && !rel.includes(sep);
    return inside ? { kind: "npx-link", to } : { kind: "foreign", to };
  }
  return stat.isDirectory() ? { kind: "dir" } : { kind: "foreign" };
}

/** sha256 of a regular file; "other" for a link, a folder or anything else. */
function hashFile(path: string): string | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return "other";
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return "other";
  }
}

/** A folder on the way to `path` (inside `dir`) that is a link or not a folder. */
function blockedParent(dir: string, path: string): string | undefined {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    try {
      if (!lstatSync(join(dir, sub)).isDirectory()) return sub;
    } catch {
      return undefined; // missing: it will be created, nothing to follow
    }
  }
  return undefined;
}

function frontmatter(dir: string): string | undefined {
  try {
    const head = readFileSync(join(dir, "SKILL.md"), "utf8").slice(0, 4096);
    return head.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Our skill, as someone installed it: a SKILL.md naming it and written by
 * squirrelscan. "audit-website" is a generic name, and a skill of that name
 * from someone else is theirs, not ours to replace.
 */
export function isOurSkill(dir: string, name: string): boolean {
  const fm = frontmatter(dir);
  if (!fm) return false;
  const found = fm.match(/^name:\s*["']?([a-z0-9-]+)/m)?.[1];
  const author = fm.match(/^\s+author:\s*["']?([A-Za-z0-9_.-]+)/m)?.[1];
  return found === name && author?.toLowerCase() === "squirrelscan";
}

/** The version a SKILL.md on disk declares, for installs we didn't record. */
function versionOnDisk(dir: string): string | undefined {
  return frontmatter(dir)?.match(/^\s+version:\s*["']?([^"'\s]+)/m)?.[1];
}

// ── Planning one target ─────────────────────────────────────────────────────

export interface TargetPlan {
  skill: string;
  dir: string;
  agent: AgentName;
  scope: SkillsScope;
  kind: TargetKind["kind"];
  /** Files to (re)write from the manifest. */
  writes: string[];
  /** Files we wrote that upstream dropped. */
  deletes: string[];
  /** Existing files to copy aside before they are replaced or removed. */
  backups: string[];
  /** Local edits left in place. */
  kept: string[];
  /** The subset of `kept` that upstream changed too: still out of date. */
  stale: string[];
  /** Why this target can't be written safely at all. */
  blocked?: string;
}

/**
 * What it takes to bring one target to `skill`. Pure planning: reads the
 * target, writes nothing.
 *
 * - a file matching the manifest: nothing to do
 * - missing, or ours and unedited: written
 * - edited since we wrote it: kept (and `stale` if upstream changed it too),
 *   unless `force`, which backs it up and replaces it
 * - differing with no record of who wrote it (taking over an `npx skills`
 *   copy): backed up, then replaced
 * - a link or folder where a file goes, or a linked folder on the way: the
 *   whole target is blocked, since writing would follow the link out
 */
export function planTarget(
  base: Pick<TargetPlan, "skill" | "dir" | "agent" | "scope" | "kind">,
  skill: ManifestSkill,
  record: TargetRecord | undefined,
  force = false
): TargetPlan {
  const plan: TargetPlan = {
    ...base,
    writes: [],
    deletes: [],
    backups: [],
    kept: [],
    stale: [],
  };
  if (base.kind !== "dir") {
    plan.writes = skill.files.map((f) => f.path);
    return plan;
  }
  const { dir } = base;
  const wanted = new Map(
    skill.files.map((f) => [f.path.toLowerCase(), f.path])
  );
  // A file upstream renamed by case only is the same file on a case-insensitive
  // disk: look its record up by either spelling.
  const recordedLower = new Map(
    Object.entries(record?.files ?? {}).map(([p, sha]) => [
      p.toLowerCase(),
      sha,
    ])
  );
  for (const file of skill.files) {
    const parent = blockedParent(dir, file.path);
    if (parent) {
      plan.blocked = `${parent} is a link or a file, not a folder`;
      return plan;
    }
    const current = hashFile(join(dir, file.path));
    if (current === "other") {
      plan.blocked = `${file.path} is a link or a folder, not a file`;
      return plan;
    }
    if (current === file.sha256) {
      // Already the published bytes; a case-only rename still rewrites it so
      // the name on disk follows upstream.
      if (renamedFrom(record, file.path)) plan.writes.push(file.path);
      continue;
    }
    const recorded =
      record?.files[file.path] ?? recordedLower.get(file.path.toLowerCase());
    if (
      current !== undefined &&
      recorded !== undefined &&
      current !== recorded
    ) {
      if (!force) {
        plan.kept.push(file.path);
        if (recorded !== file.sha256) plan.stale.push(file.path);
        continue;
      }
      plan.backups.push(file.path);
    } else if (current !== undefined && recorded === undefined) {
      plan.backups.push(file.path);
    }
    plan.writes.push(file.path);
  }
  for (const [path, recorded] of Object.entries(record?.files ?? {})) {
    const renamed = wanted.get(path.toLowerCase());
    if (renamed === path) continue;
    if (blockedParent(dir, path)) continue;
    const current = hashFile(join(dir, path));
    if (current === undefined || current === "other") continue;
    if (
      renamed !== undefined &&
      sameFile(join(dir, path), join(dir, renamed))
    ) {
      // Renamed by case, on a case-insensitive disk: one file, planned above
      // under its new name. Unedited, it is deleted and then written back
      // under that name; edited, it is kept there.
      if (current === recorded) plan.deletes.push(path);
      continue;
    }
    if (current === recorded) {
      plan.deletes.push(path);
    } else if (force) {
      plan.backups.push(path);
      plan.deletes.push(path);
    } else {
      plan.kept.push(path);
    }
  }
  return plan;
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/** A recorded path that differs from `path` by case only, if there is one. */
function renamedFrom(
  record: TargetRecord | undefined,
  path: string
): string | undefined {
  if (!record || path in record.files) return undefined;
  return Object.keys(record.files).find(
    (p) => p.toLowerCase() === path.toLowerCase()
  );
}

const pending = (p: TargetPlan) =>
  !p.blocked && (p.writes.length > 0 || p.deletes.length > 0);

// ── One operation ───────────────────────────────────────────────────────────

export type TargetOutcome =
  | "installed"
  | "updated"
  | "adopted"
  | "current"
  | "left-alone"
  | "failed";

export interface TargetResult {
  skill: string;
  dir: string;
  agent: AgentName;
  scope: SkillsScope;
  outcome: TargetOutcome;
  /** The version there before, when known. */
  from?: string;
  version?: string;
  /** Where each backed-up file went (or would go, on a dry run). */
  backups: string[];
  /** Local edits left in place; `stale` ones upstream changed too. */
  kept: string[];
  stale: string[];
  detail?: string;
}

export interface LockCleanup {
  lock: string;
  names: string[];
  backup: string;
}

export interface SyncResult {
  ref?: string;
  dryRun: boolean;
  targets: TargetResult[];
  /** Our entries removed from `npx skills` locks, and where each backup went. */
  lockCleaned: LockCleanup[];
  /** Things that went wrong after the skills themselves were written. */
  warnings: string[];
}

export interface SyncOptions extends FetchDeps {
  /**
   * install: the chosen skills into the chosen agents' folders.
   * update: only skills and targets already present.
   * auto: update, unattended, and never inside a repo.
   */
  mode: "install" | "update" | "auto";
  skills?: string[];
  agents?: readonly AgentName[];
  scope?: SkillsScope;
  force?: boolean;
  dryRun?: boolean;
  e?: SkillsEnv;
  now?: () => Date;
  /** Test seam: a manifest instead of fetching one. */
  manifest?: SkillsManifest;
  /** Runs once the operation lock is held; false abandons the run. */
  onLocked?: () => boolean;
}

export class SkillsBusyError extends Error {}
export class SkillsUsageError extends Error {}
class AbandonedError extends Error {}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockSeen {
  content: string;
  owner: number;
  age: number;
}

function readLock(path: string): LockSeen | undefined {
  try {
    const content = readFileSync(path, "utf8");
    return {
      content,
      owner: Number(content.split(" ")[0]) || 0,
      age: Date.now() - statSync(path).mtimeMs,
    };
  } catch {
    return undefined; // gone
  }
}

/**
 * Create the lock holding `token`, or return false if it exists. The token is
 * written before the lock appears (a hard link of a finished file), so nobody
 * ever reads a half-written lock.
 */
function takeLock(path: string, token: string): boolean {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, token);
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    // No hard links on this drive: an exclusive create instead.
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, token);
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** One skills write at a time across processes (auto refresh vs a command). */
async function withOpLock<T>(e: SkillsEnv, run: () => Promise<T>): Promise<T> {
  const path = opLockPath(e);
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid} ${crypto.randomUUID()}`;
  const busy = () =>
    new SkillsBusyError("another squirrel skills operation is running");
  if (!takeLock(path, token)) {
    const seen = readLock(path);
    // Stale when its owner is gone (Ctrl-C skips cleanup) or after 10 minutes;
    // one with no readable owner only once it is clearly abandoned.
    const stale =
      seen &&
      (seen.owner
        ? !pidAlive(seen.owner) || seen.age > 10 * 60_000
        : seen.age > 30_000);
    if (seen && !stale) throw busy();
    if (seen) {
      // Move it aside, then make sure what moved is the lock judged stale: a
      // run that took the lock in between gets its lock put back.
      const aside = `${path}.stale-${process.pid}`;
      try {
        renameSync(path, aside);
      } catch {
        throw busy();
      }
      const moved = readLock(aside);
      if (moved?.content !== seen.content) {
        try {
          linkSync(aside, path);
        } catch {
          // someone else holds it now either way
        }
        rmSync(aside, { force: true });
        throw busy();
      }
      rmSync(aside, { force: true });
    }
    if (!takeLock(path, token)) throw busy();
  }
  try {
    return await run();
  } finally {
    // Only our own lock: never one another run took after ours went stale.
    if (readLock(path)?.content === token) rmSync(path, { force: true });
  }
}

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

/** rename, retried briefly on Windows, where a scanner or an open file blocks it. */
function renameRetry(from: string, to: string): void {
  const attempts = process.platform === "win32" ? 6 : 1;
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (i + 1 >= attempts || !RETRYABLE.has(code)) throw error;
      Bun.sleepSync(50 * 2 ** i);
    }
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove a folder, or only the link when it is one (never what it points at). */
function removeEntry(path: string): void {
  if (isLink(path)) unlinkSync(path);
  else rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

const LEFTOVER = /^\.(.+)\.squirrel-(new|old)-([a-z0-9-]+)$/;

/**
 * Clear what an interrupted run left beside a skill folder. Agents would
 * otherwise load either copy as a second copy of the skill. A half-built new
 * copy goes. A moved-aside old copy goes back only when the run died between
 * its two renames (the folder is missing and that run's new copy is still
 * there); otherwise the swap finished, and the folder missing now means it
 * was uninstalled or deleted since, so the old copy goes too.
 */
function sweepLeftovers(roots: Iterable<string>): void {
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const match = name.match(LEFTOVER);
      if (!match) continue;
      const path = join(root, name);
      const target = join(root, match[1]!);
      const midSwap = entries.includes(`.${match[1]}.squirrel-new-${match[3]}`);
      try {
        if (
          match[2] === "old" &&
          midSwap &&
          !existsSync(target) &&
          !isLink(target)
        ) {
          renameRetry(path, target);
        } else {
          removeEntry(path);
        }
      } catch {
        // best effort: the next run tries again
      }
    }
  }
}

interface Candidate {
  dir: string;
  agent: AgentName;
  scope: SkillsScope;
}

/** The targets an operation considers for one skill. */
function candidates(
  name: string,
  options: Pick<SyncOptions, "mode" | "agents" | "scope">,
  e: SkillsEnv,
  state: SkillsState
): Candidate[] {
  const out = new Map<string, Candidate>();
  if (options.mode === "install") {
    const scope = options.scope ?? "global";
    for (const agent of options.agents ?? AGENT_NAMES) {
      const dir = join(agentRoot(agent, scope, e), name);
      out.set(dir, { dir, agent, scope });
    }
    return [...out.values()];
  }
  for (const [dir, record] of Object.entries(state.skills[name] ?? {})) {
    if (!inView(dir, record, e, options.mode === "auto")) continue;
    out.set(dir, { dir, agent: record.agent, scope: record.scope });
  }
  for (const agent of AGENT_NAMES) {
    const dir = join(agentRoot(agent, "global", e), name);
    if (out.has(dir) || state.released?.includes(dir)) continue;
    const kind = inspectTarget(dir, e);
    const ours =
      (kind.kind === "dir" && isOurSkill(dir, name)) ||
      (kind.kind === "npx-link" && isOurSkill(kind.to, name));
    if (ours) out.set(dir, { dir, agent, scope: "global" });
  }
  return [...out.values()];
}

/** Which of our skills are installed anywhere we look. No network. */
export function installedSkillNames(
  e: SkillsEnv = defaultSkillsEnv(),
  mode: "update" | "auto" = "update"
): string[] {
  const state = readState(e);
  const names = new Set<string>([...SKILL_NAMES, ...Object.keys(state.skills)]);
  // A skill published after this CLI shipped, installed some other way.
  for (const agent of AGENT_NAMES) {
    try {
      for (const entry of readdirSync(agentRoot(agent, "global", e))) {
        if (!entry.startsWith(".")) names.add(entry);
      }
    } catch {
      // no skills folder
    }
  }
  return [...names]
    .filter((name) => candidates(name, { mode }, e, state).length > 0)
    .sort();
}

function pick(p: TargetPlan) {
  return { skill: p.skill, dir: p.dir, agent: p.agent, scope: p.scope };
}

/**
 * Install or update skills: plan every target, fetch and verify every byte any
 * of them needs, then write. `dryRun` stops after planning and writes nothing.
 */
export async function syncSkills(options: SyncOptions): Promise<SyncResult> {
  const e = options.e ?? defaultSkillsEnv();
  const run = async (): Promise<SyncResult> => {
    if (options.onLocked && !options.onLocked()) throw new AbandonedError();
    const state = readState(e);
    const now = (options.now ?? (() => new Date()))();
    const result: SyncResult = {
      dryRun: Boolean(options.dryRun),
      targets: [],
      lockCleaned: [],
      warnings: [],
    };

    if (options.mode === "install" && options.scope === "project") {
      assertProjectScope(e);
    }
    if (!options.dryRun) {
      const roots = new Set<string>();
      for (const scope of new Set([
        "global",
        options.scope ?? "global",
      ] as const)) {
        for (const agent of AGENT_NAMES) roots.add(agentRoot(agent, scope, e));
      }
      for (const records of Object.values(state.skills)) {
        for (const [dir, record] of Object.entries(records)) {
          if (inView(dir, record, e, options.mode === "auto")) {
            roots.add(dirname(dir));
          }
        }
      }
      sweepLeftovers(roots);
    }

    let names: string[] | undefined;
    if (options.mode !== "install") {
      // An update never reaches for the network when nothing of ours is installed.
      const installed = installedSkillNames(e, options.mode);
      const unknown = (options.skills ?? []).filter(
        (s) => !installed.includes(s)
      );
      if (unknown.length) {
        throw new SkillsUsageError(
          `not installed: ${unknown.join(", ")} (run squirrel skills install ${unknown.join(" ")})`
        );
      }
      names = options.skills?.length ? options.skills : installed;
      if (!names.length) return result;
    }

    const manifest = options.manifest ?? (await fetchSkillsManifest(options));
    result.ref = manifest.ref;
    const published = new Map(manifest.skills.map((s) => [s.name, s]));
    if (options.mode === "install") {
      names = options.skills?.length ? options.skills : [...published.keys()];
      const missing = names.filter((n) => !published.has(n));
      if (missing.length) {
        throw new SkillsUsageError(
          `no such skill: ${missing.join(", ")} (available: ${[...published.keys()].join(", ")})`
        );
      }
    }

    // Phase 1: plan every target.
    const plans: Array<{ plan: TargetPlan; skill: ManifestSkill }> = [];
    for (const name of names!) {
      const skill = published.get(name);
      if (!skill) continue; // installed but no longer published: leave it be
      const records = (state.skills[name] ??= {});
      for (const c of candidates(name, options, e, state)) {
        const kind = inspectTarget(c.dir, e);
        const base = {
          skill: name,
          dir: c.dir,
          agent: c.agent,
          scope: c.scope,
        };
        const leaveAlone = (detail: string) => {
          result.targets.push({
            ...base,
            outcome: "left-alone",
            backups: [],
            kept: [],
            stale: [],
            detail,
          });
          if (!options.dryRun) delete records[c.dir];
        };
        if (kind.kind === "foreign") {
          leaveAlone(
            kind.to ? `a link to ${tildify(kind.to, e)}` : "not a folder"
          );
          continue;
        }
        if (kind.kind === "absent" && options.mode !== "install") {
          if (!options.dryRun) delete records[c.dir]; // removed since: never put back
          continue;
        }
        const probe = kind.kind === "npx-link" ? kind.to : c.dir;
        if (
          kind.kind !== "absent" &&
          !records[c.dir] &&
          existsSync(join(probe, "SKILL.md")) &&
          !isOurSkill(probe, name)
        ) {
          leaveAlone("holds another author's skill of the same name");
          continue;
        }
        plans.push({
          plan: planTarget(
            { ...base, kind: kind.kind },
            skill,
            records[c.dir],
            options.force
          ),
          skill,
        });
      }
    }

    const fromVersion = (p: TargetPlan) =>
      state.skills[p.skill]?.[p.dir]?.version ??
      (p.kind === "absent" ? undefined : versionOnDisk(p.dir));
    const outcomeFor = (p: TargetPlan): TargetOutcome =>
      p.kind === "absent"
        ? "installed"
        : p.kind === "npx-link" || !state.skills[p.skill]?.[p.dir]
          ? "adopted"
          : "updated";
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    // One folder per target: `global-claude`, `project-agents`, plus a hash of
    // the skills folder when it isn't that agent's usual one here.
    const backupPath = (p: TargetPlan, path: string) => {
      const root = dirname(p.dir);
      const usual = root === agentRoot(p.agent, p.scope, e);
      const key = `${p.scope}-${p.agent}${usual ? "" : `-${sha256Hex(new TextEncoder().encode(root)).slice(0, 8)}`}`;
      return join(backupRoot(e), stamp, key, p.skill, path);
    };

    for (const { plan, skill } of plans) {
      if (plan.blocked) {
        result.targets.push({
          ...pick(plan),
          outcome: "failed",
          backups: [],
          kept: [],
          stale: [],
          detail: plan.blocked,
        });
      } else if (!pending(plan)) {
        result.targets.push({
          ...pick(plan),
          outcome: "current",
          from: fromVersion(plan),
          version: skill.version,
          backups: [],
          kept: plan.kept,
          stale: plan.stale,
        });
        if (!options.dryRun) {
          state.skills[plan.skill]![plan.dir] = recordFor(
            plan,
            skill,
            manifest,
            now,
            state.skills[plan.skill]![plan.dir]
          );
        }
      }
    }
    const work = plans.filter(({ plan }) => pending(plan));
    if (options.dryRun) {
      for (const { plan, skill } of work) {
        result.targets.push({
          ...pick(plan),
          outcome: outcomeFor(plan),
          from: fromVersion(plan),
          version: skill.version,
          backups: plan.backups.map((p) => backupPath(plan, p)),
          kept: plan.kept,
          stale: plan.stale,
        });
      }
      return result;
    }

    // Phase 2: every byte any target needs, verified before anything is written.
    const bytes = new Map<string, Map<string, Uint8Array>>();
    for (const { plan, skill } of work) {
      const have = bytes.get(skill.name) ?? new Map<string, Uint8Array>();
      bytes.set(skill.name, have);
      const dirs = work
        .filter((w) => w.skill.name === skill.name)
        .map((w) => w.plan.dir);
      for (const path of plan.writes) {
        if (have.has(path)) continue;
        const file = skill.files.find((f) => f.path === path)!;
        have.set(
          path,
          localCopy(file, dirs) ??
            (await downloadSkillFile(manifest, skill.name, file, options))
        );
      }
    }

    // Phase 3: write, one target at a time.
    for (const { plan, skill } of work) {
      const from = fromVersion(plan);
      const outcome = outcomeFor(plan);
      const backups: string[] = [];
      try {
        for (const path of plan.backups) {
          const to = backupPath(plan, path);
          mkdirSync(dirname(to), { recursive: true });
          // Never over an earlier backup: that would lose the file it holds.
          cpSync(join(plan.dir, path), to, {
            errorOnExist: true,
            force: false,
          });
          backups.push(to);
        }
        swapIn(plan, bytes.get(skill.name)!, result.warnings);
      } catch (error) {
        result.targets.push({
          ...pick(plan),
          outcome: "failed",
          backups,
          kept: [],
          stale: [],
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      state.skills[plan.skill]![plan.dir] = recordFor(
        plan,
        skill,
        manifest,
        now,
        state.skills[plan.skill]![plan.dir]
      );
      result.targets.push({
        ...pick(plan),
        outcome,
        from,
        version: skill.version,
        backups,
        kept: plan.kept,
        stale: plan.stale,
      });
    }

    for (const [name, records] of Object.entries(state.skills)) {
      if (!Object.keys(records).length) delete state.skills[name];
    }
    const released = (state.released ?? []).filter(
      (dir) =>
        existsSync(dir) &&
        !result.targets.some((t) => t.dir === dir && t.outcome !== "failed")
    );
    if (released.length) state.released = released;
    else delete state.released;
    // An unattended run has nobody to tell; `status` says it for it.
    const backedUp = result.targets.flatMap((t) => t.backups);
    if (options.mode === "auto") {
      if (backedUp.length) {
        state.notices = [
          ...(state.notices ?? []),
          `${now.toISOString().slice(0, 10)}: the automatic update backed up ${backedUp.length} file(s) that differed from the published version to ${tildify(join(backupRoot(e), stamp), e)}`,
        ];
      }
    } else {
      delete state.notices;
    }
    try {
      writeJsonAtomic(statePath(e), state);
    } catch (error) {
      result.warnings.push(
        `could not save ${tildify(statePath(e), e)}: ${(error as Error).message}`
      );
    }
    for (const scope of new Set([
      "global",
      options.scope ?? "global",
    ] as const)) {
      try {
        const cleaned = releaseFromSkillsCli(e, scope, state);
        if (cleaned) result.lockCleaned.push(cleaned);
      } catch (error) {
        result.warnings.push(
          `could not update the npx skills lock: ${(error as Error).message}`
        );
      }
    }
    return result;
  };
  return options.dryRun ? run() : withOpLock(e, run);
}

export type InstallSkillsOptions = Omit<SyncOptions, "mode" | "onLocked">;

/**
 * Install skills from code (`squirrel setup`): the same as `squirrel skills
 * install`. Defaults: every published skill, both agents, global. Each target
 * in the result carries its skill and outcome. Throws when the manifest can't
 * be fetched, a skill name is unknown, or another skills run holds the lock.
 */
export function installSkills(
  options: InstallSkillsOptions = {}
): Promise<SyncResult> {
  return syncSkills({ ...options, mode: "install" });
}

/** The skills folders installs go to by default: one per known agent. */
export function defaultSkillRoots(e: SkillsEnv = defaultSkillsEnv()): string[] {
  return AGENT_NAMES.map((agent) => agentRoot(agent, "global", e));
}

/** Default skills folders that already hold every squirrelscan skill. */
export function installedSkillRoots(
  e: SkillsEnv = defaultSkillsEnv()
): string[] {
  return defaultSkillRoots(e).filter((root) =>
    SKILL_NAMES.every((name) => {
      const dir = join(root, name);
      const kind = inspectTarget(dir, e);
      if (kind.kind === "dir") return isOurSkill(dir, name);
      return kind.kind === "npx-link" && isOurSkill(kind.to, name);
    })
  );
}

/**
 * The record after a run. A kept edit keeps the hash we recorded before, so it
 * still reads as edited next time; everything else records what was written.
 */
function recordFor(
  plan: TargetPlan,
  skill: ManifestSkill,
  manifest: SkillsManifest,
  now: Date,
  previous: TargetRecord | undefined
): TargetRecord {
  return {
    agent: plan.agent,
    scope: plan.scope,
    version: skill.version,
    ref: manifest.ref,
    updatedAt: now.toISOString(),
    files: Object.fromEntries(
      skill.files.map((f) => [
        f.path,
        (plan.kept.includes(f.path) &&
          (previous?.files[f.path] ??
            previous?.files[renamedFrom(previous, f.path) ?? ""])) ||
          f.sha256,
      ])
    ),
  };
}

/** A file already on disk with exactly the manifest's bytes, if there is one. */
function localCopy(file: ManifestFile, dirs: string[]): Uint8Array | undefined {
  for (const dir of dirs) {
    try {
      const path = join(dir, file.path);
      if (!lstatSync(path).isFile()) continue;
      const local = readFileSync(path);
      if (local.byteLength === file.size && sha256Hex(local) === file.sha256) {
        return local;
      }
    } catch {
      // not there
    }
  }
  return undefined;
}

/**
 * Build the new skill dir beside the old one and rename it into place. The
 * staging copy starts from the existing dir, so files that aren't ours (a
 * user's notes, kept edits) survive. If the final rename fails the old dir
 * goes back; if even that fails, both copies stay and the error names them.
 */
function swapIn(
  plan: TargetPlan,
  bytes: Map<string, Uint8Array>,
  warnings: string[]
): void {
  const parent = dirname(plan.dir);
  const base = basename(plan.dir);
  const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const staging = join(parent, `.${base}.squirrel-new-${tag}`);
  const old = join(parent, `.${base}.squirrel-old-${tag}`);
  mkdirSync(parent, { recursive: true });
  let keepStaging = false;
  try {
    if (plan.kind === "dir") {
      cpSync(plan.dir, staging, { recursive: true, verbatimSymlinks: true });
    } else {
      mkdirSync(staging);
    }
    for (const path of plan.deletes)
      rmSync(join(staging, path), { force: true });
    for (const path of plan.writes) {
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      rmSync(target, { force: true });
      writeFileSync(target, bytes.get(path)!);
    }
    pruneEmptyDirs(staging);
    if (plan.kind === "absent") {
      renameRetry(staging, plan.dir);
      return;
    }
    renameRetry(plan.dir, old); // for a link, moves the link, not its target
    try {
      renameRetry(staging, plan.dir);
    } catch (error) {
      try {
        renameRetry(old, plan.dir);
      } catch {
        keepStaging = true;
        throw new Error(
          `could not swap in the new copy or put the old one back: old at ${old}, new at ${staging} (${(error as Error).message})`
        );
      }
      throw error;
    }
    try {
      removeEntry(old);
    } catch (error) {
      warnings.push(
        `left the previous copy at ${old}: ${(error as Error).message}`
      );
    }
  } finally {
    if (!keepStaging) rmSync(staging, { recursive: true, force: true });
  }
}

function pruneEmptyDirs(dir: string): boolean {
  let empty = true;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && pruneEmptyDirs(path)) {
      rmSync(path, { recursive: true, force: true });
    } else {
      empty = false;
    }
  }
  return empty;
}

/**
 * A `npx skills` lock entry installed from our repo (the skills' home, or the
 * old public repo), by its `source` or `sourceUrl`. Anyone else's entry of the
 * same name stays theirs.
 */
function fromUs(entry: unknown): boolean {
  const { source, sourceUrl } = (entry ?? {}) as Record<string, unknown>;
  return [source, sourceUrl].some(
    (v) =>
      typeof v === "string" &&
      /^(?:(?:https?:\/\/|git@)github\.com[/:])?squirrelscan\/(?:skills|squirrelscan)(?:\.git)?\/?$/i.test(
        v.trim()
      )
  );
}

/**
 * Take the skills we now manage out of the `npx skills` lock for a scope, so
 * `npx skills update` stops rewriting the same folders. The lock is copied to
 * `<lock>.bak` first. A lock older than the layout skills 1.x reads is left
 * alone, and so is any entry for a skill we don't manage there.
 */
function releaseFromSkillsCli(
  e: SkillsEnv,
  scope: SkillsScope,
  state: SkillsState
): LockCleanup | undefined {
  const path = skillsCliLockPath(scope, e);
  let lock: { version?: unknown; skills?: Record<string, unknown> };
  try {
    lock = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  const minVersion = scope === "global" ? 3 : 1;
  if (
    typeof lock?.version !== "number" ||
    lock.version < minVersion ||
    !lock.skills
  ) {
    return undefined;
  }
  const names = Object.entries(state.skills)
    .filter(([, records]) =>
      Object.entries(records).some(
        ([d, r]) => r.scope === scope && inView(d, r, e)
      )
    )
    .map(([name]) => name)
    .filter((name) => fromUs(lock.skills![name]));
  if (!names.length) return undefined;
  const backup = `${path}.bak`;
  cpSync(path, backup);
  for (const name of names) delete lock.skills[name];
  writeJsonAtomic(path, lock);
  return { lock: path, names, backup };
}

// ── Status and uninstall ────────────────────────────────────────────────────

export interface TargetStatus {
  dir: string;
  root: string;
  /** squirrel: we manage it. npx skills: that tool still does. other: not ours. */
  managedBy: "squirrel" | "npx skills" | "unmanaged" | "other";
  version?: string;
  editedFiles: string[];
  linkTo?: string;
  /** Out of date against the manifest (kept edits aside). */
  outdated: boolean;
  /** Left by `uninstall` with edited files in it: updates leave it alone. */
  released?: boolean;
  /** Why an update can't write here (a link or folder in the way). */
  blocked?: string;
}

export interface SkillStatus {
  name: string;
  latest?: string;
  targets: TargetStatus[];
}

function lockNames(scope: SkillsScope, e: SkillsEnv): string[] {
  try {
    const lock = JSON.parse(readFileSync(skillsCliLockPath(scope, e), "utf8"));
    return Object.entries(lock.skills ?? {})
      .filter(([, entry]) => fromUs(entry))
      .map(([name]) => name);
  } catch {
    return [];
  }
}

/** What is installed where, against the latest published version when known. */
export function skillsStatus(
  manifest: SkillsManifest | undefined,
  e: SkillsEnv = defaultSkillsEnv()
): SkillStatus[] {
  const state = readState(e);
  const npx = lockNames("global", e);
  const names = new Set<string>([
    ...SKILL_NAMES,
    ...(manifest?.skills.map((s) => s.name) ?? []),
    ...Object.keys(state.skills),
  ]);
  return [...names].map((name) => {
    const records = state.skills[name] ?? {};
    const skill = manifest?.skills.find((s) => s.name === name);
    const dirs = new Set([
      ...Object.entries(records)
        .filter(([dir, r]) => inView(dir, r, e))
        .map(([dir]) => dir),
      ...AGENT_NAMES.map((a) => join(agentRoot(a, "global", e), name)),
    ]);
    const targets: TargetStatus[] = [];
    for (const dir of dirs) {
      const kind = inspectTarget(dir, e);
      if (kind.kind === "absent") continue;
      const root = dirname(dir);
      const record = records[dir];
      if (kind.kind !== "dir" || !record) {
        const probe = kind.kind === "npx-link" ? kind.to : dir;
        if (kind.kind === "foreign" || !isOurSkill(probe, name)) {
          if (kind.kind === "foreign" || existsSync(join(probe, "SKILL.md"))) {
            targets.push({
              dir,
              root,
              managedBy: "other",
              linkTo: "to" in kind ? kind.to : undefined,
              editedFiles: [],
              outdated: false,
            });
          }
          continue;
        }
        const released = state.released?.includes(dir) ?? false;
        // The same plan `update` makes before taking the copy over.
        const plan =
          !released && skill
            ? planTarget(
                {
                  skill: name,
                  dir,
                  agent: "agents",
                  scope: "global",
                  kind: kind.kind,
                },
                skill,
                undefined
              )
            : undefined;
        targets.push({
          dir,
          root,
          managedBy: npx.includes(name) ? "npx skills" : "unmanaged",
          version: versionOnDisk(probe),
          linkTo: kind.kind === "npx-link" ? kind.to : undefined,
          editedFiles: [],
          outdated: plan ? pending(plan) : false,
          ...(released ? { released } : {}),
          ...(plan?.blocked ? { blocked: plan.blocked } : {}),
        });
        continue;
      }
      const editedFiles = Object.entries(record.files)
        .filter(([path, sha]) => {
          const current = hashFile(join(dir, path));
          return current !== undefined && current !== sha;
        })
        .map(([path]) => path);
      const plan = skill
        ? planTarget(
            {
              skill: name,
              dir,
              agent: record.agent,
              scope: record.scope,
              kind: "dir",
            },
            skill,
            record
          )
        : undefined;
      targets.push({
        dir,
        root,
        managedBy: "squirrel",
        version: record.version,
        editedFiles,
        outdated: plan ? pending(plan) : false,
        ...(plan?.blocked ? { blocked: plan.blocked } : {}),
      });
    }
    return { name, latest: skill?.version, targets };
  });
}

/** Notices left by unattended updates, for `squirrel skills status`. */
export function skillsNotices(e: SkillsEnv = defaultSkillsEnv()): string[] {
  return readState(e).notices ?? [];
}

export interface UninstallOptions {
  skills?: string[];
  agents?: readonly AgentName[];
  scope?: SkillsScope;
  e?: SkillsEnv;
}

export interface UninstallResult {
  /** Folders removed entirely. */
  removed: string[];
  /** Folders we emptied of our files but that hold something else too. */
  emptied: string[];
  /** Files left in place because they were edited after we wrote them. */
  kept: string[];
}

/** Remove what squirrel wrote, and only that: edited and foreign files stay. */
export async function uninstallSkills(
  options: UninstallOptions = {}
): Promise<UninstallResult> {
  const e = options.e ?? defaultSkillsEnv();
  if (options.scope === "project") assertProjectScope(e);
  return withOpLock(e, async () => {
    const state = readState(e);
    const result: UninstallResult = { removed: [], emptied: [], kept: [] };
    for (const [name, records] of Object.entries(state.skills)) {
      if (options.skills?.length && !options.skills.includes(name)) continue;
      for (const [dir, record] of Object.entries(records)) {
        if (options.agents && !options.agents.includes(record.agent)) continue;
        if (options.scope && record.scope !== options.scope) continue;
        if (!inView(dir, record, e)) continue; // another repo's copy
        delete records[dir];
        if (inspectTarget(dir, e).kind !== "dir") continue;
        for (const [path, sha] of Object.entries(record.files)) {
          if (blockedParent(dir, path)) continue; // never follow a link out
          const file = join(dir, path);
          const current = hashFile(file);
          if (current === undefined || current === "other") continue;
          if (current === sha) rmSync(file, { force: true });
          else result.kept.push(file);
        }
        const released = new Set(state.released);
        if (pruneEmptyDirs(dir)) {
          rmSync(dir, { recursive: true, force: true });
          result.removed.push(dir);
          released.delete(dir);
        } else {
          result.emptied.push(dir);
          released.add(dir);
        }
        state.released = [...released];
      }
      if (!Object.keys(records).length) delete state.skills[name];
    }
    if (!state.released?.length) delete state.released;
    writeJsonAtomic(statePath(e), state);
    return result;
  });
}

// ── The refresh that follows a CLI auto-update ─────────────────────────────

/** Budget for the whole unattended refresh: manifest, downloads and writes. */
export const SKILLS_REFRESH_BUDGET_MS = 60_000;

export type SkillsRefreshOutcome =
  | "already_ran"
  | "suppressed"
  | "disabled"
  | "none_installed"
  | "done"
  | "busy"
  | "failed";

export interface SkillsRefreshDeps extends FetchDeps {
  e?: SkillsEnv;
  suppressed?: () => string | null;
  /** auto_update and skills_auto_update, read from settings by default. */
  enabled?: () => boolean;
  budgetMs?: number;
  manifest?: SkillsManifest;
}

/** Skills follow `auto_update`; `skills_auto_update` opts out of skills alone. */
export function skillsAutoUpdateEnabled(
  settings: Pick<UserSettings, "auto_update" | "skills_auto_update">
): boolean {
  return settings.auto_update && settings.skills_auto_update !== false;
}

/**
 * Where each CLI version records that its refresh ran: one file per version,
 * created exclusively once the operation lock is held, so parallel first runs
 * and a run that could not clear the update marker never refresh twice.
 */
export function skillsRefreshMarkerDir(
  e: SkillsEnv = defaultSkillsEnv()
): string {
  return join(e.dataDir, "skills-refresh");
}

function claimRefresh(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    closeSync(openSync(join(dir, version), "wx"));
  } catch {
    return false;
  }
  for (const name of readdirSync(dir)) {
    if (name !== version) rmSync(join(dir, name), { force: true });
  }
  return true;
}

/**
 * Bring the installed squirrelscan skills current, silently: the body of the
 * detached `squirrel skills update --auto` child that the first run on a
 * freshly auto-updated binary starts (maybeSpawnSkillsRefresh).
 *
 * Updates only skills already installed outside any repo (no network at all
 * when there are none), never prompts, keeps local edits, stops at the budget,
 * and never throws: the CLI update it follows has already landed.
 */
export async function runSkillsAutoRefresh(
  deps: SkillsRefreshDeps = {}
): Promise<SkillsRefreshOutcome> {
  const e = deps.e ?? defaultSkillsEnv();
  try {
    const suppressed = (deps.suppressed ?? updateSuppressedReason)();
    if (suppressed) return done("suppressed", { reason: suppressed });
    const enabled =
      deps.enabled ??
      (() => {
        const settings = loadSettings();
        return settings.ok && skillsAutoUpdateEnabled(settings.data);
      });
    if (!enabled()) return done("disabled");
    if (!installedSkillNames(e, "auto").length) return done("none_installed");
    const signal = AbortSignal.timeout(
      deps.budgetMs ?? SKILLS_REFRESH_BUDGET_MS
    );
    const result = await syncSkills({
      mode: "auto",
      e,
      fetch: deps.fetch,
      signal: deps.signal ? AbortSignal.any([signal, deps.signal]) : signal,
      manifest: deps.manifest,
      onLocked: () => claimRefresh(skillsRefreshMarkerDir(e)),
    });
    return done("done", {
      targets: result.targets.map((t) => `${t.skill}:${t.outcome}`),
    });
  } catch (error) {
    if (error instanceof AbandonedError) return done("already_ran");
    if (error instanceof SkillsBusyError) return done("busy");
    return done("failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function done(
  outcome: SkillsRefreshOutcome,
  detail: Record<string, unknown> = {}
): SkillsRefreshOutcome {
  logger.debug("skills-refresh: finished", { outcome, ...detail });
  return outcome;
}

/**
 * Start the silent skills refresh once a CLI auto-update has landed: on the
 * first run of the new binary, the one that also prints "✓ squirrel
 * auto-updated" and clears the marker. Detached, so the command the user typed
 * never waits on it. Same opt-outs as auto-update, plus skills_auto_update.
 */
export function maybeSpawnSkillsRefresh(
  settings: UserSettings,
  deps: {
    spawn?: typeof spawn;
    suppressed?: () => string | null;
    markerDir?: string;
  } = {}
): boolean {
  const applied = settings.auto_update_applied;
  if (!applied || applied.to_version !== version) return false;
  if (!skillsAutoUpdateEnabled(settings)) return false;
  if ((deps.suppressed ?? updateSuppressedReason)()) return false;
  // Already refreshed for this version (the child claims it): don't spawn.
  if (existsSync(join(deps.markerDir ?? skillsRefreshMarkerDir(), version))) {
    return false;
  }
  try {
    const child = (deps.spawn ?? spawn)(
      process.execPath,
      ["skills", "update", "--auto"],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.once("error", (error: Error) => {
      logger.debug("skills-refresh: failed to start", { error: error.message });
    });
    child.unref();
    return true;
  } catch (error) {
    logger.debug("skills-refresh: failed to spawn", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
