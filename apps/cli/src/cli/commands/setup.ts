// `squirrel setup`: the guided first run. Sign in (optional), install the
// agent skills (default yes), keep things updated, then point at the first
// audit. Safe to re-run: every step says when it is already done.

import { defineCommand } from "citty";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import {
  type InstallSkillsOptions,
  SKILL_NAMES,
  defaultSkillRoots,
  defaultSkillsEnv,
  installSkills,
  installedSkillRoots,
  tildify as tildifyIn,
} from "@/self/agent-skills";
import { resolveCredential } from "@/self/credentials";
import { getUnmanagedUpdateHint, isManagedInstall } from "@/self/paths";
import { loadUserSettings, updateSettings } from "@/self/settings";
import { type TelemetryEvent, trackFirstRunEvent } from "@/self/telemetry";

import { version } from "../../../package.json";
import { type Theme, createTheme } from "../theme";

const tildify = (path: string) => tildifyIn(path, defaultSkillsEnv());

export interface SkillsInstallResult {
  ok: boolean;
  targets: string[];
  error?: string;
}

/**
 * The one place setup installs skills: the native manager, the same install
 * as `squirrel skills install` (both skills, both default folders).
 */
export async function installAgentSkills(
  options: InstallSkillsOptions = {}
): Promise<SkillsInstallResult> {
  try {
    const result = await installSkills(options);
    const roots = (outcomes: string[]) => [
      ...new Set(
        result.targets
          .filter((t) => outcomes.includes(t.outcome))
          .map((t) => dirname(t.dir))
      ),
    ];
    const failed = result.targets.filter((t) => t.outcome === "failed");
    if (failed.length) {
      return {
        ok: false,
        targets: roots(["installed", "updated", "adopted", "current"]),
        error: failed
          .map((t) => `${t.skill} in ${tildify(dirname(t.dir))}: ${t.detail}`)
          .join("; "),
      };
    }
    return {
      ok: true,
      targets: roots(["installed", "updated", "adopted", "current"]),
    };
  } catch (error) {
    return {
      ok: false,
      targets: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface Asker {
  interactive: boolean;
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  /** One line of free text; "" when the user just presses enter. */
  line: (question: string) => Promise<string>;
}

/**
 * The site the user typed, as an http(s) URL, or null when it isn't one.
 * A bare host ("example.com") is taken as https; a bare localhost or IP is
 * taken as http, since local dev servers rarely speak TLS. Only the audit
 * sees it.
 */
export function parseAuditTarget(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  try {
    const url = new URL(hasScheme ? text : `https://${text}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname;
    const local =
      host === "localhost" || isIP(host.replace(/^\[|\]$/g, "")) !== 0;
    if (!local && !host.includes(".")) return null;
    if (!hasScheme && local) url.protocol = "http:";
    return url.toString();
  } catch {
    return null;
  }
}

function createAsker(t: Theme, assumeYes: boolean): Asker {
  const interactive =
    !assumeYes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  async function ask(prompt: string): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    // Ctrl+C at a prompt stops setup, the way it stops any other command.
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      process.exit(130);
    });
    const answer = await new Promise<string>((resolve) =>
      rl.question(prompt, resolve)
    );
    rl.close();
    return answer;
  }
  return {
    interactive,
    async confirm(question, defaultYes = true) {
      if (!interactive) return defaultYes;
      const hint = t.dim(defaultYes ? "[Y/n]" : "[y/N]");
      const answer = await ask(`     ${t.accent("?")} ${question} ${hint} `);
      const a = answer.trim().toLowerCase();
      return a === "" ? defaultYes : a === "y" || a === "yes";
    },
    async line(question) {
      if (!interactive) return "";
      return ask(`     ${t.accent("?")} ${question} `);
    },
  };
}

function step(t: Theme, n: number, title: string, note?: string): void {
  console.log(
    `\n  ${t.heading(String(n))}  ${t.bold(title)}${note ? `  ${t.dim(note)}` : ""}`
  );
}

const say = (line: string) => console.log(`     ${line}`);

export async function runSetup(opts: {
  yes: boolean;
  dryRun: boolean;
}): Promise<void> {
  const t = createTheme(process.stdout);
  const ask = createAsker(t, opts.yes);
  const done = (msg: string) => say(`${t.ok(t.sym.ok)} ${msg}`);
  const skip = (msg: string) => say(`${t.dim(t.sym.bullet)} ${t.dim(msg)}`);
  const would = (msg: string) =>
    say(`${t.dim(t.sym.arrow)} ${t.dim(`Would ${msg} (dry run)`)}`);

  console.log(
    `\n${t.header({ version: `v${version}`, subtitle: "Let's get you set up. It takes about a minute." })}`
  );

  // First-run telemetry: which steps ran, never what was typed. Skipped on a
  // dry run and when the settings can't be read (they may hold the opt-out);
  // trackFirstRunEvent itself sends nothing when telemetry is off.
  const settings = loadUserSettings();
  const track = (event: TelemetryEvent, detail?: string) => {
    if (!opts.dryRun && settings.ok)
      trackFirstRunEvent(event, settings.data, detail);
  };
  const trackStep = (name: string, outcome: string) =>
    track("setup_step", `${name}:${outcome}`);
  track("setup_started");

  // 1. Sign in. Optional: local audits never need an account.
  step(t, 1, "Sign in", "optional");
  say(
    t.dim(
      "Unlocks cloud audits, publishing and sharing. Signed out, local audits need no account and cost nothing."
    )
  );
  const skipSignIn = () => {
    skip(`Skipped. Sign in any time with ${t.command("squirrel auth login")}.`);
    trackStep("signin", "skipped");
  };
  const signedInAs = resolveCredential()
    ? ((settings.ok ? settings.data.auth?.email : undefined) ?? "your API key")
    : undefined;
  if (signedInAs) {
    done(`Signed in as ${t.bold(signedInAs)}`);
    trackStep("signin", "already");
  } else if (!ask.interactive) {
    skipSignIn();
  } else if (await ask.confirm("Sign in now?")) {
    if (opts.dryRun) {
      would("open your browser to sign in");
    } else {
      const { runAuthLogin } = await import("@/controllers/auth/login");
      const result = await runAuthLogin({ version });
      if (result.ok) done(`Signed in as ${t.bold(result.data.email)}`);
      else
        say(
          `${t.warn(t.sym.warn)} Sign-in didn't finish: ${result.error.message}. Try again with ${t.command("squirrel auth login")}.`
        );
      trackStep("signin", result.ok ? "done" : "failed");
    }
  } else {
    skipSignIn();
  }

  // 2. Agent skills. Default yes: this is what makes squirrel useful to an agent.
  step(t, 2, "Agent skills");
  say(
    t.dim(
      "Teaches Claude Code, Codex, Cursor and other agents to run audits and fix what they find."
    )
  );
  const already = installedSkillRoots();
  if (already.length > 0) {
    done(`Installed in ${already.map((d) => tildify(d)).join(" and ")}`);
    trackStep("skills", "already");
  } else if (await ask.confirm("Install the squirrelscan skills?")) {
    if (opts.dryRun) {
      would(
        `install ${SKILL_NAMES.join(" and ")} to ${defaultSkillRoots()
          .map((d) => tildify(d))
          .join(" and ")}`
      );
    } else {
      say(t.dim("Installing..."));
      const result = await installAgentSkills();
      if (result.ok) {
        const where =
          result.targets.length > 0
            ? ` in ${result.targets.map((d) => tildify(d)).join(" and ")}`
            : "";
        done(`Installed ${SKILL_NAMES.join(" and ")}${where}`);
        trackStep("skills", "done");
      } else {
        trackStep("skills", "failed");
        say(
          `${t.warn(t.sym.warn)} Couldn't install the skills (${result.error}). Try ${t.command("squirrel skills install")}.`
        );
      }
    }
  } else {
    skip(
      `Skipped. Add them later with ${t.command("squirrel skills install")}.`
    );
    trackStep("skills", "skipped");
  }

  // 3. Updates. Only a managed install (the installer's) can update itself.
  step(t, 3, "Updates");
  const autoUpdate = settings.ok ? settings.data.auto_update : undefined;
  if (!isManagedInstall()) {
    trackStep("updates", "unmanaged");
    skip(
      `This copy of squirrel was not installed by the squirrelscan installer, so it can't update itself. To update: ${getUnmanagedUpdateHint()}.`
    );
  } else if (autoUpdate === true) {
    trackStep("updates", "already");
    if (settings.ok && settings.data.skills_auto_update === false) {
      done("squirrel updates itself automatically");
      skip(
        `Skills are excluded (skills_auto_update is off). Update them with ${t.command("squirrel skills update")}.`
      );
    } else done("squirrel and its skills update themselves automatically");
  } else if (autoUpdate === undefined) {
    say(
      `${t.warn(t.sym.warn)} Couldn't read your settings. Check them with ${t.command("squirrel self doctor")}.`
    );
  } else if (!ask.interactive) {
    trackStep("updates", "skipped");
    // auto_update defaults to true, so false is always the user's choice:
    // never flip it back without an explicit yes at a prompt.
    skip(
      `Auto-update is off. Turn it on with ${t.command("squirrel self settings set auto_update true")}.`
    );
  } else if (
    await ask.confirm("Keep squirrel and its skills up to date automatically?")
  ) {
    if (opts.dryRun) would("turn on auto-update");
    else if (updateSettings({ auto_update: true }).ok) {
      done("Auto-update is on");
      trackStep("updates", "enabled");
    }
  } else {
    trackStep("updates", "skipped");
    skip(
      `Auto-update stays off. Update with ${t.command("squirrel self update")}.`
    );
  }

  if (!opts.dryRun) {
    updateSettings({ setup_completed_at: new Date().toISOString() });
    track("setup_completed");
  }

  console.log(`\n  ${t.ok(t.sym.ok)} ${t.bold("You're ready.")}`);

  // Last step: the first audit. Interactive runs are offered it right here;
  // everything else (no TTY, CI, an agent, --yes, --dry-run) never blocks and
  // just gets the command to run.
  const target = await offerFirstAudit(t, ask, opts.dryRun, track);
  if (target) {
    console.log("");
    const { runCommand } = await import("citty");
    const { audit } = await import("./audit");
    await runCommand(audit, { rawArgs: [target] });
    return;
  }

  console.log(`\n  Run your first audit:\n`);
  console.log(`     ${t.command("squirrel audit https://your-site.com")}\n`);
  console.log(
    `  ${t.dim(`Or ask your agent: "audit my site with squirrelscan and fix what you find"`)}\n`
  );
}

/** Ask for a site and return its URL when the user wants the audit now. */
export async function offerFirstAudit(
  t: Theme,
  ask: Asker,
  dryRun: boolean,
  track: (event: TelemetryEvent, detail?: string) => void
): Promise<string | null> {
  if (!ask.interactive || dryRun) return null;
  say(
    t.dim(
      "Last step: audit a site now. Local audits are free and take a minute."
    )
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await ask.line("Site to audit (a URL, or enter to skip):");
    if (!answer.trim()) break;
    const target = parseAuditTarget(answer);
    if (target) {
      track("setup_audit_accepted");
      return target;
    }
    say(
      `${t.warn(t.sym.warn)} That doesn't look like a site URL. Try https://example.com`
    );
  }
  track("setup_audit_declined");
  return null;
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
      description:
        "Accept every default without asking (sign-in is skipped and the audit is not offered)",
    },
    "dry-run": {
      type: "boolean",
      description: "Show what setup would do without changing anything",
    },
  },
  async run({ args }) {
    await runSetup({
      yes: Boolean(args.yes),
      dryRun: Boolean(args["dry-run"]),
    });
  },
});
