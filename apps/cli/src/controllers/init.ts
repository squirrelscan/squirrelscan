// Generic init command - interface-agnostic

import { existsSync } from "node:fs";

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
