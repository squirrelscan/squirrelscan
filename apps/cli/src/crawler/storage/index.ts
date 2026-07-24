// Storage layer exports and factory

import { randomUUID } from "crypto";
import { Effect } from "effect";
import { mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getProjectsPath } from "@/self/paths";
import { logger } from "@/utils/logger";
import { isLocalhost } from "@/utils/url";

import type { CrawlStorage, StorageOptions } from "./types";

import { getGlobalContentStore } from "./content-store";
import { SQLiteStorage } from "./sqlite";
import { StorageError } from "./types";

export * from "./types";
export { SQLiteStorage } from "./sqlite";

/**
 * Convert a URL to a project name (domain-based)
 * example.com -> example-com
 * localhost:3000 -> localhost-3000 (include port for local dev)
 */
export function domainToProjectName(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const base = hostname.replace(/\./g, "-");
    // Include port for localhost (localhost:3000 -> localhost-3000)
    if (isLocalhost(hostname) && parsed.port) {
      return `${base}-${parsed.port}`;
    }
    return base;
  } catch {
    return "default";
  }
}

/**
 * Get the database path for a project
 * Creates the project directory if it doesn't exist
 */
export function getProjectDbPath(projectName: string): string {
  const projectsDir = getProjectsPath();
  const projectDir = join(projectsDir, projectName);

  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  return join(projectDir, "project.db");
}

/**
 * Get the database path for storage options
 */
function getDbPath(opts: StorageOptions): string {
  if (opts.path) {
    return opts.path;
  }
  const projectName = opts.projectName ?? "default";
  return getProjectDbPath(projectName);
}

/**
 * Create a storage instance
 */
export function createStorage(
  options: StorageOptions = {}
): Effect.Effect<CrawlStorage, StorageError, never> {
  return Effect.gen(function* () {
    const path = getDbPath(options);
    if (!options.silent) {
      // Debug log, not console: dev-only noise that used to collide with the spinner.
      logger.debug(`Database: ${path}`);
    }
    const storage = new SQLiteStorage(path, getGlobalContentStore());
    yield* storage.init();
    return storage;
  });
}

/**
 * Create an in-memory storage for tests
 */
export function createTestStorage(): Effect.Effect<
  CrawlStorage,
  StorageError,
  never
> {
  return Effect.gen(function* () {
    if (!process.env.SQUIRREL_CONTENT_STORE_PATH) {
      process.env.SQUIRREL_CONTENT_STORE_PATH = join(
        tmpdir(),
        `squirrel-content-store-${randomUUID()}.db`
      );
    }
    const storage = new SQLiteStorage(":memory:", getGlobalContentStore());
    yield* storage.init();
    return storage;
  });
}
