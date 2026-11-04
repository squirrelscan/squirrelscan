// Generic init command - interface-agnostic

import { existsSync } from "node:fs";
import { stringify as stringifyTOML } from "smol-toml";

import { getDefaultConfig, type SquirrelScanConfig } from "@/config";

import { type Result, ok, err, commandError, ErrorCodes } from "./types";

export interface InitOptions {
  configPath: string;
  force?: boolean;
  projectName?: string;
}

export interface InitResult {
  config: SquirrelScanConfig;
  configPath: string;
  overwritten: boolean;
}

/**
 * Initialize a new config file
 * Returns the config object on success - caller handles file writing
 */
export function initConfig(options: InitOptions): Result<InitResult> {
  const exists = existsSync(options.configPath);

  if (exists && !options.force) {
    return err(
      commandError(
        ErrorCodes.FILE_EXISTS,
        `Config file already exists: ${options.configPath}`,
        { path: options.configPath }
      )
    );
  }

  const config = getDefaultConfig();

  // Set project name if provided
  if (options.projectName) {
    config.project.name = options.projectName;
  }

  return ok({
    config,
    configPath: options.configPath,
    overwritten: exists,
  });
}

const COMMENTS: Readonly<Record<string, string>> = {
  "[project]": [
    "# Extra hostnames the crawl may follow (example.com also allows its subdomains).",
    '# Example: domains = ["example.com"]. Empty means the seed URL domain only.',
  ].join("\n"),
  "[rules]": [
    "# Rule ids look like category/rule (for example security/csp). Globs work: eeat/* is a whole category.",
    "# An id or glob that matches no rule is reported as a warning when you audit.",
    "# List ids at https://docs.squirrelscan.com/rules. disable wins over enable.",
    "# To waive a rule for some urls or items only, use an [[ignore]] table instead.",
  ].join("\n"),
};

/**
 * The squirrel.toml text `squirrel init` writes: the default config, a blank
 * line before every table (smol-toml omits it after an empty one, which glued
 * `[rules]` to `[crawler.headers]`), and a short comment on the tables that
 * need explaining.
 */
export function renderInitToml(config: SquirrelScanConfig): string {
  const out: string[] = [];
  for (const line of stringifyTOML(config).split("\n")) {
    if (line.startsWith("[")) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      const comment = COMMENTS[line];
      if (comment) out.push(comment);
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}
