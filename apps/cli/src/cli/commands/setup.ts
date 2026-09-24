// `squirrel setup`: the guided first run. Sign in (optional), install the
// agent skills (default yes), keep things updated, then point at the first
// audit. Safe to re-run: every step says when it is already done.

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { resolveCredential } from "@/self/credentials";
import { loadUserSettings, updateSettings } from "@/self/settings";

import { version } from "../../../package.json";
import { type Theme, createTheme } from "../theme";

const SKILL_NAMES = ["squirrelscan", "audit-website"] as const;

/** Where the skills live by default: Claude Code's own directory and the shared ~/.agents one. */
export function skillTargets(env = process.env, home = homedir()): string[] {
  const claudeHome = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return [join(claudeHome, "skills"), join(home, ".agents", "skills")];
}

function tildify(path: string, home = homedir()): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Targets that already hold both skills. */
function installedTargets(): string[] {
  return skillTargets().filter((dir) => SKILL_NAMES.every((name) => existsSync(join(dir, name, "SKILL.md"))));
}

export interface SkillsInstallResult {
  ok: boolean;
  targets: string[];
  error?: string;
}

/**
 * The one place setup installs skills. For now it runs the same install as
 * `squirrel skills install`; #2357 replaces the body with the native manager.
 */
export async function installAgentSkills(): Promise<SkillsInstallResult> {
  const result = spawnSync("npx", ["--yes", "skills@1", "add", "squirrelscan/skills", "-g", "-y"], {
    stdio: "ignore",
    shell: process.platform === "win32",
    timeout: 180_000,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, targets: [], error: result.error?.message ?? `exit ${result.status}` };
  }
  return { ok: true, targets: installedTargets() };
}

interface Asker {
  interactive: boolean;
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
}

function createAsker(t: Theme, assumeYes: boolean): Asker {
  const interactive = !assumeYes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    interactive,
    async confirm(question, defaultYes = true) {
      if (!interactive) return defaultYes;
      const hint = t.dim(defaultYes ? "[Y/n]" : "[y/N]");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => rl.question(`     ${t.accent("?")} ${question} ${hint} `, resolve));
      rl.close();
      const a = answer.trim().toLowerCase();
      return a === "" ? defaultYes : a === "y" || a === "yes";
    },
  };
}

function step(t: Theme, n: number, title: string, note?: string): void {
  console.log(`\n  ${t.heading(String(n))}  ${t.bold(title)}${note ? `  ${t.dim(note)}` : ""}`);
}

const say = (line: string) => console.log(`     ${line}`);

export async function runSetup(opts: { yes: boolean; dryRun: boolean }): Promise<void> {
  const t = createTheme(process.stdout);
  const ask = createAsker(t, opts.yes);
  const done = (msg: string) => say(`${t.ok(t.sym.ok)} ${msg}`);
  const skip = (msg: string) => say(`${t.dim(t.sym.bullet)} ${t.dim(msg)}`);
  const would = (msg: string) => say(`${t.dim(t.sym.arrow)} ${t.dim(`Would ${msg} (dry run)`)}`);

  console.log(`\n${t.header({ version: `v${version}`, subtitle: "Let's get you set up. It takes about a minute." })}`);

  // 1. Sign in. Optional: local audits never need an account.
  step(t, 1, "Sign in", "optional");
  say(t.dim("Unlocks cloud audits, publishing and sharing. Local audits are free without it."));
  const settings = loadUserSettings();
  const signedInAs = resolveCredential() ? (settings.ok ? settings.data.auth?.email : undefined) ?? "your API key" : undefined;
  if (signedInAs) {
    done(`Signed in as ${t.bold(signedInAs)}`);
  } else if (!ask.interactive) {
    skip(`Skipped. Sign in any time with ${t.command("squirrel auth login")}.`);
  } else if (await ask.confirm("Sign in now?")) {
    if (opts.dryRun) {
      would("open your browser to sign in");
    } else {
      const { runAuthLogin } = await import("@/controllers/auth/login");
      const result = await runAuthLogin({ version });
      if (result.ok) done(`Signed in as ${t.bold(result.data.email)}`);
      else say(`${t.warn(t.sym.warn)} Sign-in didn't finish: ${result.error.message}. Try again with ${t.command("squirrel auth login")}.`);
    }
  } else {
    skip(`Skipped. Sign in any time with ${t.command("squirrel auth login")}.`);
  }

  // 2. Agent skills. Default yes: this is what makes squirrel useful to an agent.
  step(t, 2, "Agent skills");
  say(t.dim("Teaches Claude Code, Codex, Cursor and other agents to run audits and fix what they find."));
  const already = installedTargets();
  if (already.length > 0) {
    done(`Installed in ${already.map((d) => tildify(d)).join(" and ")}`);
  } else if (await ask.confirm("Install the squirrelscan skills?")) {
    if (opts.dryRun) {
      would(`install ${SKILL_NAMES.join(" and ")} to ${skillTargets().map((d) => tildify(d)).join(" and ")}`);
    } else {
      say(t.dim("Installing..."));
      const result = await installAgentSkills();
      if (result.ok) {
        const where = result.targets.length > 0 ? result.targets : skillTargets();
        done(`Installed ${SKILL_NAMES.join(" and ")} in ${where.map((d) => tildify(d)).join(" and ")}`);
      } else {
        say(`${t.warn(t.sym.warn)} Couldn't install the skills (${result.error}). Try ${t.command("squirrel skills install")}.`);
      }
    }
  } else {
    skip(`Skipped. Add them later with ${t.command("squirrel skills install")}.`);
  }

  // 3. Updates.
  step(t, 3, "Updates");
  const autoUpdate = settings.ok ? settings.data.auto_update : true;
  if (autoUpdate) {
    done("squirrel and its skills update themselves automatically");
  } else if (await ask.confirm("Keep squirrel and its skills up to date automatically?")) {
    if (opts.dryRun) would("turn on auto-update");
    else if (updateSettings({ auto_update: true }).ok) done("Auto-update is on");
  } else {
    skip(`Auto-update stays off. Update with ${t.command("squirrel self update")}.`);
  }

  if (!opts.dryRun) updateSettings({ setup_completed_at: new Date().toISOString() });

  console.log(`\n  ${t.ok(t.sym.ok)} ${t.bold("You're ready.")} Run your first audit:\n`);
  console.log(`     ${t.command("squirrel audit https://your-site.com")}\n`);
  console.log(`  ${t.dim(`Or ask your agent: "audit my site with squirrelscan and fix what you find"`)}\n`);
}

export const setup = defineCommand({
  meta: {
    name: "setup",
    description: "Sign in, install the agent skills and pick your defaults",
  },
  args: {
    yes: {
      type: "boolean",
      alias: "y",
      description: "Accept every default without asking (sign-in is skipped)",
    },
    "dry-run": {
      type: "boolean",
      description: "Show what setup would do without changing anything",
    },
  },
  async run({ args }) {
    await runSetup({ yes: Boolean(args.yes), dryRun: Boolean(args["dry-run"]) });
  },
});
