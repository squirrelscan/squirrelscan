// Per-org persisted channel state (#569): the feed cursor plus a bounded
// seen-set, so a restart catches up exactly once and a feed without cursors
// still never repeats an event.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getSquirrelPaths } from "@/self/paths";
import { logger } from "@/utils/logger";

export const MAX_SEEN_KEYS = 500;

export interface ChannelState {
  version: 1;
  // Opaque cursor from the feed; null until the server hands one out.
  cursor: string | null;
  // False until the first poll ever has set the "start from now" baseline.
  bootstrapped: boolean;
  // Notification ids and run keys already delivered (oldest first, bounded).
  seen: string[];
}

export interface StateStore {
  load(): ChannelState;
  save(state: ChannelState): void;
}

export function emptyState(): ChannelState {
  return { version: 1, cursor: null, bootstrapped: false, seen: [] };
}

export function rememberSeen(state: ChannelState, keys: string[]): void {
  const known = new Set(state.seen);
  for (const key of keys) {
    if (!known.has(key)) {
      known.add(key);
      state.seen.push(key);
    }
  }
  if (state.seen.length > MAX_SEEN_KEYS) {
    state.seen = state.seen.slice(state.seen.length - MAX_SEEN_KEYS);
  }
}

function parseState(raw: string): ChannelState {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") return emptyState();
  const record = value as Record<string, unknown>;
  return {
    version: 1,
    cursor: typeof record.cursor === "string" ? record.cursor : null,
    bootstrapped: record.bootstrapped === true,
    seen: Array.isArray(record.seen)
      ? record.seen
          .filter((key): key is string => typeof key === "string")
          .slice(-MAX_SEEN_KEYS)
      : [],
  };
}

export function getChannelStatePath(orgId: string, baseDir?: string): string {
  const dir = baseDir ?? join(getSquirrelPaths().data, "channel");
  return join(dir, `${orgId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function createFileStateStore(
  orgId: string,
  baseDir?: string
): StateStore {
  const path = getChannelStatePath(orgId, baseDir);
  return {
    load() {
      try {
        return parseState(readFileSync(path, "utf8"));
      } catch (error) {
        // Missing is the normal first run; a corrupt file also restarts from "now" rather than replaying history.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.debug("channel: state unreadable, starting fresh", error);
        }
        return emptyState();
      }
    },
    save(state) {
      try {
        mkdirSync(join(path, ".."), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        renameSync(tmp, path);
      } catch (error) {
        logger.debug("channel: could not persist state", error);
      }
    },
  };
}
