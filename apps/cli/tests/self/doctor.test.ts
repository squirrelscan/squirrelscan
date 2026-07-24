// Tests for doctor helpers

import { afterAll, describe, expect, test } from "bun:test";

import { formatHoursAgo } from "../../src/self/doctor";

describe("formatHoursAgo", () => {
  test("renders sub-hour ages in minutes (min 1m)", () => {
    expect(formatHoursAgo(0)).toBe("1m");
    expect(formatHoursAgo(0.5)).toBe("30m");
    expect(formatHoursAgo(0.99)).toBe("59m");
  });

  test("renders 1h–48h ages in hours", () => {
    expect(formatHoursAgo(1)).toBe("1h");
    expect(formatHoursAgo(5.4)).toBe("5h");
    expect(formatHoursAgo(47)).toBe("47h");
  });

  test("renders multi-day ages in days", () => {
    expect(formatHoursAgo(48)).toBe("2d");
    expect(formatHoursAgo(24 * 7)).toBe("7d");
  });
});

// #1092: a cwd local-settings walk failure (EACCES ancestor, surfaced since
// #1057) must degrade to a warn attributed to the cwd — NOT read as a corrupt
// ~/.squirrel/settings.json (destructive delete hint) or fail doctor.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UserSettings } from "../../src/self/types";

import { err, ok } from "../../src/controllers/types";
import { checkSettingsFile } from "../../src/self/doctor";

describe("checkSettingsFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-test-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, "{}");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const okUser = () => ok({ channel: "stable" } as UserSettings);
  const eacces = () =>
    err({
      code: "EACCES",
      message:
        "Failed to check for local settings at /x/.squirrel/settings.json: EACCES: permission denied",
    });

  test("local-walk EACCES → warn attributed to cwd, not corrupt-settings fail", () => {
    const check = checkSettingsFile({
      loadUser: okUser,
      findLocal: eacces,
      settingsPath,
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain("local settings unreadable");
    expect(check.message).not.toContain("corrupted");
    expect(check.fix).not.toContain("Delete");
  });

  test("clean walk → pass", () => {
    const check = checkSettingsFile({
      loadUser: okUser,
      findLocal: () => ok(null),
      settingsPath,
    });
    expect(check.status).toBe("pass");
  });

  // #1093: only malformed content (bad JSON / schema) is "corrupted" with the
  // destructive delete hint; a read/permission failure is a WARN without it.
  test("corrupt JSON → fail with delete hint", () => {
    const check = checkSettingsFile({
      loadUser: () => err({ code: "INVALID_JSON", message: "bad json" }),
      findLocal: () => ok(null),
      settingsPath,
    });
    expect(check.status).toBe("fail");
    expect(check.message).toContain("corrupted");
    expect(check.fix).toContain("Delete");
  });

  test("schema-invalid settings → fail with delete hint", () => {
    const check = checkSettingsFile({
      loadUser: () =>
        err({ code: "INVALID_SETTINGS", message: "channel must be ..." }),
      findLocal: () => ok(null),
      settingsPath,
    });
    expect(check.status).toBe("fail");
    expect(check.message).toContain("corrupted");
    expect(check.fix).toContain("Delete");
  });

  test("EACCES on the user settings file → permissions warn, no delete hint", () => {
    const check = checkSettingsFile({
      loadUser: () =>
        err({
          code: "FILE_READ_ERROR",
          message: "Failed to read settings: EACCES: permission denied",
        }),
      findLocal: () => ok(null),
      settingsPath,
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain("unreadable");
    expect(check.message).not.toContain("corrupted");
    expect(check.fix).not.toContain("Delete");
  });
});
