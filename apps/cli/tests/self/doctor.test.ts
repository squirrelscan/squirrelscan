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

// #293: `self update` flips the link recorded at install time and reported
// success on that alone, while the shell kept resolving an older binary
// somewhere else. Doctor has to lay the three paths side by side.
import { homedir } from "node:os";

import { checkInstallLocation } from "../../src/self/doctor";
import { getSymlinkPath } from "../../src/self/paths";

describe("checkInstallLocation (#293)", () => {
  const user = (binDir: string | null) => () =>
    ok({ channel: "stable", install_bin_dir: binDir } as UserSettings);

  test("PATH resolving the recorded link passes, and names version and paths", () => {
    const link = "/home/u/.local/bin/squirrel";
    const target = "/home/u/.squirrel/releases/0.0.92/squirrel";

    const check = checkInstallLocation({
      loadUser: user("/home/u/.local/bin"),
      which: () => link,
      realpath: (p) => (p === link ? target : p),
      exists: () => true,
      isWindows: false,
    });

    expect(check.status).toBe("pass");
    expect(check.message).toContain("install_bin_dir: /home/u/.local/bin");
    expect(check.message).toContain(`link ${link} -> v0.0.92`);
    expect(check.message).toContain(`PATH: ${link} -> v0.0.92`);
  });

  test("an unrecorded bin dir reports 'default', not an empty value", () => {
    const link = getSymlinkPath();
    const check = checkInstallLocation({
      loadUser: user(null),
      which: () => link,
      realpath: (p) => p,
      exists: () => true,
      isWindows: false,
    });

    expect(check.message).toContain("install_bin_dir: default");
    expect(check.status).toBe("pass");
  });

  test("the exact #293 shape: updates land in a scratch dir, PATH runs an old release", () => {
    const scratch = "/home/u/scratch/bin-beta";
    const onPath = "/home/u/.local/bin/squirrel";

    const check = checkInstallLocation({
      loadUser: user(scratch),
      which: () => onPath,
      realpath: (p) =>
        p === onPath ? "/home/u/.squirrel/releases/0.0.81/squirrel" : p,
      exists: () => true,
      isWindows: false,
    });

    expect(check.status).toBe("warn");
    expect(check.message).toContain(`install_bin_dir: ${scratch}`);
    expect(check.message).toContain(`link ${scratch}/squirrel`);
    expect(check.message).toContain(`PATH: ${onPath} -> v0.0.81`);
    expect(check.fix).toContain("--bin-dir /home/u/.local/bin");
  });

  test("nothing on PATH warns with the link's directory to add", () => {
    const check = checkInstallLocation({
      loadUser: user("/home/u/.local/bin"),
      which: () => null,
      realpath: (p) => p,
      exists: () => true,
      isWindows: false,
    });

    expect(check.status).toBe("warn");
    expect(check.message).toContain("no 'squirrel' found");
    expect(check.fix).toBe("Add /home/u/.local/bin to PATH");
  });

  // The link left behind by an update into a directory that has since been
  // deleted resolves to itself; printing the same path twice would read like
  // a healthy install.
  test("a dangling link is reported as missing, not as its own target", () => {
    const check = checkInstallLocation({
      loadUser: user("/home/u/scratch/bin-beta"),
      which: () => "/home/u/.local/bin/squirrel",
      realpath: (p) => p,
      exists: (p) => p === "/home/u/.local/bin/squirrel",
      isWindows: false,
    });

    expect(check.status).toBe("warn");
    expect(check.message).toContain(
      "link /home/u/scratch/bin-beta/squirrel -> /home/u/scratch/bin-beta/squirrel (missing)"
    );
  });

  // npm puts a wrapper on PATH, and it dispatches to the managed link. The
  // check must follow that, or every npm user reads as a mismatch.
  test("an npm wrapper dispatching to the managed link passes, and is labelled", () => {
    const managed = join(homedir(), ".local", "bin", "squirrel");
    const wrapper = "/usr/lib/node_modules/squirrelscan/bin/squirrel.js";

    const check = checkInstallLocation({
      loadUser: user(null),
      which: () => "/usr/bin/squirrel",
      realpath: (p) => (p === "/usr/bin/squirrel" ? wrapper : p),
      exists: (p) => p === managed,
      isWindows: false,
    });

    expect(check.status).toBe("pass");
    expect(check.message).toContain("PATH: /usr/bin/squirrel -> npm wrapper");
  });

  test("an npm wrapper stuck on the bundled binary warns with npm advice", () => {
    const wrapper = "/usr/lib/node_modules/squirrelscan/bin/squirrel.js";
    const bundled = "/usr/lib/node_modules/squirrelscan/bin/squirrel";

    const check = checkInstallLocation({
      loadUser: user("/home/u/scratch/bin-beta"),
      which: () => "/usr/bin/squirrel",
      realpath: (p) => (p === "/usr/bin/squirrel" ? wrapper : p),
      exists: (p) => p === bundled,
      isWindows: false,
    });

    expect(check.status).toBe("warn");
    expect(check.message).toContain("npm wrapper");
    expect(check.fix).toContain("npm install -g squirrelscan@latest");
    expect(check.fix).not.toContain("--bin-dir");
  });

  test("a recorded bin dir that can't be a link target warns instead of throwing", () => {
    const check = checkInstallLocation({
      loadUser: user("relative/bin"),
      which: () => null,
      realpath: (p) => p,
      isWindows: false,
    });

    expect(check.status).toBe("warn");
    expect(check.message).toContain("unusable");
  });
});
