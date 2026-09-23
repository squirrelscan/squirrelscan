/**
 * The squirrelscan agent skills, as the `skills` CLI (npx skills) installed
 * them: which of ours are installed, where from, and the `skills` commands that
 * bring them current.
 *
 * github.com/squirrelscan/skills is the only home of the skills. The skills CLI
 * records each skill's source in a lock file and updates a skill from that
 * source. Installs made before squirrelscan/skills was canonical recorded
 * squirrelscan/squirrelscan, which no longer carries the skills, so those are
 * re-added from squirrelscan/skills rather than updated.
 *
 * Shared by `squirrel skills update` and the refresh that follows a CLI
 * auto-update (runSkillsAutoRefresh). Flags checked against skills 1.7.0:
 * `update [names...]` filters by skill NAME (a repo there matches nothing),
 * `-g` / `-p` pick the scope, `-y` answers every prompt, and `add --skill <names>`
 * installs only the named skills.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { logger } from "@/utils/logger";

import type { UserSettings } from "./types";

import { version } from "../../package.json";
import { updateSuppressedReason } from "./install-meta";
import { getSquirrelPaths } from "./paths";

export const SKILL_REPO = "squirrelscan/skills";
export const SKILL_NAMES = ["squirrelscan", "audit-website"] as const;
export const LEGACY_SOURCE = "squirrelscan/squirrelscan";
// Every `skills` invocation, interactive or not, runs the major whose flags the
// argv here was checked against.
export const SKILLS_CLI = "skills@1";

export type SkillName = (typeof SKILL_NAMES)[number];
export type SkillScope = "global" | "project";

export interface InstalledSkill {
  name: SkillName;
  scope: SkillScope;
  /** Recorded from squirrelscan/squirrelscan: re-add it, don't update it. */
  legacy: boolean;
}

/**
 * Where the skills CLI keeps its locks: the global one under $XDG_STATE_HOME
 * when set, else ~/.agents, and the project one in the working directory.
 */
export function skillLockPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  cwd: string = process.cwd()
): Record<SkillScope, string> {
  return {
    global: env.XDG_STATE_HOME
      ? join(env.XDG_STATE_HOME, "skills", ".skill-lock.json")
      : join(home, ".agents", ".skill-lock.json"),
    project: join(cwd, "skills-lock.json"),
  };
}

// `source` is owner/repo for a GitHub install; `sourceUrl` is the clone URL,
// https or ssh (git@github.com:owner/repo.git).
const isLegacySource = (value: unknown): boolean =>
  typeof value === "string" &&
  /(^|[/:])squirrelscan\/squirrelscan$/.test(
    value.toLowerCase().replace(/\.git$/, "")
  );

// The oldest lock layout skills 1.x reads; it treats an older one as empty, and
// so must we, or a re-add would rewrite it with nothing but our entry.
const MIN_LOCK_VERSION: Record<SkillScope, number> = { global: 3, project: 1 };

/** Our skills the lock files record. A missing or unreadable lock records none. */
export async function readInstalledSkills(
  paths: Record<SkillScope, string> = skillLockPaths()
): Promise<InstalledSkill[]> {
  const installed: InstalledSkill[] = [];
  for (const scope of ["global", "project"] as const) {
    let lock: { version?: unknown; skills?: Record<string, unknown> } | null;
    try {
      lock = await Bun.file(paths[scope]).json();
    } catch {
      continue;
    }
    if (typeof lock?.version !== "number") continue;
    if (lock.version < MIN_LOCK_VERSION[scope]) continue;
    const skills = lock.skills;
    if (!skills || typeof skills !== "object") continue;
    for (const name of SKILL_NAMES) {
      const entry = skills[name] as
        | { source?: unknown; sourceUrl?: unknown }
        | undefined;
      if (!entry || typeof entry !== "object") continue;
      installed.push({
        name,
        scope,
        legacy: isLegacySource(entry.source) || isLegacySource(entry.sourceUrl),
      });
    }
  }
  return installed;
}

/**
 * The `skills` commands (without the npx prefix) that bring `installed`
 * current, for the given scopes: first a re-add from squirrelscan/skills for
 * each scope holding legacy installs, then one update for the rest. Only names
 * already installed appear, so no command installs a skill that wasn't there,
 * and every command carries -y, so none prompts. A re-add reaches the agents
 * the skills CLI detects, exactly as its own update does (it re-runs
 * `add <source> --skill <name> -g -y` per skill): the lock records no agents.
 */
export function planSkillsRefresh(
  installed: InstalledSkill[],
  scopes: readonly SkillScope[]
): string[][] {
  const inScope = installed.filter((s) => scopes.includes(s.scope));
  const commands: string[][] = [];
  for (const scope of scopes) {
    const legacy = unique(
      inScope.filter((s) => s.scope === scope && s.legacy).map((s) => s.name)
    );
    if (legacy.length) {
      commands.push([
        "add",
        SKILL_REPO,
        "--skill",
        ...legacy,
        ...(scope === "global" ? ["-g"] : []),
        "-y",
      ]);
    }
  }
  const current = unique(inScope.filter((s) => !s.legacy).map((s) => s.name));
  if (current.length) {
    // Names with no scope flag update both scopes; one scope needs its flag.
    const flag =
      scopes.length === 1 ? [scopes[0] === "global" ? "-g" : "-p"] : [];
    commands.push(["update", ...current, ...flag, "-y"]);
  }
  return commands;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// ── The refresh that follows a CLI auto-update ─────────────────────────────

/** Budget for the whole unattended refresh, every command included. */
export const SKILLS_REFRESH_BUDGET_MS = 60_000;

/**
 * Where each version records that its refresh started: one file per CLI
 * version, created exclusively, so parallel first runs (agents start several
 * at once) and a run that could not clear the update marker never refresh
 * twice. A failed refresh is not retried until the next CLI version.
 */
export function skillsRefreshMarkerDir(): string {
  return join(getSquirrelPaths().data, "skills-refresh");
}

export type SkillsRefreshOutcome =
  | "already_ran"
  | "suppressed"
  | "none_installed"
  | "no_npx"
  | "done"
  | "failed"
  | "timed_out";

export interface SkillsRefreshDeps {
  paths?: Record<SkillScope, string>;
  markerDir?: string;
  suppressed?: () => string | null;
  which?: (command: string) => string | null;
  spawn?: typeof spawn;
  budgetMs?: number;
}

/**
 * Bring globally installed squirrelscan skills current, silently. The body of
 * the detached `squirrel skills update --auto` child that a run landing on a
 * freshly auto-updated binary starts (maybeSpawnSkillsRefresh).
 *
 * Global installs only: a project install belongs to whichever repo the
 * command happened to start in, so it stays with `squirrel skills update`.
 * Nothing prompts (every command carries -y, stdin is closed), nothing is
 * installed that the lock does not already record, no npx means no-op, and the
 * whole run is cut off at the budget. It never throws: a failed refresh is
 * logged and retried by the next auto-update.
 */
export async function runSkillsAutoRefresh(
  deps: SkillsRefreshDeps = {}
): Promise<SkillsRefreshOutcome> {
  try {
    const suppressed = (deps.suppressed ?? updateSuppressedReason)();
    if (suppressed) return done("suppressed", { reason: suppressed });
    if (!claimRefresh(deps.markerDir ?? skillsRefreshMarkerDir())) {
      return done("already_ran");
    }

    const installed = (await readInstalledSkills(deps.paths)).filter(
      (s) => s.scope === "global"
    );
    const commands = planSkillsRefresh(installed, ["global"]);
    if (!commands.length) return done("none_installed");

    const npx = (deps.which ?? ((command: string) => Bun.which(command)))(
      "npx"
    );
    if (!npx) return done("no_npx");
    // Windows runs npx.cmd through the shell, which splits an unquoted path
    // like C:\Program Files\nodejs\npx.cmd at the space: let it resolve npx.
    const command = process.platform === "win32" ? "npx" : npx;

    const deadline = Date.now() + (deps.budgetMs ?? SKILLS_REFRESH_BUDGET_MS);
    for (const args of commands) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return done("timed_out", { args });
      // --yes: npx's own "install skills@1?" prompt, when it isn't cached.
      const status = await runBounded(
        deps.spawn ?? spawn,
        command,
        ["--yes", SKILLS_CLI, ...args],
        remaining
      );
      if (status === "timed_out") return done("timed_out", { args });
      if (status !== 0) return done("failed", { args, status });
    }
    return done("done", { commands: commands.length });
  } catch (error) {
    return done("failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Claim this version's refresh; false when another run already has. */
function claimRefresh(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    closeSync(openSync(join(dir, version), "wx"));
  } catch {
    return false;
  }
  // Older versions' markers are dead weight once a newer one has claimed.
  for (const name of readdirSync(dir)) {
    if (name !== version) rmSync(join(dir, name), { force: true });
  }
  return true;
}

function done(
  outcome: SkillsRefreshOutcome,
  detail: Record<string, unknown> = {}
): SkillsRefreshOutcome {
  logger.debug("skills-refresh: finished", { outcome, ...detail });
  return outcome;
}

/** Exit code, or "timed_out" after killing the command (its whole group on POSIX). */
function runBounded(
  spawnImpl: typeof spawn,
  command: string,
  args: string[],
  timeoutMs: number
): Promise<number | "timed_out"> {
  const windows = process.platform === "win32";
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, {
        stdio: "ignore",
        // Own process group, so a timeout takes npx's children down with it.
        detached: !windows,
        // npx is npx.cmd on Windows. The arguments are fixed, never user input.
        shell: windows,
        windowsHide: true,
      });
    } catch {
      resolve(-1);
      return;
    }
    let settled = false;
    const finish = (value: number | "timed_out") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        if (!windows && child.pid) process.kill(-child.pid, "SIGKILL");
        // Killing the shell alone would orphan npx and node behind it.
        else if (child.pid) {
          spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish("timed_out");
    }, timeoutMs);
    child.once("error", () => finish(-1));
    child.once("exit", (code) => finish(code ?? -1));
  });
}

/**
 * Start the silent skills refresh once a CLI auto-update has landed: on the
 * first run of the new binary, the one that also prints "✓ squirrel
 * auto-updated" and clears the marker. Detached, so the command the user typed
 * never waits on npx, and a refresh that fails or hangs never touches the CLI
 * update that already happened. Same opt-outs as auto-update itself.
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
  if (!settings.auto_update) return false;
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
