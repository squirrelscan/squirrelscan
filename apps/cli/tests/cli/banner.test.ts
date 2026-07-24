// #1085: eligible-healthy vs eligible-broken update rendering, and the
// end-of-run fallback reminder.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import type { UserSettings } from "@/self/types";

import {
  printEndOfRunUpdateReminder,
  printUpdateNotification,
} from "@/cli/banner";
import * as pathsModule from "@/self/paths";
import { DEFAULT_SETTINGS } from "@/self/settings";
import * as telemetryModule from "@/self/telemetry";

function settingsWith(overrides: Partial<UserSettings>): UserSettings {
  return { ...DEFAULT_SETTINGS, ...overrides } as UserSettings;
}

/** Capture everything written to stderr, joined so per-line coloring is transparent. */
function captureStderr() {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }
  );
  return { spy, text: () => lines.join("\n") };
}

const pendingV2 = {
  from_version: "0.0.1",
  to_version: "0.0.2",
  release_url: null,
} as const;

describe("printUpdateNotification (#1085)", () => {
  let trackSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Managed so isAutoUpdateEligible is true (the interesting path); telemetry
    // is stubbed to a no-op spy so we can count update_notified without network.
    spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
    trackSpy = spyOn(telemetryModule, "trackTelemetryEvent").mockImplementation(
      () => {}
    );
  });

  afterEach(() => {
    mock.restore();
  });

  test("healthy eligible install shows the dim one-liner, not the box", () => {
    const out = captureStderr();
    printUpdateNotification(
      settingsWith({
        auto_update: true,
        pending_update_notification: pendingV2,
        auto_update_attempts: { version: "0.0.2", count: 1 },
      })
    );
    const text = out.text();
    expect(text).toContain("in the background");
    expect(text).not.toContain("Background update didn't complete");
    expect(text).not.toContain("Run: squirrel self update");
  });

  test("broken eligible install (>=2 failures) shows the loud fallback box", () => {
    const out = captureStderr();
    printUpdateNotification(
      settingsWith({
        auto_update: true,
        pending_update_notification: pendingV2,
        auto_update_attempts: { version: "0.0.2", count: 2 },
      })
    );
    const text = out.text();
    expect(text).toContain("Background update didn't complete on this system.");
    expect(text).toContain("Run: squirrel self update");
    expect(text).not.toContain("in the background");
  });

  test("fires update_notified exactly once for the fallback box", () => {
    const out = captureStderr();
    printUpdateNotification(
      settingsWith({
        auto_update: true,
        pending_update_notification: pendingV2,
        auto_update_attempts: { version: "0.0.2", count: 3 },
      })
    );
    out.spy.mockRestore();
    const notified = trackSpy.mock.calls.filter(
      (c: unknown[]) => c[0] === "update_notified"
    );
    expect(notified).toHaveLength(1);
  });
});

describe("printEndOfRunUpdateReminder (#1085)", () => {
  let trackSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
    trackSpy = spyOn(telemetryModule, "trackTelemetryEvent").mockImplementation(
      () => {}
    );
  });

  afterEach(() => {
    mock.restore();
  });

  test("prints a one-line reminder in fallback state, without telemetry", () => {
    const out = captureStderr();
    printEndOfRunUpdateReminder(
      settingsWith({
        auto_update: true,
        pending_update_notification: pendingV2,
        auto_update_attempts: { version: "0.0.2", count: 2 },
      })
    );
    out.spy.mockRestore();
    expect(out.text()).toContain("squirrel self update");
    // No duplicate update_notified — the start-of-run box already counted it.
    expect(trackSpy).not.toHaveBeenCalled();
  });

  test("no-op for a healthy eligible install (not in fallback)", () => {
    const out = captureStderr();
    printEndOfRunUpdateReminder(
      settingsWith({
        auto_update: true,
        pending_update_notification: pendingV2,
        auto_update_attempts: { version: "0.0.2", count: 1 },
      })
    );
    out.spy.mockRestore();
    expect(out.text()).toBe("");
  });

  test("no-op when notifications are disabled", () => {
    const out = captureStderr();
    printEndOfRunUpdateReminder(
      settingsWith({
        notifications: false,
        auto_update: true,
        pending_update_notification: pendingV2,
        auto_update_attempts: { version: "0.0.2", count: 5 },
      })
    );
    out.spy.mockRestore();
    expect(out.text()).toBe("");
  });
});
