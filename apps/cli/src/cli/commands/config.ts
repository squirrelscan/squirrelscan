// squirrelscan config - CLI wrapper

import { defineCommand } from "citty";
import { writeFileSync } from "node:fs";
import { stringify as stringifyTOML } from "smol-toml";

import { findConfigFile } from "@/config";
import {
  showConfig,
  setConfigValue,
  getConfigPath,
} from "@/controllers/config";
import { warnIfSessionUnreadable } from "@/self/credentials";
import { safeExit } from "@/self/updater";

export const config = defineCommand({
  meta: {
    name: "config",
    description: "Show or edit configuration",
  },
  subCommands: {
    show: defineCommand({
      meta: {
        name: "show",
        description: "Show current config",
      },
      run() {
        warnIfSessionUnreadable();
        const configPath = findConfigFile();
        const result = showConfig(configPath);

        if (!result.ok) {
          console.log(result.error.message);
          console.log("Run 'squirrel init' to create one");
          return;
        }

        console.log(`Config file: ${result.data.configPath}`);
        console.log("");
        console.log(stringifyTOML(result.data.config));
        console.log("");
        console.log("Crawler keys:");
        console.log(
          "  crawler.timeout_ms, crawler.per_host_concurrency, crawler.per_host_delay_ms"
        );
        console.log(
          "  crawler.include, crawler.exclude, crawler.allow_query_params"
        );
        console.log("  crawler.respect_robots");
      },
    }),
    set: defineCommand({
      meta: {
        name: "set",
        description: "Set config value",
      },
      args: {
        key: {
          type: "positional",
          description: "Config key (e.g., crawler.max_pages)",
          required: true,
        },
        value: {
          type: "positional",
          description: "New value",
          required: true,
        },
        "dry-run": {
          type: "boolean",
          description: "Preview change without writing",
        },
      },
      async run({ args }) {
        warnIfSessionUnreadable();
        const configPath = findConfigFile();
        const result = setConfigValue(
          configPath,
          String(args.key),
          String(args.value)
        );

        if (!result.ok) {
          console.error(result.error.message);
          if (result.error.code === "CONFIG_NOT_FOUND") {
            console.log("Run 'squirrel init' to create one");
          }
          return safeExit(1);
        }

        if (args["dry-run"]) {
          console.log(`Would set ${result.data.key} = ${result.data.value}`);
          console.log("");
          console.log(stringifyTOML(result.data.config));
          return;
        }

        // Write the updated config
        writeFileSync(
          result.data.configPath,
          stringifyTOML(result.data.config)
        );
        console.log(`Set ${result.data.key} = ${result.data.value}`);
      },
    }),
    path: defineCommand({
      meta: {
        name: "path",
        description: "Show config file path",
      },
      async run() {
        warnIfSessionUnreadable();
        const configPath = findConfigFile();
        const result = getConfigPath(configPath);

        if (!result.ok) {
          console.log(result.error.message);
          return safeExit(1);
        }

        console.log(result.data);
      },
    }),
    validate: defineCommand({
      meta: {
        name: "validate",
        description: "Validate config file",
      },
      async run() {
        warnIfSessionUnreadable();
        const configPath = findConfigFile();
        const result = showConfig(configPath);

        if (!result.ok) {
          console.error(result.error.message);
          return safeExit(1);
        }

        console.log(`Config valid: ${result.data.configPath}`);
      },
    }),
  },
});
