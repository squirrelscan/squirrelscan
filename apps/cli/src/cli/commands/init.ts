// squirrelscan init - CLI wrapper

import { defineCommand } from "citty";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyTOML } from "smol-toml";

import { initConfig } from "@/controllers/init";
import { safeExit } from "@/self/updater";

const CONFIG_FILENAME = "squirrel.toml";

export const init = defineCommand({
  meta: {
    name: "init",
    description: "Create squirrel.toml",
  },
  args: {
    force: {
      type: "boolean",
      alias: "f",
      description: "Overwrite existing config",
    },
    "project-name": {
      type: "string",
      alias: "n",
      description: "Project name",
    },
  },
  async run({ args }) {
    const configPath = join(process.cwd(), CONFIG_FILENAME);

    const result = initConfig({
      configPath,
      force: args.force,
      projectName: args["project-name"],
    });

    if (!result.ok) {
      console.error(result.error.message);
      console.log("Use --force to overwrite");
      return safeExit(1);
    }

    // Write the config file
    writeFileSync(configPath, stringifyTOML(result.data.config));
    console.log(`Created: ${configPath}`);
  },
});
