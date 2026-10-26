// Is an unfinished crawl abandoned? (#946)
//
// This decides what retention may DELETE, so every doubt resolves to "live".
// Pure apart from the injected environment, so each failure mode is testable.
//
// A crawl row carries a lease written by the process driving it (owner pid,
// owner host, heartbeat). The verdict, for an unfinished, not-retired crawl:
//
//  1. No heartbeat, or no owner (a lease released by a command that ended, or
//     one an older CLI never wrote), or a heartbeat that cannot be read: the
//     LEGACY rule (#945: a newer audit finished, and the crawl has been idle).
//  2. An owner is set. Fresh heartbeat (age under the stale window, including a
//     negative age after a clock step back): LIVE, whatever the legacy rule says.
//  3. Stale heartbeat, owner on THIS host with a readable pid that is alive and a
//     heartbeat under 24 h old: LIVE (a blocked event loop or a sleeping laptop;
//     the 24 h cap bounds pid reuse).
//  4. Otherwise the lease is dead. A killed `running` crawl is what `--resume`
//     continues, so it is abandoned only after 24 h without a heartbeat; a
//     `crawled` one once the stale window has passed. `stopped`, `paused` and
//     `failed` keep the legacy verdict (7 days for the resumable ones): a dead
//     lease never retires them sooner. The legacy rule still applies on top, so
//     a dead lease is never kept LONGER than #945 would have kept it.
//
// An owner on another host, or one whose pid or host cannot be read, gets no
// pid probe: it is live until the stale window passes, then dead.

import { hostname } from "node:os";

import {
  CRAWL_LEASE_PID_TRUST_MS,
  CRAWL_LEASE_STALE_MS,
} from "./types";

export interface LeaseEnv {
  readonly now: () => number;
  readonly hostname: () => string;
  readonly pidAlive: (pid: number) => boolean;
}

/** A readable pid is a positive integer: 0 and negatives would signal process groups. */
export function isReadablePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

/**
 * Signal 0 probe. EPERM means the process exists (another user's); anything
 * unexpected also reads as alive. Only ESRCH is "dead".
 */
export function isPidAlive(pid: number): boolean {
  if (!isReadablePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "";
  }
}

export const REAL_LEASE_ENV: LeaseEnv = {
  now: () => Date.now(),
  hostname: safeHostname,
  pidAlive: isPidAlive,
};

export interface LeaseCrawlRow {
  readonly status: string;
  readonly heartbeat_at: unknown;
  readonly owner_pid: unknown;
  readonly owner_host: unknown;
  /** The #945 rule, computed in SQL: 1 when it calls the crawl abandoned. */
  readonly legacy_abandoned: number;
}

export function isCrawlAbandoned(row: LeaseCrawlRow, env: LeaseEnv): boolean {
  const legacy = Number(row.legacy_abandoned) === 1;
  const hb = row.heartbeat_at;
  const hasOwner = row.owner_pid != null || row.owner_host != null;
  if (typeof hb !== "number" || !Number.isFinite(hb) || !hasOwner) return legacy;

  const age = env.now() - hb;
  // A heartbeat more than a day in the future is a clock that is not ours or a
  // corrupt value: do not trust it either way, fall back to #945.
  if (age < -CRAWL_LEASE_PID_TRUST_MS) return legacy;
  if (age < CRAWL_LEASE_STALE_MS) return false;

  const pid = row.owner_pid;
  const host = row.owner_host;
  if (
    isReadablePid(pid) &&
    typeof host === "string" &&
    host !== "" &&
    host === env.hostname() &&
    age < CRAWL_LEASE_PID_TRUST_MS &&
    env.pidAlive(pid)
  ) {
    return false;
  }

  // Only `running` and `crawled` use a dead lease to retire EARLIER than #945.
  // `stopped`, `paused` and `failed` are what `--resume` continues and #945 keeps
  // them 7 days: an owner left behind by a kill -9 right after the status write
  // (or a failed release) must not shorten that.
  if (row.status === "running") return age >= CRAWL_LEASE_PID_TRUST_MS || legacy;
  if (row.status === "crawled") return true;
  return legacy;
}
