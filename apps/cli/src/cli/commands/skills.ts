import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";

import {
  LEGACY_SOURCE,
  SKILLS_CLI,
  SKILL_NAMES,
  SKILL_REPO,
  planSkillsRefresh,
  readInstalledSkills,
  runSkillsAutoRefresh,
} from "@/self/agent-skills";
import { safeExit } from "@/self/updater";

// squirrelscan/skills is the only home of the skills; install from nowhere else.
const SKILLS_URL = "https://skills.sh/squirrelscan/skills";

const ADD_ARGS = [SKILLS_CLI, "add", SKILL_REPO, "-g"];

function isNpxAvailable(): boolean {
  const result = spawnSync("npx", ["--version"], {
    shell: true,
    stdio: "pipe",
  });
  return !result.error && result.status === 0;
}

function showManualInstructions(commands: string[][]): void {
  console.log("\nTo run manually:");
  for (const args of commands) console.log(`  npx ${args.join(" ")}`);
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
      showManualInstructions([ADD_ARGS]);
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
      showManualInstructions([ADD_ARGS]);
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
  args: {
    auto: {
      type: "boolean",
      description:
        "Silent global refresh (used internally after a CLI auto-update)",
    },
  },
  async run({ args }) {
    if (args.auto) {
      // Detached child started after a CLI auto-update landed: never prints,
      // never prompts, never fails the run that started it.
      await runSkillsAutoRefresh();
      return;
    }

    // Installs recorded from squirrelscan/squirrelscan are re-added from
    // squirrelscan/skills, the rest updated, global and project alike.
    const installed = await readInstalledSkills();
    if (!installed.length) {
      console.log(
        "No squirrelscan skills are installed here. Install them with: squirrel skills install"
      );
      return;
    }
    const commands = planSkillsRefresh(installed, ["global", "project"]).map(
      (args) => [SKILLS_CLI, ...args]
    );

    if (!isNpxAvailable()) {
      console.log("npx not found. Install Node.js or run manually:");
      showManualInstructions(commands);
      return safeExit(0);
    }

    const moving = [
      ...new Set(installed.filter((s) => s.legacy).map((s) => s.name)),
    ];
    if (moving.length) {
      console.log(
        `Moving ${moving.join(", ")} from ${LEGACY_SOURCE} to ${SKILL_REPO}...`
      );
    }
    const names = [...new Set(installed.map((s) => s.name))];
    console.log(`Updating squirrelscan skills (${names.join(", ")})...`);

    for (const argv of commands) {
      const result = spawnSync("npx", argv, {
        stdio: "inherit",
        shell: true,
      });
      if (result.error || result.status !== 0) {
        console.error("\nFailed to update skills.");
        showManualInstructions(commands);
        return safeExit(1);
      }
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
