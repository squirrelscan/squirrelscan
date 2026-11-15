// #1090: the banner nudge reads a cached value and refreshes it in the
// background, at most hourly. No network: the count/list calls are injected.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { UserSettings } from "@/self/types";

import { printSupportNudge } from "@/cli/banner";
import {
  SUPPORT_UNREAD_REFRESH_MS,
  type SupportUnread,
  clearSupportNudge,
  isSupportUnreadStale,
  refreshSupportUnread,
  supportNudgeLine,
} from "@/lib/support-nudge";
import { DEFAULT_SETTINGS } from "@/self/settings";

const NOW = Date.parse("2026-06-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("supportNudgeLine", () => {
  test("names the ref and the command to run", () => {
    expect(
      supportNudgeLine({
        support_unread: { ref: "ABCDE", count: 1, checked_at: iso(NOW) },
      })
    ).toBe("Support replied on ABCDE: squirrel support view ABCDE");
  });
  test("silent with no cache, no unread, or no ref", () => {
    expect(supportNudgeLine({})).toBeNull();
    expect(
      supportNudgeLine({
        support_unread: { ref: "ABCDE", count: 0, checked_at: iso(NOW) },
      })
    ).toBeNull();
    expect(
      supportNudgeLine({
        support_unread: { ref: null, count: 2, checked_at: iso(NOW) },
      })
    ).toBeNull();
  });
});

describe("isSupportUnreadStale", () => {
  const at = (ms: number) => ({
    support_unread: { ref: null, count: 0, checked_at: iso(ms) },
  });
  test("fresh inside the hour, stale at it", () => {
    expect(isSupportUnreadStale(at(NOW - 60_000), NOW)).toBe(false);
    expect(isSupportUnreadStale(at(NOW - SUPPORT_UNREAD_REFRESH_MS), NOW)).toBe(
      true
    );
  });
  test("missing, garbled and future stamps are due", () => {
    expect(isSupportUnreadStale({}, NOW)).toBe(true);
    expect(
      isSupportUnreadStale(
        { support_unread: { ref: null, count: 0, checked_at: "nope" } },
        NOW
      )
    ).toBe(true);
    expect(isSupportUnreadStale(at(NOW + 5 * 3600_000), NOW)).toBe(true);
  });
});

describe("refreshSupportUnread", () => {
  const ok = <T>(data: T) => ({ ok: true, status: 200, data });

  test("stores the count and the first unread ref", async () => {
    const saved: SupportUnread[] = [];
    const result = await refreshSupportUnread(null, {
      now: () => NOW,
      save: (v) => void saved.push(v),
      count: (async () => ok({ count: 2 })) as never,
      list: (async () =>
        ok({
          data: [
            { ref: "READ1", isUserRead: true },
            { ref: "NEWER", isUserRead: false },
          ],
          total: 2,
        })) as never,
    });
    expect(result).toEqual({ ref: "NEWER", count: 2, checked_at: iso(NOW) });
    expect(saved).toEqual([result!]);
  });

  test("a zero count skips the list call", async () => {
    let listed = false;
    const result = await refreshSupportUnread(
      { ref: "OLD12", count: 1, checked_at: iso(NOW - 1e7) },
      {
        now: () => NOW,
        save: () => {},
        count: (async () => ok({ count: 0 })) as never,
        list: (async () => {
          listed = true;
          return ok({ data: [], total: 0 });
        }) as never,
      }
    );
    expect(listed).toBe(false);
    expect(result).toEqual({ ref: null, count: 0, checked_at: iso(NOW) });
  });

  test("an API failure keeps the old value, restamps it, and never throws", async () => {
    const prev = { ref: "KEEP1", count: 1, checked_at: iso(NOW - 1e7) };
    const result = await refreshSupportUnread(prev, {
      now: () => NOW,
      save: () => {},
      count: (async () => ({ ok: false, status: 0, data: null })) as never,
    });
    expect(result).toEqual({ ref: "KEEP1", count: 1, checked_at: iso(NOW) });

    const thrown = await refreshSupportUnread(prev, {
      save: () => {},
      count: (async () => {
        throw new Error("boom");
      }) as never,
    });
    expect(thrown).toBeNull();
  });
});

describe("clearSupportNudge", () => {
  const settings = {
    support_unread: { ref: "ABCDE", count: 2, checked_at: iso(NOW) },
  };
  test("viewing the cached ref clears the ref and one from the count", () => {
    const saved: SupportUnread[] = [];
    clearSupportNudge(settings, "abcde", (v) => void saved.push(v));
    expect(saved).toEqual([{ ref: null, count: 1, checked_at: iso(NOW) }]);
  });
  test("another ref leaves the cache alone", () => {
    let called = false;
    clearSupportNudge(settings, "OTHER", () => (called = true));
    expect(called).toBe(false);
  });
});

describe("printSupportNudge", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  function withSettings(patch: Partial<UserSettings>): UserSettings {
    return { ...DEFAULT_SETTINGS, ...patch };
  }

  test("prints the cached nudge to stderr, from a fresh cache without any refresh", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    spies.push(err);
    const fetchSpy = spyOn(globalThis, "fetch");
    spies.push(fetchSpy);
    printSupportNudge(
      withSettings({
        notifications: true,
        support_unread: {
          ref: "ABCDE",
          count: 1,
          checked_at: new Date().toISOString(),
        },
      })
    );
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain(
      "Support replied on ABCDE: squirrel support view ABCDE"
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("silent when notifications are off or nothing is cached", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    spies.push(err);
    const fetchSpy = spyOn(globalThis, "fetch");
    spies.push(fetchSpy);
    const fresh = new Date().toISOString();
    printSupportNudge(
      withSettings({
        notifications: false,
        support_unread: { ref: "ABCDE", count: 1, checked_at: fresh },
      })
    );
    printSupportNudge(
      withSettings({
        notifications: true,
        support_unread: { ref: null, count: 0, checked_at: fresh },
      })
    );
    expect(err).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
