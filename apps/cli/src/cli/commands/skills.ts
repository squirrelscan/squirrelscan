import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";

import { safeExit } from "@/self/updater";

const SKILL_REPO = "https://github.com/squirrelscan/squirrelscan";
const SKILL_NAMES = ["squirrelscan", "audit-website"] as const;
const SKILLS_URL = "https://skills.sh/squirrelscan";

function isNpxAvailable(): boolean {
  const result = spawnSync("npx", ["--version"], {
    shell: true,
    stdio: "pipe",
  });
  return !result.error && result.status === 0;
}

function showManualInstructions(action: "install" | "update"): void {
  const cmd =
    action === "install"
      ? `npx skills add ${SKILL_REPO} -g`
      : `npx skills update ${SKILL_REPO} -g`;

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

    const result = spawnSync("npx", ["skills", "add", SKILL_REPO, "-g"], {
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

    const result = spawnSync("npx", ["skills", "update", SKILL_REPO, "-g"], {
      stdio: "inherit",
      shell: true,
    });

    if (result.error || result.status !== 0) {
      console.error("\nFailed to update skills.");
      showManualInstructions("update");
      return safeExit(1);
    }

    console.log("\nSkills updated!");
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
