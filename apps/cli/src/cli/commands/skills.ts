import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { safeExit } from "@/self/updater";

// squirrelscan/skills is the canonical skills repo. This repo's skills/ is only
// a mirror of it for the plugin manifests, so never install from here.
const SKILL_REPO = "squirrelscan/skills";
const SKILL_NAMES = ["squirrelscan", "audit-website"] as const;
const SKILLS_URL = "https://skills.sh/squirrelscan/skills";

// `skills update` takes skill NAMES, not a source: given a repo it matches no
// installed skill and updates nothing. Each skill updates from the source its
// lock entry recorded at install time. No -g: with names and no scope flag it
// updates global and project installs without prompting, and the docs' plain
// `npx skills add squirrelscan/skills` may have made either.
const ADD_ARGS = ["skills", "add", SKILL_REPO, "-g"];
const UPDATE_ARGS = ["skills", "update", ...SKILL_NAMES];

// Installs made before squirrelscan/skills was canonical record this repo as
// their source, and `skills update` keeps pulling each skill from its recorded
// source: this repo's skills/ mirror.
const LEGACY_SOURCE = "squirrelscan/squirrelscan";

// Where the skills CLI records each skill's source: the global lock
// ($XDG_STATE_HOME/skills/.skill-lock.json, else ~/.agents/.skill-lock.json)
// and the project lock in the working directory.
function skillLockPaths(): string[] {
  const xdg = process.env.XDG_STATE_HOME;
  return [
    xdg
      ? join(xdg, "skills", ".skill-lock.json")
      : join(homedir(), ".agents", ".skill-lock.json"),
    join(process.cwd(), "skills-lock.json"),
  ];
}

const isLegacySource = (value: unknown): boolean =>
  typeof value === "string" &&
  /(^|\/)squirrelscan\/squirrelscan$/.test(
    value.toLowerCase().replace(/\.git$/, "")
  );

/** True when a lock file says one of our skills came from squirrelscan/squirrelscan. */
export async function installedFromLegacyRepo(
  paths = skillLockPaths()
): Promise<boolean> {
  for (const path of paths) {
    let lock: {
      skills?: Record<string, { source?: unknown; sourceUrl?: unknown }>;
    } | null;
    try {
      lock = await Bun.file(path).json();
    } catch {
      continue; // missing or unreadable: nothing to say
    }
    for (const name of SKILL_NAMES) {
      const entry = lock?.skills?.[name];
      if (isLegacySource(entry?.source) || isLegacySource(entry?.sourceUrl)) {
        return true;
      }
    }
  }
  return false;
}

function isNpxAvailable(): boolean {
  const result = spawnSync("npx", ["--version"], {
    shell: true,
    stdio: "pipe",
  });
  return !result.error && result.status === 0;
}

function showManualInstructions(action: "install" | "update"): void {
  const cmd = `npx ${(action === "install" ? ADD_ARGS : UPDATE_ARGS).join(" ")}`;

  console.log("\nTo run manually:");
  console.log(`  ${cmd}`);
  console.log(`\nView skills: ${SKILLS_URL}`);
}

export const skillsInstall = defineCommand({
  meta: {
    name: "install",
    description: "Install squirrelscan skills for coding agents",
  },
  async run() {
    if (!isNpxAvailable()) {
      console.log("npx not found. Install Node.js or run manually:");
      showManualInstructions("install");
      return safeExit(0);
    }

    console.log(
      `Installing squirrelscan skills (${SKILL_NAMES.join(", ")})...`
    );

    const result = spawnSync("npx", ADD_ARGS, {
      stdio: "inherit",
      shell: true,
    });

    if (result.error || result.status !== 0) {
      console.error("\nFailed to install skills.");
      showManualInstructions("install");
      return safeExit(1);
    }

    console.log(
      "\nSkills installed! Use /audit-website or /squirrelscan in your agent."
    );
    console.log(`View skills: ${SKILLS_URL}`);
  },
});

export const skillsUpdate = defineCommand({
  meta: {
    name: "update",
    description: "Update squirrelscan skills for coding agents",
  },
  async run() {
    if (!isNpxAvailable()) {
      console.log("npx not found. Install Node.js or run manually:");
      showManualInstructions("update");
      return safeExit(0);
    }

    console.log(`Updating squirrelscan skills (${SKILL_NAMES.join(", ")})...`);

    const result = spawnSync("npx", UPDATE_ARGS, {
      stdio: "inherit",
      shell: true,
    });

    if (result.error || result.status !== 0) {
      console.error("\nFailed to update skills.");
      showManualInstructions("update");
      return safeExit(1);
    }

    console.log("\nSkills updated!");
    if (await installedFromLegacyRepo()) {
      console.log(
        `Tip: these skills came from ${LEGACY_SOURCE}, now a mirror. Run 'squirrel skills install' once to switch to ${SKILL_REPO}.`
      );
    }
    console.log(`View skills: ${SKILLS_URL}`);
  },
});

export const skills = defineCommand({
  meta: {
    name: "skills",
    description: "Manage agent skills (Claude Code, Cursor, Codex, and more)",
  },
  subCommands: {
    install: skillsInstall,
    update: skillsUpdate,
  },
});
