// Configuration management for SquirrelScan CLI
// Schema + types + defaults come from @squirrelscan/config.
// This file adds CLI-specific TOML loading, file discovery, and process.exit.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseTOML } from "smol-toml";
import { z } from "zod";

// Re-export everything from the config package so existing
// `import { Config, getDefaultConfig } from "@/config"` still works.
export {
  COVERAGE_MODES,
  type CoverageMode,
  CrawlerConfigSchema,
  ProjectConfigSchema,
  RulesConfigSchema,
  PluginCapabilitySchema,
  PluginManifestItemSchema,
  PluginsConfigSchema,
  ExternalLinksConfigSchema,
  OutputConfigSchema,
  ConfigSchema,
  type Config,
  type ProjectConfig,
  type CrawlerConfig,
  type RulesConfig,
  type PluginCapability,
  type PluginManifestItem,
  type PluginsConfig,
  type ExternalLinksConfig,
  type OutputConfig,
  getDefaultConfig,
  DEFAULT_CRAWLER_CONCURRENCY,
  DEFAULT_CRAWLER_PER_HOST_CONCURRENCY,
  DEFAULT_CRAWLER_PER_HOST_DELAY_MS,
} from "@squirrelscan/config";

import {
  ConfigSchema,
  getDefaultConfig,
  type Config,
} from "@squirrelscan/config";

import { safeExit } from "@/self/updater";

// ============================================
// CLI-SPECIFIC CONFIG FUNCTIONS
// ============================================

// Get project name from config or derive from cwd
export function getProjectName(config: Config): string {
  if (config.project.name) {
    return config.project.name;
  }
  return basename(process.cwd());
}

// ============================================
// CONFIG LOADING (CLI-only — TOML, filesystem)
// ============================================

const CONFIG_FILENAME = "squirrel.toml";

// Global config path set by CLI root command
let globalConfigPath: string | undefined;

export function setGlobalConfigPath(path: string | undefined): void {
  globalConfigPath = path;
}

export function getGlobalConfigPath(): string | undefined {
  return globalConfigPath;
}

// Deep merge utility — arrays replace, objects deep merge
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal !== undefined &&
      typeof sourceVal === "object" &&
      sourceVal !== null &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      ) as T[keyof T];
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal as T[keyof T];
    }
  }
  return result;
}

// Find config file walking up directory tree, stopping at home dir
export function findConfigFile(
  startDir: string = process.cwd()
): string | null {
  let dir = startDir;
  const home = homedir();

  while (true) {
    const configPath = join(dir, CONFIG_FILENAME);
    if (existsSync(configPath)) {
      return configPath;
    }

    if (dir === home) break;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Load and parse config file
export async function loadConfig(
  configPath?: string,
  options?: { silent?: boolean }
): Promise<Config> {
  const path = configPath ?? findConfigFile();

  if (!path || !existsSync(path)) {
    if (!options?.silent) {
      console.log("Config: (none, using defaults)");
    }
    return getDefaultConfig();
  }

  if (!options?.silent) {
    console.log(`Config: ${path}`);
  }

  try {
    const content = readFileSync(path, "utf-8");
    const parsed = parseTOML(content);
    const defaults = getDefaultConfig();
    const merged = deepMerge(defaults, parsed as Partial<Config>);
    return ConfigSchema.parse(merged);
  } catch (error) {
    console.error(`Failed to load config file: ${path}`);

    if (error instanceof z.ZodError) {
      console.error("Config values did not match expected types:");
      for (const issue of error.issues) {
        const issuePath = issue.path.length ? issue.path.join(".") : "root";
        console.error(`- ${issuePath}: ${issue.message}`);
      }
    } else if (error instanceof Error && error.name === "TomlError") {
      console.error("TOML syntax error:");
      console.error(error.message);
    } else if (error instanceof Error) {
      console.error(error.message);
    }

    if (path.endsWith(".json")) {
      console.error(
        "Legacy JSON configs are no longer supported. Run `squirrel init` to create squirrel.toml."
      );
    } else {
      console.error("Fix the config file and try again.");
    }

    // Reachable from normal commands (audit/crawl/analyze via loadConfig),
    // which have already kicked off the background/inline updater — settle it
    // before exiting instead of hard-killing a mid-flight install (#1089).
    return safeExit(1);
  }
}

// Type alias for backwards compatibility
export type SquirrelScanConfig = Config;
