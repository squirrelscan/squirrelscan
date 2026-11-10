import { describe, expect, test } from "bun:test";

import type { UserSettings } from "@/self/types";

import { DEFAULT_SETTINGS } from "@/self/settings";
import {
  describeUpdate,
  isAttemptThrottled,
  isVersionDismissed,
  updateState,
  type UpdateState,
} from "@/self/update-state";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

const pending = {
  from_version: "0.0.1",
  to_version: "0.0.2",
  release_url: null,
};

function s(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_SETTINGS, auto_update: true, ...overrides };
}

const table: Array<{
  name: string;
  settings: UserSettings;
  managed: boolean;
  expected: UpdateState;
}> = [
  { name: "nothing pending", settings: s(), managed: true, expected: "none" },
  {
    name: "pending, never attempted",
    settings: s({ pending_update_notification: pending }),
    managed: true,
    expected: "pending",
  },
  {
    name: "pending on an unmanaged install",
    settings: s({
      pending_update_notification: pending,
      last_auto_update_attempt: iso(HOUR / 4),
    }),
    managed: false,
    expected: "pending",
  },
  {
    name: "pending with auto_update off ignores the throttle",
    settings: s({
      auto_update: false,
      pending_update_notification: pending,
      last_auto_update_attempt: iso(HOUR / 4),
    }),
    managed: true,
    expected: "pending",
  },
  {
    name: "attempt inside the throttle window",
    settings: s({
      pending_update_notification: pending,
      last_auto_update_attempt: iso(HOUR / 4),
    }),
    managed: true,
    expected: "attempting",
  },
  {
    name: "attempt older than the window",
    settings: s({
      pending_update_notification: pending,
      last_auto_update_attempt: iso(2 * HOUR),
    }),
    managed: true,
    expected: "pending",
  },
  {
    name: "corrupt attempt timestamp is not throttled",
    settings: s({
      pending_update_notification: pending,
      last_auto_update_attempt: "not-a-date",
    }),
    managed: true,
    expected: "pending",
  },
  {
    name: "same version failed at the threshold",
    settings: s({
      pending_update_notification: pending,
      auto_update_attempts: { version: "0.0.2", count: 2 },
      last_auto_update_attempt: iso(HOUR / 4),
    }),
    managed: true,
    expected: "fallback",
  },
  {
    name: "below the threshold is not fallback",
    settings: s({
      pending_update_notification: pending,
      auto_update_attempts: { version: "0.0.2", count: 1 },
    }),
    managed: true,
    expected: "pending",
  },
  {
    name: "counter for another version is not fallback",
    settings: s({
      pending_update_notification: pending,
      auto_update_attempts: { version: "0.0.1", count: 9 },
    }),
    managed: true,
    expected: "pending",
  },
  {
    name: "fallback needs an eligible install",
    settings: s({
      pending_update_notification: pending,
      auto_update_attempts: { version: "0.0.2", count: 5 },
    }),
    managed: false,
    expected: "pending",
  },
  {
    name: "dismissed version",
    settings: s({
      pending_update_notification: pending,
      dismissed_update_version: "0.0.2",
      auto_update_attempts: { version: "0.0.2", count: 5 },
    }),
    managed: true,
    expected: "dismissed",
  },
  {
    name: "dismissal of an older version does not apply",
    settings: s({
      pending_update_notification: pending,
      dismissed_update_version: "0.0.1",
    }),
    managed: true,
    expected: "pending",
  },
  {
    name: "snoozed prompt on a manual install",
    settings: s({
      auto_update: false,
      pending_update_notification: pending,
      update_prompt_snoozed_until: new Date(NOW + HOUR).toISOString(),
    }),
    managed: true,
    expected: "snoozed",
  },
  {
    name: "expired snooze",
    settings: s({
      auto_update: false,
      pending_update_notification: pending,
      update_prompt_snoozed_until: iso(HOUR),
    }),
    managed: true,
    expected: "pending",
  },
  {
    name: "applied for the pending version",
    settings: s({
      pending_update_notification: pending,
      auto_update_attempts: { version: "0.0.2", count: 5 },
      auto_update_applied: {
        from_version: "0.0.1",
        to_version: "0.0.2",
        at: iso(HOUR),
      },
    }),
    managed: true,
    expected: "applied",
  },
  {
    name: "applied marker for another version does not hide the pending one",
    settings: s({
      pending_update_notification: pending,
      auto_update_applied: {
        from_version: "0.0.0",
        to_version: "0.0.1",
        at: iso(HOUR),
      },
    }),
    managed: true,
    expected: "pending",
  },
  {
    name: "applied with nothing pending",
    settings: s({
      auto_update_applied: {
        from_version: "0.0.1",
        to_version: "0.0.2",
        at: iso(HOUR),
      },
    }),
    managed: true,
    expected: "applied",
  },
];

describe("updateState (#1660)", () => {
  for (const row of table) {
    test(row.name, () => {
      expect(
        updateState(row.settings, { managed: row.managed, now: NOW })
      ).toBe(row.expected);
    });
  }
});

describe("describeUpdate", () => {
  test("throttle stays true during fallback", () => {
    const settings = s({
      pending_update_notification: pending,
      auto_update_attempts: { version: "0.0.2", count: 3 },
      last_auto_update_attempt: iso(HOUR / 4),
    });
    expect(describeUpdate(settings, { managed: true, now: NOW })).toEqual({
      state: "fallback",
      throttled: true,
    });
  });
});

describe("primitives", () => {
  test("isVersionDismissed", () => {
    expect(isVersionDismissed({ dismissed_update_version: "1" }, "1")).toBe(
      true
    );
    expect(isVersionDismissed({ dismissed_update_version: "1" }, "2")).toBe(
      false
    );
    expect(isVersionDismissed({ dismissed_update_version: null }, "2")).toBe(
      false
    );
    expect(
      isVersionDismissed({ dismissed_update_version: "1" }, undefined)
    ).toBe(false);
  });
  test("isAttemptThrottled", () => {
    expect(
      isAttemptThrottled({ last_auto_update_attempt: undefined }, NOW)
    ).toBe(false);
    expect(
      isAttemptThrottled({ last_auto_update_attempt: iso(HOUR - 1) }, NOW)
    ).toBe(true);
    expect(
      isAttemptThrottled({ last_auto_update_attempt: iso(HOUR + 1) }, NOW)
    ).toBe(false);
  });
});
