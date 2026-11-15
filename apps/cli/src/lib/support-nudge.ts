// The support banner nudge (#1090): "Support replied on ABCDE". It reads a value
// cached in settings, so showing it never touches the network, and refreshes
// that value in the background. Everything here is failure-safe: a nudge must
// never slow or break the command it rides on.

import type { UserSettings } from "@/self/types";

import { resolveCredential } from "@/self/credentials";
import { updateSettings } from "@/self/settings";

import { isOrgApiKey, listSupportTickets, supportUnreadCount } from "./support";

/** The cache is refreshed at most this often. */
export const SUPPORT_UNREAD_REFRESH_MS = 60 * 60 * 1000;
/** A background refresh gives up after this long. */
export const SUPPORT_UNREAD_TIMEOUT_MS = 2000;

export type SupportUnread = NonNullable<UserSettings["support_unread"]>;

/** The nudge line for the cached state, or null when there is nothing to say. */
export function supportNudgeLine(
  settings: Pick<UserSettings, "support_unread">
): string | null {
  const cached = settings.support_unread;
  if (!cached || cached.count <= 0 || !cached.ref) return null;
  return `Support replied on ${cached.ref}: squirrel support view ${cached.ref}`;
}

/** Whether the cache is old enough (or missing) for a refresh. */
export function isSupportUnreadStale(
  settings: Pick<UserSettings, "support_unread">,
  now: number = Date.now()
): boolean {
  const checkedAt = settings.support_unread?.checked_at;
  if (!checkedAt) return true;
  const last = Date.parse(checkedAt);
  if (Number.isNaN(last)) return true;
  const elapsed = now - last;
  return elapsed < 0 || elapsed >= SUPPORT_UNREAD_REFRESH_MS;
}

export interface RefreshDeps {
  now?: () => number;
  save?: (value: SupportUnread) => void;
  count?: typeof supportUnreadCount;
  list?: typeof listSupportTickets;
}

/** One refresh of the cached value. Returns what it stored; throws nothing. */
export async function refreshSupportUnread(
  previous: SupportUnread | null | undefined,
  deps: RefreshDeps = {}
): Promise<SupportUnread | null> {
  const now = deps.now ?? Date.now;
  const save =
    deps.save ?? ((value) => void updateSettings({ support_unread: value }));
  try {
    let next: SupportUnread = {
      ref: previous?.ref ?? null,
      count: previous?.count ?? 0,
      // Stamped even when the API fails, so an outage is retried hourly, not on every run.
      checked_at: new Date(now()).toISOString(),
    };
    const counted = await (deps.count ?? supportUnreadCount)({
      timeoutMs: SUPPORT_UNREAD_TIMEOUT_MS,
    });
    if (counted.ok && counted.data && typeof counted.data.count === "number") {
      next = {
        ref: null,
        count: counted.data.count,
        checked_at: next.checked_at,
      };
      if (next.count > 0) {
        const listed = await (deps.list ?? listSupportTickets)({
          limit: 100,
          timeoutMs: SUPPORT_UNREAD_TIMEOUT_MS,
        });
        const unread = listed.ok
          ? listed.data?.data.find((t) => t.isUserRead === false)
          : undefined;
        next.ref = unread?.ref ?? null;
      }
    }
    save(next);
    return next;
  } catch {
    return null;
  }
}

/**
 * Kick off a background refresh when signed in with a login session and the
 * cache is stale. Not awaited. An org API key is skipped: the routes refuse it.
 */
export function startSupportRefresh(settings: UserSettings): void {
  try {
    if (!isSupportUnreadStale(settings)) return;
    const credential = resolveCredential();
    if (!credential || isOrgApiKey(credential.token)) return;
    void refreshSupportUnread(settings.support_unread).catch(() => {});
  } catch {
    // Swallowed on purpose.
  }
}

/** `squirrel support view <REF>` was shown: stop nudging about it. */
export function clearSupportNudge(
  settings: Pick<UserSettings, "support_unread">,
  ref: string,
  save: (value: SupportUnread) => void = (value) =>
    void updateSettings({ support_unread: value })
): void {
  const cached = settings.support_unread;
  if (!cached || cached.ref?.toUpperCase() !== ref.toUpperCase()) return;
  save({
    ref: null,
    count: Math.max(0, cached.count - 1),
    checked_at: cached.checked_at,
  });
}
