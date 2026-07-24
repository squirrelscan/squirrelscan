// Generic config command - interface-agnostic

import { existsSync, readFileSync } from "node:fs";
import { parse as parseTOML } from "smol-toml";

import { ConfigSchema, type SquirrelScanConfig } from "@/config";
import { redactValue } from "@/utils/redact";

import { type Result, ok, err, commandError, ErrorCodes } from "./types";

export interface ShowConfigResult {
  config: SquirrelScanConfig;
  configPath: string;
}

export interface SetConfigResult {
  config: SquirrelScanConfig;
  configPath: string;
  key: string;
  value: unknown;
}

const REDACTED = "[REDACTED]";

export function isSensitiveConfigPath(key: string): boolean {
  return (
    key === "crawler.headers" ||
    key.startsWith("crawler.headers.") ||
    /^intel\.providers\.[^.]+\.api_key$/.test(key)
  );
}

export function redactConfigValueForDisplay(
  key: string,
  value: unknown
): unknown {
  return isSensitiveConfigPath(key) ? REDACTED : redactValue(value);
}

export function redactConfigForDisplay(
  config: SquirrelScanConfig
): SquirrelScanConfig {
  const redacted = redactValue(config) as SquirrelScanConfig;

  redacted.crawler.headers = Object.fromEntries(
    Object.keys(config.crawler.headers).map((name) => [name, REDACTED])
  );

  if (redacted.intel?.providers) {
    for (const provider of Object.values(redacted.intel.providers)) {
      if (provider?.api_key !== undefined) provider.api_key = REDACTED;
    }
  }

  return redacted;
}

/**
 * Get the current config
 */
export function showConfig(
  configPath: string | null
): Result<ShowConfigResult> {
  if (!configPath) {
    return err(
      commandError(ErrorCodes.CONFIG_NOT_FOUND, "No config file found")
    );
  }

  if (!existsSync(configPath)) {
    return err(
      commandError(
        ErrorCodes.FILE_NOT_FOUND,
        `Config file not found: ${configPath}`
      )
    );
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = parseTOML(content);
    const validated = ConfigSchema.safeParse(parsed);
    if (!validated.success) {
      const issue = validated.error.issues[0];
      const path = issue.path.length ? issue.path.join(".") : "root";
      return err(
        commandError(
          ErrorCodes.INVALID_CONFIG,
          `Invalid config: ${path}: ${issue.message}`
        )
      );
    }
    return ok({ config: validated.data, configPath });
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.FILE_READ_ERROR,
        `Failed to read config: ${(error as Error).message}`,
        { path: configPath }
      )
    );
  }
}

/**
 * Parse a string value to its appropriate type
 */
function parseValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;

  // Parse JSON for arrays/objects
  if (
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith("{") && value.endsWith("}"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  // Only parse as number if non-empty and actually numeric
  const trimmed = value.trim();
  if (trimmed !== "" && !isNaN(Number(trimmed))) {
    return Number(trimmed);
  }

  return value;
}

/**
 * Set a config value (supports dot notation)
 * Returns the updated config - caller handles file writing
 */
export function setConfigValue(
  configPath: string | null,
  key: string,
  value: string
): Result<SetConfigResult> {
  if (!configPath) {
    return err(
      commandError(ErrorCodes.CONFIG_NOT_FOUND, "No config file found")
    );
  }

  if (!existsSync(configPath)) {
    return err(
      commandError(
        ErrorCodes.FILE_NOT_FOUND,
        `Config file not found: ${configPath}`
      )
    );
  }

  let config: Record<string, unknown>;
  try {
    const content = readFileSync(configPath, "utf-8");
    config = parseTOML(content) as Record<string, unknown>;
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.FILE_READ_ERROR,
        `Failed to read config: ${(error as Error).message}`,
        { path: configPath }
      )
    );
  }

  // Parse value
  const parsedValue = parseValue(value);

  // Set the value (supports dot notation for nested keys)
  // Note: writing back with stringifyTOML will lose any comments/formatting
  const keys = key.split(".");
  let obj: Record<string, unknown> = config;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in obj)) {
      obj[keys[i]] = {};
    }
    obj = obj[keys[i]] as Record<string, unknown>;
  }
  obj[keys[keys.length - 1]] = parsedValue;

  // Validate updated config against schema
  const validated = ConfigSchema.safeParse(config);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const path = issue.path.length ? issue.path.join(".") : key;
    return err(
      commandError(
        ErrorCodes.INVALID_VALUE,
        `Invalid value for ${path}: ${issue.message}`
      )
    );
  }

  // Check if the key actually exists in the validated config
  // (Zod strips unknown keys silently)
  let validatedObj: Record<string, unknown> = validated.data as Record<
    string,
    unknown
  >;
  for (const k of keys) {
    if (validatedObj === undefined || !(k in validatedObj)) {
      return err(
        commandError(
          ErrorCodes.INVALID_VALUE,
          `Unknown config key: ${key}. Run 'squirrel config show' to see valid keys.`
        )
      );
    }
    validatedObj = validatedObj[k] as Record<string, unknown>;
  }

  return ok({
    config: validated.data,
    configPath,
    key,
    value: parsedValue,
  });
}

/**
 * Get the config file path
 */
export function getConfigPath(configPath: string | null): Result<string> {
  if (!configPath) {
    return err(
      commandError(ErrorCodes.CONFIG_NOT_FOUND, "No config file found")
    );
  }

  return ok(configPath);
}
