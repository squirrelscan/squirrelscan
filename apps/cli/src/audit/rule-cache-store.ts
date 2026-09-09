// project.db-backed store for the per-page rule-result cache (#1990).
//
// The engine owns the KEY (only it holds the run context) and the PAYLOAD shape;
// this file owns nothing but persistence, which is why the interface it implements
// speaks in opaque strings. Two things it is responsible for:
//
//  - **Bounded residency.** Writes are buffered and flushed at every page-batch
//    boundary, so at most one batch of encoded payloads is ever held. Buffering
//    the whole run instead would hold tens of megabytes of JSON on the exact path
//    #1913 exists to keep flat.
//  - **A cheap warm run.** A replayed page is carried forward by SQL row copy
//    rather than re-encoded, so the run that replays everything does no
//    serialization work at all.

import type { RuleCacheStore } from "@squirrelscan/audit-engine";

import { Effect } from "effect";

import type { SQLiteStorage } from "@/crawler/storage/sqlite";

import { logger } from "@/utils/logger";

/**
 * The kill switch, mirroring `SQUIRREL_TEMPLATE_FANOUT` (#1951): the cache is ON,
 * and `SQUIRREL_RULE_CACHE` set to `0`, `false`, `off` or `no` turns it off for a
 * run without a rebuild. It exists for the same two reasons that one does — a
 * support session needs a way to rule the cache out of a wrong-looking report, and
 * a benchmark needs both arms in ONE build, because an A/B across two builds is an
 * A/B across two of everything.
 *
 * Read per run rather than at module load, so a bench can flip it between stages.
 */
export function ruleCacheEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.SQUIRREL_RULE_CACHE;
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  return !(
    value === "0" ||
    value === "false" ||
    value === "off" ||
    value === "no"
  );
}

export interface ProjectRuleCacheStore extends RuleCacheStore {
  /** Rows written for this crawl, for the audit's summary line. */
  readonly written: () => number;
}

/**
 * A store over one crawl's rows in `project.db`.
 *
 * Every failure here is swallowed to a debug line: a cache that cannot be read
 * costs a page's rules, and a cache that cannot be written costs the NEXT audit's.
 * Neither is worth failing an audit the user is waiting on.
 */
export function createProjectRuleCacheStore(
  storage: SQLiteStorage,
  crawlId: string
): ProjectRuleCacheStore {
  const pendingFresh: Array<{
    normalizedUrl: string;
    cacheKey: string;
    payload: string;
  }> = [];
  const pendingCarry: Array<{ normalizedUrl: string; cacheKey: string }> = [];
  let written = 0;

  return {
    written: () => written,

    async load(keys) {
      if (keys.length === 0) return new Map<string, string>();
      try {
        return await Effect.runPromise(storage.loadPageRuleCache(keys));
      } catch (error) {
        logger.debug(
          "rule cache read failed, running pages fresh",
          String(error)
        );
        return new Map<string, string>();
      }
    },

    putFresh(key, normalizedUrl, payload) {
      pendingFresh.push({ normalizedUrl, cacheKey: key, payload });
    },

    carryForward(key, normalizedUrl) {
      pendingCarry.push({ normalizedUrl, cacheKey: key });
    },

    async flush() {
      const fresh = pendingFresh.splice(0);
      const carry = pendingCarry.splice(0);
      if (fresh.length === 0 && carry.length === 0) return;
      try {
        if (fresh.length > 0) {
          await Effect.runPromise(
            storage.savePageRuleCacheBatch(crawlId, fresh)
          );
        }
        if (carry.length > 0) {
          await Effect.runPromise(
            storage.carryForwardPageRuleCache(crawlId, carry)
          );
        }
        written += fresh.length + carry.length;
      } catch (error) {
        logger.debug(
          "rule cache write failed, next audit runs cold",
          String(error)
        );
      }
    },
  };
}
