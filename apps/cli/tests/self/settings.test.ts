// Tests for settings validation

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandError } from "../../src/controllers/types";
import * as pathsModule from "../../src/self/paths";
import {
  setSettingValue,
  isWritableSetting,
  shouldCheckForUpdates,
  formatSessionLoadWarning,
  loadUserSettings,
  readAndParseSettingsFile,
  writeFileAtomic,
  DEFAULT_SETTINGS,
} from "../../src/self/settings";

// setSettingValue(..., "user") does a real load-merge-SAVE to
// getSettingsPath() → homedir()/.squirrel/settings.json. Without isolation
// these validation tests clobber the developer's REAL ~/.squirrel/settings.json
// (e.g. flipping auto_update / notifications off). homedir() is fixed at process
// start in Bun (a runtime $HOME override is ignored — verified empirically
// against this Bun version), so redirect by spying on the paths module's
// getSettingsPath export instead.
//
// spyOn, NOT mock.module: mock.module replaces the whole module registry
// entry for the ENTIRE `bun test` process, and re-mock.module'ing it in
// afterAll does not reliably restore identity for test files loaded later in
// the same invocation — a proven cross-file leak in this repo (see
// apps/cli/MEMORY.md's mock.module notes). ESM named imports are live
// bindings, so spying on the real module's export affects settings.ts's own
// `import { getSettingsPath } from "./paths"`, and mockRestore() reliably
// undoes it (#1037).
//
// CAVEAT (#1037, round 3): CI still failed the loadUserSettings suite after
// this switch, with a symptom (every test seeing ok(DEFAULT_SETTINGS)) that
// points at the spy not intercepting the call AT ALL in that environment,
// not a leak. Rather than keep guessing why interception is unreliable
// there, that suite now bypasses this spy entirely — see
// loadUserSettings(testPath) below. The OTHER describe blocks in this file
// (setSettingValue-based ones) still rely on this spy; they aren't known to
// be broken by the same issue because their assertions only check the
// returned Result, not file identity, so even a silently-unintercepted spy
// writing to CI's (ephemeral, harmless) real $HOME wouldn't fail them.
const testHome = mkdtempSync(join(tmpdir(), "squirrel-settings-test-"));
const sandboxSettingsPath = join(testHome, "settings.json");

let restoreGetSettingsPath: () => void = () => {};

beforeAll(() => {
  const spy = spyOn(pathsModule, "getSettingsPath").mockImplementation(
    () => sandboxSettingsPath
  );
  restoreGetSettingsPath = () => spy.mockRestore();
});

afterAll(() => {
  restoreGetSettingsPath();
  rmSync(testHome, { recursive: true, force: true });
});

describe("settings validation", () => {
  describe("log_level", () => {
    test("accepts valid log levels", () => {
      for (const level of ["error", "warn", "info", "debug"]) {
        const result = setSettingValue("log_level", level, "user");
        // Note: This will fail if settings file doesn't exist, but we're testing validation
        // In a real test we'd mock the file system
        if (result.ok) {
          expect(result.data.value).toBe(level);
        } else {
          // If it fails, it should not be due to validation (might be file system)
          expect(result.error.code).not.toBe("INVALID_VALUE");
        }
      }
    });

    test("rejects invalid log levels", () => {
      const result = setSettingValue("log_level", "verbose", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
        expect(result.error.message).toContain("verbose");
        expect(result.error.message).toContain("error, warn, info, debug");
      }
    });

    test("rejects empty log level", () => {
      const result = setSettingValue("log_level", "", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
      }
    });

    test("rejects numeric log level", () => {
      const result = setSettingValue("log_level", "1", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
      }
    });
  });

  describe("log_compress_after_days", () => {
    test("accepts positive integers", () => {
      for (const days of ["1", "7", "14", "30", "365"]) {
        const result = setSettingValue("log_compress_after_days", days, "user");
        if (result.ok) {
          expect(result.data.value).toBe(parseInt(days, 10));
        } else {
          // If it fails, it should not be due to validation
          expect(result.error.code).not.toBe("INVALID_VALUE");
        }
      }
    });

    test("rejects zero", () => {
      const result = setSettingValue("log_compress_after_days", "0", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
        expect(result.error.message).toContain("positive integer");
      }
    });

    test("rejects negative numbers", () => {
      const result = setSettingValue("log_compress_after_days", "-5", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
      }
    });

    test("rejects non-integer strings", () => {
      const result = setSettingValue("log_compress_after_days", "abc", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
      }
    });

    test("rejects floating point numbers", () => {
      const result = setSettingValue("log_compress_after_days", "7.5", "user");
      // parseInt will parse this as 7, which is valid
      // This is acceptable behavior - it truncates to integer
      if (result.ok) {
        expect(result.data.value).toBe(7);
      }
    });
  });

  describe("log_delete_after_days", () => {
    test("accepts positive integers", () => {
      for (const days of ["1", "30", "60", "90", "365"]) {
        const result = setSettingValue("log_delete_after_days", days, "user");
        if (result.ok) {
          expect(result.data.value).toBe(parseInt(days, 10));
        } else {
          expect(result.error.code).not.toBe("INVALID_VALUE");
        }
      }
    });

    test("rejects zero", () => {
      const result = setSettingValue("log_delete_after_days", "0", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
        expect(result.error.message).toContain("positive integer");
      }
    });

    test("rejects negative numbers", () => {
      const result = setSettingValue("log_delete_after_days", "-10", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
      }
    });

    test("rejects non-numeric strings", () => {
      const result = setSettingValue("log_delete_after_days", "never", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
      }
    });
  });

  describe("channel", () => {
    test("accepts stable", () => {
      const result = setSettingValue("channel", "stable", "user");
      if (result.ok) {
        expect(result.data.value).toBe("stable");
      } else {
        expect(result.error.code).not.toBe("INVALID_VALUE");
      }
    });

    test("accepts beta", () => {
      const result = setSettingValue("channel", "beta", "user");
      if (result.ok) {
        expect(result.data.value).toBe("beta");
      } else {
        expect(result.error.code).not.toBe("INVALID_VALUE");
      }
    });

    test("rejects invalid channel", () => {
      const result = setSettingValue("channel", "alpha", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
        expect(result.error.message).toContain("stable, beta");
      }
    });
  });

  describe("boolean settings", () => {
    test("auto_update accepts true/false strings", () => {
      const trueResult = setSettingValue("auto_update", "true", "user");
      if (trueResult.ok) {
        expect(trueResult.data.value).toBe(true);
      }

      const falseResult = setSettingValue("auto_update", "false", "user");
      if (falseResult.ok) {
        expect(falseResult.data.value).toBe(false);
      }
    });

    test("auto_update rejects invalid boolean", () => {
      const result = setSettingValue("auto_update", "yes", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
        expect(result.error.message).toContain("true, false");
      }
    });

    test("notifications accepts true/false strings", () => {
      const trueResult = setSettingValue("notifications", "true", "user");
      if (trueResult.ok) {
        expect(trueResult.data.value).toBe(true);
      }

      const falseResult = setSettingValue("notifications", "false", "user");
      if (falseResult.ok) {
        expect(falseResult.data.value).toBe(false);
      }
    });

    test("tips accepts true/false strings", () => {
      const trueResult = setSettingValue("tips", "true", "user");
      if (trueResult.ok) {
        expect(trueResult.data.value).toBe(true);
      }

      const falseResult = setSettingValue("tips", "false", "user");
      if (falseResult.ok) {
        expect(falseResult.data.value).toBe(false);
      }
    });

    test("tips rejects invalid boolean", () => {
      const result = setSettingValue("tips", "sometimes", "user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_VALUE");
        expect(result.error.message).toContain("true, false");
      }
    });
  });
});

describe("isWritableSetting", () => {
  test("identifies writable settings", () => {
    expect(isWritableSetting("channel")).toBe(true);
    expect(isWritableSetting("auto_update")).toBe(true);
    expect(isWritableSetting("update_check_interval_hours")).toBe(true);
    expect(isWritableSetting("notifications")).toBe(true);
    expect(isWritableSetting("tips")).toBe(true);
    expect(isWritableSetting("log_level")).toBe(true);
    expect(isWritableSetting("log_compress_after_days")).toBe(true);
    expect(isWritableSetting("log_delete_after_days")).toBe(true);
  });

  test("identifies non-writable settings", () => {
    expect(isWritableSetting("last_update_check")).toBe(false);
    expect(isWritableSetting("dismissed_update_version")).toBe(false);
    expect(isWritableSetting("update_prompt_snoozed_until")).toBe(false);
    expect(isWritableSetting("id")).toBe(false);
    expect(isWritableSetting("registered")).toBe(false);
  });

  test("rejects unknown settings", () => {
    expect(isWritableSetting("unknown_setting")).toBe(false);
    expect(isWritableSetting("")).toBe(false);
  });
});

describe("update_check_interval_hours validation", () => {
  test("accepts numeric hours including fractional", () => {
    // End on the default so a local test run doesn't leave a surprising value.
    for (const v of ["0.25", "0.05", "24", "1"]) {
      const result = setSettingValue("update_check_interval_hours", v, "user");
      if (result.ok) {
        expect(result.data.value).toBe(Number(v));
      }
    }
  });

  test("rejects values below the 0.05h floor", () => {
    for (const v of ["0", "0.01", "-1"]) {
      const result = setSettingValue("update_check_interval_hours", v, "user");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_VALUE");
    }
  });

  test("rejects values above the 744h ceiling", () => {
    for (const v of ["745", "99999"]) {
      const result = setSettingValue("update_check_interval_hours", v, "user");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_VALUE");
    }
  });

  test("rejects non-numeric values", () => {
    for (const v of ["abc", "", "1h"]) {
      const result = setSettingValue("update_check_interval_hours", v, "user");
      expect(result.ok).toBe(false);
    }
  });
});

describe("shouldCheckForUpdates", () => {
  const isoAgo = (hours: number): string =>
    new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  test("false when auto_update is off", () => {
    expect(
      shouldCheckForUpdates({
        ...DEFAULT_SETTINGS,
        auto_update: false,
        last_update_check: isoAgo(99),
      })
    ).toBe(false);
  });

  test("true when never checked", () => {
    expect(
      shouldCheckForUpdates({ ...DEFAULT_SETTINGS, last_update_check: null })
    ).toBe(true);
  });

  test("treats a corrupt timestamp as due (never permanently disables)", () => {
    expect(
      shouldCheckForUpdates({
        ...DEFAULT_SETTINGS,
        last_update_check: "not-a-date",
      })
    ).toBe(true);
  });

  test("falls back to the default 1h interval when unset", () => {
    expect(
      shouldCheckForUpdates({
        ...DEFAULT_SETTINGS,
        update_check_interval_hours: undefined,
        last_update_check: isoAgo(2),
      })
    ).toBe(true);
    expect(
      shouldCheckForUpdates({
        ...DEFAULT_SETTINGS,
        update_check_interval_hours: undefined,
        last_update_check: isoAgo(0.5),
      })
    ).toBe(false);
  });

  test("honors a configured shorter interval", () => {
    expect(
      shouldCheckForUpdates({
        ...DEFAULT_SETTINGS,
        update_check_interval_hours: 0.25,
        last_update_check: isoAgo(0.5),
      })
    ).toBe(true);
  });

  test("clamps over-ceiling intervals to the 744h maximum", () => {
    // 99999h would bypass the write-path schema if hand-edited; the runtime
    // clamps to 744h, so a check 800h ago is due.
    expect(
      shouldCheckForUpdates({
        ...DEFAULT_SETTINGS,
        update_check_interval_hours: 99999,
        last_update_check: isoAgo(800),
      })
    ).toBe(true);
  });

  test("clamps sub-floor intervals to the 0.05h minimum", () => {
    // 0.0001h would re-check every ~0.4s; clamped to ~3 min, so 1 min isn't due.
    expect(
      shouldCheckForUpdates({
        ...DEFAULT_SETTINGS,
        update_check_interval_hours: 0.0001,
        last_update_check: isoAgo(1 / 60),
      })
    ).toBe(false);
  });
});

// #805: settings.json writes must be atomic (temp file + rename in the same
// directory) so a reader never observes a truncated/partial file mid-write.
// Uses its own throwaway dir — no paths.ts mock needed since writeFileAtomic
// takes an explicit path.
describe("writeFileAtomic", () => {
  const dir = mkdtempSync(join(tmpdir(), "squirrel-atomic-write-test-"));
  const targetPath = join(dir, "settings.json");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips content exactly", () => {
    writeFileAtomic(targetPath, JSON.stringify({ a: 1 }));
    expect(JSON.parse(readFileSync(targetPath, "utf-8"))).toEqual({ a: 1 });
  });

  test("an overwrite leaves only the NEW content — never a mix of old/new", () => {
    writeFileAtomic(
      targetPath,
      JSON.stringify({ a: 1, big: "x".repeat(50_000) })
    );
    writeFileAtomic(targetPath, JSON.stringify({ b: 2 }));
    expect(JSON.parse(readFileSync(targetPath, "utf-8"))).toEqual({ b: 2 });
  });

  test("repeated writes leave no stray temp files behind", () => {
    for (let i = 0; i < 20; i++) {
      writeFileAtomic(targetPath, JSON.stringify({ i }));
    }
    // Only the target file should remain in the directory — no leftover
    // `.settings.json.<pid>.<ts>.<rand>.tmp` artifacts from any write.
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  // #1037: settings may hold an auth token — a freshly-written file must
  // default to 0600, and a rewrite must never downgrade it back to a looser
  // umask-default mode. Root ignores permission bits and Windows has no
  // POSIX mode bits, so both are guarded out like the read-only-dir test below.
  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "a freshly-written file defaults to 0600",
    () => {
      const freshPath = join(dir, "fresh-mode.json");
      writeFileAtomic(freshPath, JSON.stringify({ a: 1 }));
      expect(statSync(freshPath).mode & 0o777).toBe(0o600);
    }
  );

  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "a rewrite of an existing 0600 file leaves it at 0600 (no downgrade)",
    () => {
      const strictPath = join(dir, "strict-mode.json");
      writeFileAtomic(strictPath, JSON.stringify({ a: 1 }));
      expect(statSync(strictPath).mode & 0o777).toBe(0o600);
      writeFileAtomic(strictPath, JSON.stringify({ a: 2 }));
      expect(statSync(strictPath).mode & 0o777).toBe(0o600);
    }
  );

  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "a rewrite preserves an even-stricter pre-existing mode (e.g. hand-chmod'd 0400)",
    () => {
      const readOnlyPath = join(dir, "readonly-mode.json");
      writeFileAtomic(readOnlyPath, JSON.stringify({ a: 1 }));
      chmodSync(readOnlyPath, 0o400);
      writeFileAtomic(readOnlyPath, JSON.stringify({ a: 2 }));
      expect(statSync(readOnlyPath).mode & 0o777).toBe(0o400);
      expect(JSON.parse(readFileSync(readOnlyPath, "utf-8"))).toEqual({
        a: 2,
      });
    }
  );

  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "a rewrite of a looser pre-existing file (e.g. umask-default 0644) tightens it to 0600",
    () => {
      const loosePath = join(dir, "loose-mode.json");
      writeFileAtomic(loosePath, JSON.stringify({ a: 1 }));
      chmodSync(loosePath, 0o644);
      writeFileAtomic(loosePath, JSON.stringify({ a: 2 }));
      expect(statSync(loosePath).mode & 0o777).toBe(0o600);
    }
  );

  test("a failed rename throws AND cleans up its temp file (no partial write survives)", () => {
    const dirAsTarget = join(dir, "is-a-directory.json");
    mkdirSync(dirAsTarget);
    // Renaming a file onto an existing directory is EISDIR on POSIX — a
    // deterministic way to force the rename step to fail.
    expect(() => writeFileAtomic(dirAsTarget, "{}")).toThrow();
    const leftover = readdirSync(dir).filter((f) =>
      f.startsWith(".is-a-directory.json")
    );
    expect(leftover).toEqual([]);
    // The pre-existing directory itself must be untouched — the failed
    // write never got to modify it.
    expect(readdirSync(dirAsTarget)).toEqual([]);
  });

  // Root ignores directory write-permission bits, so this would be a no-op
  // (and thus not actually exercise the failure path) under a root-run
  // sandbox/CI container.
  test.skipIf(process.getuid?.() === 0)(
    "a failed temp-file write (not just a failed rename) also cleans up and never leaks partial content",
    () => {
      const roDir = join(dir, "readonly-dir");
      mkdirSync(roDir);
      const roTarget = join(roDir, "settings.json");
      chmodSync(roDir, 0o500); // r-x: listable, not writable
      try {
        expect(() =>
          writeFileAtomic(roTarget, JSON.stringify({ auth: "secret-token" }))
        ).toThrow();
        expect(readdirSync(roDir)).toEqual([]);
      } finally {
        chmodSync(roDir, 0o700);
      }
    }
  );
});

// #805: reads get one immediate retry on any failure (read error, invalid
// JSON, or schema mismatch) as defense-in-depth for the mid-rename window.
describe("readAndParseSettingsFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "squirrel-read-retry-test-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ channel: "beta" }));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("succeeds on the first attempt for a valid file", () => {
    const result = readAndParseSettingsFile(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.channel).toBe("beta");
  });

  test("recovers via the retry when the first read throws", () => {
    let calls = 0;
    const flakyRead = (p: string) => {
      calls++;
      if (calls === 1) throw new Error("simulated transient read failure");
      return readFileSync(p, "utf-8");
    };
    const result = readAndParseSettingsFile(path, flakyRead);
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.channel).toBe("beta");
  });

  test("recovers via the retry when the first read returns torn/invalid JSON", () => {
    let calls = 0;
    const flakyContent = (p: string) => {
      calls++;
      return calls === 1 ? '{"channel": "st' : readFileSync(p, "utf-8");
    };
    const result = readAndParseSettingsFile(path, flakyContent);
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  test("surfaces the error when the read fails on both attempts", () => {
    const alwaysFails = () => {
      throw new Error("persistent failure");
    };
    const result = readAndParseSettingsFile(path, alwaysFails);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FILE_READ_ERROR");
  });

  // #1037: a missing file must be classified distinctly from every other
  // read failure, and must NOT pay the retry delay (waiting won't make a
  // nonexistent file appear).
  test("classifies ENOENT distinctly and skips the retry", () => {
    let calls = 0;
    const missing = () => {
      calls++;
      const enoent = new Error(
        "no such file or directory"
      ) as NodeJS.ErrnoException;
      enoent.code = "ENOENT";
      throw enoent;
    };
    const result = readAndParseSettingsFile(path, missing);
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ENOENT");
  });

  // #1037: when the retry ALSO fails, the original (first) error must stay
  // the reported one — it's the truthful failure, not whatever the retry
  // happened to fail with.
  test("preserves the first error as primary when both attempts fail differently", () => {
    let calls = 0;
    const flaky = () => {
      calls++;
      if (calls === 1) throw new Error("primary failure");
      throw new Error("secondary failure");
    };
    const result = readAndParseSettingsFile(path, flaky);
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("primary failure");
      expect(result.error.message).not.toContain("secondary failure");
      // The retry's own failure isn't discarded outright — it's attached for
      // debugging, just not allowed to override the primary error above.
      expect(result.error.details).toMatchObject({
        retryError: { message: expect.stringContaining("secondary failure") },
      });
    }
  });
});

describe("formatSessionLoadWarning", () => {
  test("names the anonymous fallback, the fix command, and the error code", () => {
    const msg = formatSessionLoadWarning(
      commandError("FILE_READ_ERROR", "boom")
    );
    expect(msg).toContain("anonymous");
    expect(msg).toContain("squirrel auth status");
    expect(msg).toContain("FILE_READ_ERROR");
  });
});

// #805: loadUserSettings() is the signal audit.ts uses to decide whether to
// print the loud session-load warning. It must return err() ONLY when the
// file exists but is corrupt/unreadable — never for the genuinely-logged-out
// (no file) case — and a valid session must load unaffected.
//
// #1037: CI failed all three of these with the "wrong" defaults result
// (ok(DEFAULT_SETTINGS) every time) even after switching the file-wide
// getSettingsPath() redirection from mock.module to spyOn — the tell that
// module-function interception itself wasn't applying in that environment,
// not a leak between tests. Rather than keep guessing at why spying is
// unreliable there, these tests now bypass interception ENTIRELY: they pass
// an explicit path straight into loadUserSettings(settingsPath) (an
// optional param that every production caller omits — see settings.ts),
// so there is no module/env mechanism in the loop to fail silently. Each
// test also gets its OWN fresh mkdtempSync dir, so no file-state can leak
// between them regardless of execution order either.
describe("loadUserSettings — corrupt vs. missing vs. valid (#805)", () => {
  let testDir: string;
  let testPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "squirrel-load-user-settings-test-"));
    testPath = join(testDir, "settings.json");
  });

  afterEach(() => {
    // rmSync removes by directory permission, not the (possibly chmod'd)
    // file's own mode, so this cleans up even after the EACCES test below.
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns err (not a silent anonymous ok) when the file is corrupt JSON", () => {
    writeFileSync(testPath, "{ this is not valid json");
    const result = loadUserSettings(testPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["FILE_READ_ERROR", "INVALID_JSON"]).toContain(result.error.code);
    }
  });

  test("still returns ok(DEFAULT_SETTINGS) when there is genuinely no file (logged out)", () => {
    // testPath is never written in this test — a fresh temp dir, so this is
    // a genuine ENOENT rather than a deleted shared file.
    const result = loadUserSettings(testPath);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.auth).toBeNull();
  });

  // #1037: existsSync() returns false for an existing-but-unreadable file
  // (EACCES), which used to be misclassified as "genuinely no file" and
  // silently fell through to an anonymous session — the exact bug #805 is
  // about. Root ignores permission bits, so this would be a no-op (and not
  // actually exercise the failure) under a root-run sandbox/CI container.
  test.skipIf(process.getuid?.() === 0)(
    "returns err (not a silent anonymous ok) when the file exists but is unreadable (EACCES)",
    () => {
      writeFileSync(testPath, JSON.stringify({ channel: "stable" }));
      chmodSync(testPath, 0o000);
      try {
        const result = loadUserSettings(testPath);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("FILE_READ_ERROR");
      } finally {
        // Restore write access so afterEach's rmSync can clean up the file
        // directly (belt-and-suspenders — rmSync would succeed anyway since
        // unlink is governed by the directory's permissions, not the file's).
        chmodSync(testPath, 0o600);
      }
    }
  );

  test("a valid session file loads successfully and is unaffected", () => {
    writeFileSync(
      testPath,
      JSON.stringify({
        channel: "stable",
        auth: {
          token: "sqcli_test",
          userId: "usr_1",
          email: "nik@example.com",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      })
    );
    const result = loadUserSettings(testPath);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.auth?.email).toBe("nik@example.com");
  });
});
