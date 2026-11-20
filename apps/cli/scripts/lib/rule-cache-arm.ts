// The `--rule-cache off|cold|warm` arm of the template fan-out bench (#1971).
//
// Kept apart from the bench script so the arm logic can be tested: the script
// itself runs a whole measurement on import. Everything here goes through the
// switch a real audit uses (`ruleCacheEnabled` and `createProjectRuleCacheStore`
// from `@/audit/rule-cache-store`), not a bench-only shortcut.

import { Database } from "bun:sqlite";

import type { SQLiteStorage } from "@/crawler/storage/sqlite";

import {
  createProjectRuleCacheStore,
  type ProjectRuleCacheStore,
  ruleCacheEnabled,
} from "@/audit/rule-cache-store";

export const RULE_CACHE_ARMS = ["off", "cold", "warm"] as const;
export type RuleCacheArm = (typeof RULE_CACHE_ARMS)[number];

/** A valid arm, or null for anything else (including the empty string). */
export function parseRuleCacheArm(raw: string): RuleCacheArm | null {
  return (RULE_CACHE_ARMS as readonly string[]).includes(raw) ? (raw as RuleCacheArm) : null;
}

/**
 * The environment a child runs under. `off` sets the real kill switch
 * (`SQUIRREL_RULE_CACHE=off`) and the other arms clear it, so an ambient value in
 * the operator's shell cannot turn a cold or warm run into an off run.
 */
export function armEnv(
  arm: RuleCacheArm,
  base: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const env = { ...base };
  if (arm === "off") env.SQUIRREL_RULE_CACHE = "off";
  else delete env.SQUIRREL_RULE_CACHE;
  return env;
}

/** The store a run of this arm uses, or undefined when the cache is disabled. */
export function armCacheStore(
  arm: RuleCacheArm,
  storage: SQLiteStorage,
  crawlId: string,
  env: Record<string, string | undefined> = armEnv(arm)
): ProjectRuleCacheStore | undefined {
  return ruleCacheEnabled(env) ? createProjectRuleCacheStore(storage, crawlId) : undefined;
}

/** Empty the cache table of a disposable copy. */
export function truncateRuleCache(db: string): void {
  const conn = new Database(db);
  try {
    conn.run("DELETE FROM page_rule_cache");
  } finally {
    conn.close();
  }
}

/** Rows in `page_rule_cache`; 0 when the table does not exist yet. */
export function countRuleCacheRows(db: string): number {
  const conn = new Database(db, { readonly: true });
  try {
    const row = conn
      .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'page_rule_cache'")
      .get() as { n: number };
    if (row.n === 0) return 0;
    return (conn.query("SELECT COUNT(*) AS n FROM page_rule_cache").get() as { n: number }).n;
  } finally {
    conn.close();
  }
}

/**
 * Put the copy into the state the arm measures, before any timer starts.
 *  - `cold`: truncated, every run pays the rules plus the cache writes. Call this
 *    before EVERY run.
 *  - `warm`: populated once by `fill`, which runs only if the table is empty, so
 *    calling it again does not refill.
 *  - `off`: left alone, the cache is not read or written.
 */
export async function prepareArmCache(
  arm: RuleCacheArm,
  db: string,
  fill: () => Promise<void>
): Promise<void> {
  if (arm === "cold") truncateRuleCache(db);
  else if (arm === "warm" && countRuleCacheRows(db) === 0) await fill();
}
