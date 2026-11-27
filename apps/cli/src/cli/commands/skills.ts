import { defineCommand } from "citty";
import { dirname } from "node:path";

import {
  AGENT_NAMES,
  type AgentName,
  SKILLS_REPOSITORY,
  SKILL_NAMES,
  type SkillsEnv,
  type SkillsScope,
  type SyncResult,
  type TargetResult,
  SkillsBusyError,
  SkillsUsageError,
  backupRoot,
  defaultSkillsEnv,
  installedSkillNames,
  readState,
  runSkillsAutoRefresh,
  skillsAutoUpdateEnabled,
  skillsNotices,
  skillsStatus,
  syncSkills,
  tildify,
  uninstallSkills,
} from "@/self/agent-skills";
import { loadSettings } from "@/self/settings";
import { SkillsFetchError, fetchSkillsIndex } from "@/self/skills-manifest";
import { safeExit } from "@/self/updater";

import { type Theme, createTheme, padVisible, visibleLength } from "../theme";

const SOURCE = `github.com/${SKILLS_REPOSITORY}`;
const CHANGED: TargetResult["outcome"][] = ["installed", "updated", "adopted"];

/** Test seams: a scratch home, a stubbed network, fixed settings and theme. */
export interface SkillsCommandDeps {
  e?: SkillsEnv;
  fetch?: typeof fetch;
  autoUpdateOn?: boolean;
  /** Theme for stdout and stderr; detected per stream by default. */
  theme?: Theme;
}

/** The painters one command's output uses. */
function paint(deps: SkillsCommandDeps) {
  const t = deps.theme ?? createTheme(process.stdout);
  return {
    t,
    // A command to run: coloured in a terminal, `quoted` in plain output.
    cmd: (s: string) => (t.level ? t.command(s) : `\`${s}\``),
    ok: t.ok(t.sym.ok),
    warn: t.warn(t.sym.warn),
    bad: t.error(t.sym.error),
    aside: t.dim("-"),
    up: t.accent(t.unicode ? "↑" : "^"),
  };
}
type Paint = ReturnType<typeof paint>;

// ── Arguments ───────────────────────────────────────────────────────────────

interface ParsedArgs {
  skills: string[];
  agents?: AgentName[];
  flags: Set<string>;
}

/**
 * Parse argv strictly. citty ignores flags it doesn't know, and a mistyped
 * `--dry-run` on a command that writes must stop it, not be dropped.
 */
export function parseSkillsArgs(raw: string[], allowed: string[]): ParsedArgs {
  const out: ParsedArgs = { skills: [], flags: new Set() };
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!;
    if (!arg.startsWith("-")) {
      out.skills.push(arg);
      continue;
    }
    const [flag, inline] = arg.split("=", 2) as [string, string | undefined];
    if (!allowed.includes(flag)) {
      throw new SkillsUsageError(
        `unknown option ${flag} (options: ${allowed.join(", ") || "none"})`
      );
    }
    if (flag !== "--agent") {
      // `--force=false` must not force.
      if (inline !== undefined) {
        throw new SkillsUsageError(`${flag} takes no value`);
      }
      out.flags.add(flag);
      continue;
    }
    const value = inline ?? raw[++i];
    if (!value || value.startsWith("-")) {
      throw new SkillsUsageError("--agent needs a name");
    }
    const names = value === "all" ? [...AGENT_NAMES] : [value];
    for (const name of names) {
      if (!(AGENT_NAMES as readonly string[]).includes(name)) {
        throw new SkillsUsageError(
          `unknown agent ${name} (agents: ${AGENT_NAMES.join(", ")}, all)`
        );
      }
      out.agents = [...new Set([...(out.agents ?? []), name as AgentName])];
    }
  }
  return out;
}

/** stderr through process.stderr: Bun tints console.error red when colour is forced. */
async function fail(
  deps: SkillsCommandDeps,
  message: string,
  code = 1
): Promise<never> {
  const t = deps.theme ?? createTheme(process.stderr);
  process.stderr.write(`${t.error(t.sym.error)} ${message}\n`);
  return safeExit(code);
}

function whyFailed(error: unknown, verb: string): string {
  const why = error instanceof Error ? error.message : String(error);
  if (error instanceof SkillsBusyError) return `${why}. Try again in a moment.`;
  if (error instanceof SkillsUsageError)
    return `squirrel skills ${verb}: ${why}`;
  if (
    error instanceof SkillsFetchError ||
    error instanceof TypeError ||
    error instanceof DOMException
  ) {
    return `Could not get the skills from ${SOURCE}: ${why}\n  Nothing was changed.`;
  }
  return `squirrel skills ${verb} failed: ${why}`;
}

// ── install / update ────────────────────────────────────────────────────────

const roots = (targets: TargetResult[], e: SkillsEnv) =>
  [...new Set(targets.map((t) => tildify(dirname(t.dir), e)))].join(", ");

function printSync(
  p: Paint,
  result: SyncResult,
  e: SkillsEnv,
  mode: "install" | "update"
): void {
  const { t } = p;
  const dry = result.dryRun;
  if (dry) console.log(t.dim("Dry run: nothing was written."));
  const bySkill = new Map<string, TargetResult[]>();
  for (const r of result.targets) {
    bySkill.set(r.skill, [...(bySkill.get(r.skill) ?? []), r]);
  }

  for (const [skill, targets] of bySkill) {
    const changed = targets.filter((r) => CHANGED.includes(r.outcome));
    const current = targets.filter((r) => r.outcome === "current");
    if (changed.length) {
      const to = changed[0]!.version;
      const froms = [
        ...new Set(changed.map((r) => r.from).filter((v) => v && v !== to)),
      ];
      const mark = dry ? t.dim(`~ would ${mode}`) : p.ok;
      const adopted = changed.some((r) => r.outcome === "adopted")
        ? t.dim("  (took over the copy already there)")
        : "";
      const name = t.bold(skill);
      console.log(
        froms.length || mode === "update"
          ? `${mark} ${name} ${froms.join("/") || "?"} ${t.sym.arrow} ${to}  ${t.dim(`(${roots(changed, e)})`)}${adopted}`
          : `${mark} ${name} ${to}   ${t.sym.arrow} ${roots(changed, e)}${adopted}`
      );
    } else if (current.length) {
      console.log(`${p.ok} ${t.bold(skill)} ${current[0]!.version} is current`);
    }
    for (const r of targets) {
      const where = tildify(dirname(r.dir), e);
      if (r.outcome === "failed")
        console.log(`${p.bad} ${skill} in ${where}: ${r.detail}`);
      if (r.outcome === "left-alone") {
        console.log(`${p.aside} ${skill} in ${where} left alone: ${r.detail}`);
      }
      for (const path of r.stale) {
        console.log(
          `${p.warn} ${skill}/${path} in ${where} was edited locally, kept it.`
        );
      }
    }
  }
  if (result.targets.some((r) => r.stale.length)) {
    console.log(
      t.dim(
        mode === "update"
          ? "  Use --force to replace it (your copy is backed up first)."
          : `  Run ${p.cmd("squirrel skills update --force")} to replace it (your copy is backed up first).`
      )
    );
  }
  const backups = result.targets.flatMap((r) => r.backups);
  if (backups.length) {
    console.log(
      `${dry ? "Would back up" : "Backed up"} ${backups.length} file(s) that differed from the published version to ${tildify(backupRoot(e), e)}.`
    );
  }
  for (const cleaned of result.lockCleaned) {
    const n = cleaned.names.length;
    console.log(
      `Adopted ${n} skill${n === 1 ? "" : "s"} installed by ${p.cmd("npx skills")} (removed ${n === 1 ? "it" : "them"} from its lock file, backup at ${tildify(cleaned.backup, e)}).`
    );
  }
  for (const warning of result.warnings) console.log(`${p.warn} ${warning}`);
}

export async function runSkillsSync(
  mode: "install" | "update",
  raw: string[],
  deps: SkillsCommandDeps = {}
): Promise<void> {
  const allowed =
    mode === "install"
      ? ["--agent", "--project", "--dry-run", "--all"]
      : ["--check", "--force", "--dry-run", "--json", "--all"];
  // `--check` exits 1 for "update available", so anything that stops the
  // check itself exits 2: a script must never read an error as an update.
  const errorCode =
    mode === "update" &&
    raw.some((a) => a === "--check" || a.startsWith("--check="))
      ? 2
      : 1;
  let args: ParsedArgs;
  try {
    args = parseSkillsArgs(raw, allowed);
  } catch (error) {
    return fail(deps, whyFailed(error, mode), errorCode);
  }
  const p = paint(deps);
  const e = deps.e ?? defaultSkillsEnv();
  const json = args.flags.has("--json");
  const check = args.flags.has("--check");
  const all = args.flags.has("--all");
  if (mode === "update" && !all && !installedSkillNames(e).length) {
    if (json)
      console.log(
        JSON.stringify({ targets: [], updateAvailable: false }, null, 2)
      );
    else {
      const elsewhere = Object.values(readState(e).skills).some((records) =>
        Object.values(records).some((r) => r.scope === "project")
      );
      console.log(
        elsewhere
          ? `No squirrelscan skills are installed here. Project installs update from inside their repo: run ${p.cmd("squirrel skills update")} there.`
          : `No squirrelscan skills are installed. Install them with ${p.cmd("squirrel skills install")}.`
      );
    }
    return;
  }

  let result: SyncResult;
  try {
    result = await syncSkills({
      mode,
      e,
      fetch: deps.fetch,
      skills: args.skills,
      all,
      agents: args.agents,
      scope: args.flags.has("--project") ? "project" : "global",
      force: args.flags.has("--force"),
      dryRun: check || args.flags.has("--dry-run"),
    });
  } catch (error) {
    return fail(deps, whyFailed(error, mode), errorCode);
  }

  const available = result.targets.some((r) => CHANGED.includes(r.outcome));
  const failed = result.targets.some((r) => r.outcome === "failed");
  if (json) {
    console.log(
      JSON.stringify(
        { ...result, ...(check ? { updateAvailable: available } : {}) },
        null,
        2
      )
    );
  } else if (check) {
    const { t } = p;
    for (const r of result.targets) {
      const where = tildify(dirname(r.dir), e);
      if (CHANGED.includes(r.outcome)) {
        console.log(
          `${p.up} ${t.bold(r.skill)} ${r.from ?? "?"} ${t.sym.arrow} ${r.version}  ${t.dim(`(${where})`)}`
        );
      } else if (r.outcome === "failed") {
        console.log(`${p.bad} ${r.skill} in ${where}: ${r.detail}`);
      } else if (r.outcome === "left-alone") {
        console.log(
          `${p.aside} ${r.skill} in ${where} left alone: ${r.detail}`
        );
      }
    }
    console.log(
      failed
        ? "Some skills can't be updated: see above."
        : available
          ? `Updates available: run ${p.cmd("squirrel skills update")}.`
          : "Skills are current."
    );
  } else {
    printSync(p, result, e, mode);
    if (mode === "install" && available && !result.dryRun) {
      console.log("Restart your agent to load them.");
    }
  }
  if (failed) return safeExit(errorCode);
  if (check && available) return safeExit(1);
}

// ── status ──────────────────────────────────────────────────────────────────

export async function printSkillsStatus(
  raw: string[],
  deps: SkillsCommandDeps = {}
): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseSkillsArgs(raw, ["--json"]);
  } catch (error) {
    return fail(deps, whyFailed(error, "status"));
  }
  const e = deps.e ?? defaultSkillsEnv();
  let manifest;
  try {
    manifest = await fetchSkillsIndex({ fetch: deps.fetch });
  } catch {
    manifest = undefined; // offline: still show what is installed
  }
  const status = skillsStatus(manifest, e);
  const autoOn =
    deps.autoUpdateOn ??
    (() => {
      const settings = loadSettings();
      return settings.ok && skillsAutoUpdateEnabled(settings.data);
    })();
  if (args.flags.has("--json")) {
    console.log(
      JSON.stringify(
        {
          source: SOURCE,
          ref: manifest?.ref,
          autoUpdate: autoOn,
          skills: status,
          notices: skillsNotices(e),
        },
        null,
        2
      )
    );
    return;
  }

  const p = paint(deps);
  const { t } = p;
  console.log(
    `${t.heading("squirrelscan skills")}  ${t.dim(`(${SOURCE} @ ${manifest ? manifest.ref.slice(0, 7) : "offline"})`)}\n`
  );
  const shown = status.filter(
    (s) =>
      s.targets.length > 0 ||
      (SKILL_NAMES as readonly string[]).includes(s.name)
  );
  const rows = shown.map((s) => {
    const ours = s.targets.filter(
      (x) => x.managedBy !== "other" && !x.released
    );
    // #1730: a link into a checkout of our own skill shows its version too, marked as linked.
    const linked = s.targets.filter((x) => x.managedBy === "other" && x.linked);
    const versions = [
      ...new Set([
        ...ours.map((x) => x.version ?? "?"),
        ...linked.map((x) => `${x.version ?? "?"} (linked)`),
      ]),
    ];
    const outdated = ours.some((x) => x.outdated);
    const linkedBehind = linked.some((x) => x.outdated);
    return {
      skill: s.name,
      installed: versions.join("/") || "-",
      latest: s.latest
        ? `${s.latest}${outdated || linkedBehind ? ` ${p.up}` : ""}`
        : manifest
          ? "-"
          : "?",
      where:
        [...new Set([...ours, ...linked].map((x) => tildify(x.root, e)))].join(
          ", "
        ) || "-",
      outdated,
      linkedBehind,
    };
  });
  const width = (key: "skill" | "installed" | "latest", min: number) =>
    Math.max(min, ...rows.map((r) => visibleLength(r[key]))) + 3;
  const w = {
    skill: width("skill", 5),
    installed: width("installed", 9),
    latest: width("latest", 6),
  };
  const line = (a: string, b: string, c: string, d: string) =>
    `  ${padVisible(a, w.skill)}${padVisible(b, w.installed)}${padVisible(c, w.latest)}${d}`;
  console.log(t.dim(line("skill", "installed", "latest", "where").trimEnd()));
  for (const r of rows)
    console.log(line(t.bold(r.skill), r.installed, r.latest, r.where));

  const notes: string[] = [];
  for (const s of status) {
    for (const x of s.targets) {
      const where = tildify(x.dir, e);
      if (x.blocked) {
        notes.push(`${p.bad} ${where} can't be updated: ${x.blocked}`);
      }
      if (x.editedFiles.length) {
        notes.push(
          `${p.warn} ${where}: edited locally (${x.editedFiles.join(", ")}); updates keep your edits`
        );
      }
      if (x.released) {
        notes.push(
          `${p.aside} ${where} was uninstalled but holds your edits; updates leave it alone, ${p.cmd("squirrel skills install")} takes it back`
        );
      } else if (x.managedBy === "npx skills") {
        notes.push(
          `${p.warn} ${where} is managed by npx skills: ${p.cmd("squirrel skills update")} takes it over`
        );
      } else if (x.managedBy === "unmanaged" && x.outdated) {
        notes.push(
          `${p.warn} ${where} was not installed by squirrel: ${p.cmd("squirrel skills update")} takes it over`
        );
      }
      if (x.managedBy === "other" && x.linked && x.outdated) {
        notes.push(
          `${p.warn} ${where} links to ${tildify(x.linkTo!, e)} (${x.version}), behind the latest ${s.latest}: squirrel leaves the checkout alone, update it yourself`
        );
      } else if (x.managedBy === "other") {
        notes.push(
          `${p.aside} ${where} ${x.linkTo ? `links to ${tildify(x.linkTo, e)}` : "holds another author's skill"}; squirrel leaves it alone`
        );
      }
    }
  }
  for (const notice of skillsNotices(e)) notes.push(`${p.warn} ${notice}`);
  if (notes.length) console.log(`\n${notes.join("\n")}`);

  const updates = rows.filter((r) => r.outdated).length;
  const blocked = status.some((s) => s.targets.some((x) => x.blocked));
  const installed = rows.filter((r) => r.installed !== "-").length;
  console.log("");
  if (!installed)
    console.log(
      `No skills installed: run ${p.cmd("squirrel skills install")}.`
    );
  else if (!manifest)
    console.log(`Could not reach ${SOURCE} to check for updates.`);
  else if (!updates && rows.some((r) => r.linkedBehind)) {
    console.log(
      "A linked skill is behind the latest: update the checkout it links to (see above)."
    );
  } else if (updates) {
    console.log(
      `${updates} update${updates === 1 ? "" : "s"} available: run ${p.cmd("squirrel skills update")}.`
    );
  } else if (blocked) console.log("Some skills can't be updated: see above.");
  else console.log(`${p.ok} Skills are current.`);
  console.log(
    t.dim(
      autoOn
        ? "Auto-update is on: skills update with the CLI."
        : `Auto-update is off: run ${p.cmd("squirrel skills update")} to update.`
    )
  );
}

// ── list ────────────────────────────────────────────────────────────────────

export async function printSkillsList(
  raw: string[],
  deps: SkillsCommandDeps = {}
): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseSkillsArgs(raw, ["--json"]);
  } catch (error) {
    return fail(deps, whyFailed(error, "list"));
  }
  if (args.skills.length) {
    return fail(deps, "squirrel skills list takes no skill names");
  }
  const e = deps.e ?? defaultSkillsEnv();
  let catalog;
  try {
    catalog = await fetchSkillsIndex({ fetch: deps.fetch });
  } catch {
    catalog = undefined; // offline: list what is installed
  }
  // Only a real catalog describes every skill; manifest.json holds the core two.
  const known = catalog?.catalog ? catalog : undefined;
  const defaults = new Set<string>(SKILL_NAMES);
  const status = skillsStatus(catalog, e).filter(
    (s) => known?.skills.some((k) => k.name === s.name) || s.targets.length > 0
  );
  const entries = status.map((s) => {
    const meta = known?.skills.find((k) => k.name === s.name);
    return {
      name: s.name,
      version: s.latest ?? null,
      description: meta?.description ?? null,
      default: defaults.has(s.name),
      installed: s.targets
        .filter((x) => x.managedBy !== "other" || x.linked)
        .map((x) => ({
          dir: x.dir,
          agent: x.agent ?? null,
          scope: x.scope ?? null,
          version: x.version ?? null,
        })),
    };
  });
  if (args.flags.has("--json")) {
    console.log(
      JSON.stringify(
        {
          source: SOURCE,
          ref: catalog?.ref ?? null,
          catalog: Boolean(known),
          skills: entries,
        },
        null,
        2
      )
    );
    return;
  }

  const p = paint(deps);
  const { t } = p;
  console.log(
    `${t.heading("squirrelscan skills")}  ${t.dim(`(${SOURCE} @ ${known ? known.ref.slice(0, 7) : "catalog unavailable"})`)}\n`
  );
  if (!entries.length) {
    console.log(
      `No skills installed, and the catalog is unavailable. Try again when ${SOURCE} is reachable.`
    );
    return;
  }
  const where = (x: (typeof entries)[number]["installed"][number]) => {
    const place = [x.scope, x.agent].filter(Boolean).join(" ");
    return place || tildify(dirname(x.dir), e);
  };
  const width = Math.max(5, ...entries.map((x) => visibleLength(x.name))) + 3;
  for (const x of entries) {
    const flags = [
      x.default ? "default" : "",
      x.installed.length
        ? `installed ${[...new Set(x.installed.map((i) => `${i.version ?? "?"} (${where(i)})`))].join(", ")}`
        : "not installed",
    ].filter(Boolean);
    console.log(
      `${padVisible(t.bold(x.name), width)}${x.version ?? "-"}  ${t.dim(flags.join("; "))}`
    );
    if (x.description) console.log(`  ${x.description}`);
  }
  console.log("");
  if (!known) {
    console.log(
      `The catalog is unavailable, so only installed skills are listed.`
    );
  } else {
    console.log(
      `Install one with ${p.cmd("squirrel skills install <name>")}, or all with ${p.cmd("squirrel skills install --all")}.`
    );
  }
}

// ── uninstall ───────────────────────────────────────────────────────────────

export async function runSkillsUninstall(
  raw: string[],
  deps: SkillsCommandDeps = {}
): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseSkillsArgs(raw, ["--agent", "--project"]);
  } catch (error) {
    return fail(deps, whyFailed(error, "uninstall"));
  }
  const p = paint(deps);
  const e = deps.e ?? defaultSkillsEnv();
  const scope: SkillsScope = args.flags.has("--project") ? "project" : "global";
  let result;
  try {
    result = await uninstallSkills({
      e,
      skills: args.skills,
      agents: args.agents,
      scope,
    });
  } catch (error) {
    return fail(deps, whyFailed(error, "uninstall"));
  }
  if (!result.removed.length && !result.emptied.length && !result.kept.length) {
    console.log("No skills installed by squirrelscan to remove.");
    return;
  }
  for (const dir of result.removed)
    console.log(`${p.ok} removed ${tildify(dir, e)}`);
  for (const dir of result.emptied) {
    console.log(
      `${p.ok} removed squirrelscan's files from ${tildify(dir, e)}; other files there stay`
    );
  }
  if (result.kept.length) {
    console.log(
      `${p.warn} Kept ${result.kept.length} file(s) edited since squirrelscan installed them:`
    );
    for (const f of result.kept) console.log(`  ${tildify(f, e)}`);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * `squirrel skills` alone is `squirrel skills status`. citty also runs the
 * parent after a subcommand, so only act when none was given.
 */
export async function runSkillsRoot(
  raw: string[],
  deps: SkillsCommandDeps = {}
): Promise<void> {
  if (raw.some((a) => !a.startsWith("-"))) return;
  await printSkillsStatus(raw, deps);
}

export const skillsInstall = defineCommand({
  meta: {
    name: "install",
    description: "Install squirrelscan skills for coding agents",
  },
  args: {
    skill: {
      type: "positional",
      required: false,
      description:
        "Skills to install, by name (default: squirrelscan and audit-website)",
    },
    all: {
      type: "boolean",
      description: "Install every skill in the catalog",
    },
    agent: {
      type: "string",
      description: "Agent to install for: claude, agents or all (repeatable)",
    },
    project: {
      type: "boolean",
      description: "Install into this repo's .claude/skills and .agents/skills",
    },
    "dry-run": {
      type: "boolean",
      description: "Show what would change, write nothing",
    },
  },
  async run({ rawArgs }) {
    await runSkillsSync("install", rawArgs);
  },
});

export const skillsUpdate = defineCommand({
  meta: {
    name: "update",
    description: "Update the installed squirrelscan skills",
  },
  args: {
    skill: {
      type: "positional",
      required: false,
      description: "Skills to update, by name (default: every installed one)",
    },
    all: {
      type: "boolean",
      description: "Also install catalog skills that are not installed yet",
    },
    check: {
      type: "boolean",
      description:
        "Only report: exit 1 when an update is available, 2 if the check fails",
    },
    force: {
      type: "boolean",
      description: "Also replace locally edited files (backed up first)",
    },
    "dry-run": {
      type: "boolean",
      description: "Show what would change, write nothing",
    },
    json: { type: "boolean", description: "Output JSON" },
  },
  async run({ rawArgs }) {
    // `--auto` is internal and undocumented: the detached refresh a CLI
    // auto-update starts (see maybeSpawnSkillsRefresh).
    if (rawArgs.includes("--auto")) {
      // Detached child started after a CLI auto-update landed: never prints,
      // never prompts, never fails the run that started it.
      await runSkillsAutoRefresh();
      return;
    }
    await runSkillsSync("update", rawArgs);
  },
});

export const skillsStatusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show installed skill versions and locations",
  },
  args: {
    json: { type: "boolean", description: "Output JSON" },
  },
  async run({ rawArgs }) {
    await printSkillsStatus(rawArgs);
  },
});

export const skillsList = defineCommand({
  meta: {
    name: "list",
    description: "List every skill in the catalog and where it is installed",
  },
  args: {
    json: { type: "boolean", description: "Output JSON" },
  },
  async run({ rawArgs }) {
    await printSkillsList(rawArgs);
  },
});

export const skillsUninstall = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove the skills squirrelscan installed",
  },
  args: {
    skill: {
      type: "positional",
      required: false,
      description: "Skills to remove, by name (default: all of them)",
    },
    agent: {
      type: "string",
      description: "Agent to remove from: claude, agents or all (repeatable)",
    },
    project: {
      type: "boolean",
      description: "Remove from this repo's .claude/skills and .agents/skills",
    },
  },
  async run({ rawArgs }) {
    await runSkillsUninstall(rawArgs);
  },
});

export const skills = defineCommand({
  meta: {
    name: "skills",
    description: "Manage agent skills (Claude Code, Cursor, Codex, and more)",
  },
  subCommands: {
    list: skillsList,
    install: skillsInstall,
    update: skillsUpdate,
    status: skillsStatusCommand,
    uninstall: skillsUninstall,
  },
  async run({ rawArgs }) {
    await runSkillsRoot(rawArgs);
  },
});
