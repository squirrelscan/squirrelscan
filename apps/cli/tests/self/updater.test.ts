import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReleaseManifest, UserSettings } from "@/self/types";

import * as pathsModule from "@/self/paths";
import * as releasesModule from "@/self/releases";
import { downloadBinary } from "@/self/releases";
import {
  DEFAULT_SETTINGS,
  loadUserSettings,
  updateSettings,
} from "@/self/settings";
import {
  finishInlineAutoUpdate,
  isAutoUpdateFallbackActive,
  maybeSpawnAutoUpdate,
  resetUpdaterStateForTests,
  runAutoUpdate,
  safeExit,
  startInlineAutoUpdate,
} from "@/self/updater";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

const CI_VARS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "BUILDKITE",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "SQUIRREL_NO_UPDATE",
];

let tempHome: string;

function settingsWith(overrides: Partial<UserSettings>): UserSettings {
  return { ...DEFAULT_SETTINGS, ...overrides } as UserSettings;
}

/** Captures telemetry POST bodies sent through the stubbed global fetch. */
function captureTelemetry(): { events: Array<Record<string, unknown>> } {
  const captured: { events: Array<Record<string, unknown>> } = { events: [] };
  globalThis.fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit
  ) => {
    if (init?.body) {
      captured.events.push(
        JSON.parse(init.body as string) as Record<string, unknown>
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return captured;
}

function waitForTelemetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("updater", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "squirrelscan-updater-"));
    process.env = { ...originalEnv, HOME: tempHome };
    for (const v of CI_VARS) delete process.env[v];
    delete process.env.NO_TELEMETRY;
    resetUpdaterStateForTests();
    // CRITICAL: homedir() ignores $HOME, so the settings/lock path helpers
    // resolve to the developer's REAL ~/.squirrel (or a fake ~/AppData/Local/
    // squirrel under a mocked win32 platform()). Any test that lets the updater
    // WRITE settings would clobber real files — redirect the two write targets
    // into the temp home instead. (Read-only skip tests don't hit these.)
    spyOn(pathsModule, "getSettingsPath").mockReturnValue(
      join(tempHome, "settings.json")
    );
    spyOn(pathsModule, "getUpdateLockPath").mockReturnValue(
      join(tempHome, "update.lock")
    );
  });

  afterEach(async () => {
    // Drain any inline updater a test left behind before restoring globals.
    await finishInlineAutoUpdate(0);
    // Restore any spyOn (isManagedInstall, os.platform, child_process.spawn)
    // so later tests see the real implementations again.
    mock.restore();
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("inline auto-update lifecycle", () => {
    test("finishInlineAutoUpdate is a no-op when nothing started", async () => {
      await finishInlineAutoUpdate(0);
    });

    test("runner completing before the grace resolves without abort", async () => {
      let aborted = false;
      startInlineAutoUpdate(async (signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
      });
      await finishInlineAutoUpdate(1000);
      expect(aborted).toBe(false);
    });

    test("runner still going at grace expiry is aborted and awaited", async () => {
      let aborted = false;
      startInlineAutoUpdate(
        (signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            });
          })
      );
      await finishInlineAutoUpdate(10);
      expect(aborted).toBe(true);
    });

    test("second start is a no-op while one is in flight (single-flight)", async () => {
      let runs = 0;
      let release: (() => void) | undefined;
      startInlineAutoUpdate((signal) => {
        runs++;
        return new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener("abort", () => resolve());
        });
      });
      startInlineAutoUpdate(async () => {
        runs++;
      });
      expect(runs).toBe(1);
      release?.();
      await finishInlineAutoUpdate(10);
    });

    test("a rejecting runner never propagates", async () => {
      startInlineAutoUpdate(() => Promise.reject(new Error("boom")));
      await finishInlineAutoUpdate(10);
    });

    test("start after command settlement defers (never runs the runner)", async () => {
      await finishInlineAutoUpdate(0); // command settled, nothing in flight
      let ran = false;
      startInlineAutoUpdate(async () => {
        ran = true;
      });
      await finishInlineAutoUpdate(0);
      expect(ran).toBe(false);
    });
  });

  describe("maybeSpawnAutoUpdate skip telemetry", () => {
    test("no event without a pending notification", async () => {
      const captured = captureTelemetry();
      maybeSpawnAutoUpdate(settingsWith({}));
      await waitForTelemetry();
      expect(captured.events).toHaveLength(0);
    });

    test("auto_update=false reports update_auto_skipped:auto_update_disabled", async () => {
      const captured = captureTelemetry();
      maybeSpawnAutoUpdate(
        settingsWith({
          auto_update: false,
          pending_update_notification: {
            from_version: "0.0.1",
            to_version: "0.0.2",
            release_url: null,
          },
        })
      );
      await waitForTelemetry();
      const events = captured.events.filter(
        (e) => e.event === "update_auto_skipped"
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.error_type).toBe("auto_update_disabled");
    });

    test("unmanaged install (test binary) reports update_auto_skipped:unmanaged_install", async () => {
      const captured = captureTelemetry();
      // Under a temp HOME the test runner's execPath is never inside the
      // managed releases dir, so eligibility fails on the managed check.
      maybeSpawnAutoUpdate(
        settingsWith({
          auto_update: true,
          pending_update_notification: {
            from_version: "0.0.1",
            to_version: "0.0.2",
            release_url: null,
          },
        })
      );
      await waitForTelemetry();
      const events = captured.events.filter(
        (e) => e.event === "update_auto_skipped"
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.error_type).toBe("unmanaged_install");
    });

    test("same skip reason is emitted once per process", async () => {
      const captured = captureTelemetry();
      const settings = settingsWith({
        auto_update: false,
        pending_update_notification: {
          from_version: "0.0.1",
          to_version: "0.0.2",
          release_url: null,
        },
      });
      maybeSpawnAutoUpdate(settings);
      maybeSpawnAutoUpdate(settings);
      await waitForTelemetry();
      const events = captured.events.filter(
        (e) => e.event === "update_auto_skipped"
      );
      expect(events).toHaveLength(1);
    });

    test("suppressed environment (CI) stays silent", async () => {
      process.env.CI = "true";
      const captured = captureTelemetry();
      maybeSpawnAutoUpdate(
        settingsWith({
          auto_update: true,
          pending_update_notification: {
            from_version: "0.0.1",
            to_version: "0.0.2",
            release_url: null,
          },
        })
      );
      await waitForTelemetry();
      expect(captured.events).toHaveLength(0);
    });
  });

  describe("downloadBinary abort", () => {
    const manifest: ReleaseManifest = {
      version: "9.9.9",
      binaries: {
        "darwin-arm64": {
          filename: "squirrel",
          sha256: "0".repeat(64),
          size: 1,
        },
        "darwin-x64": { filename: "squirrel", sha256: "0".repeat(64), size: 1 },
        "linux-x64": { filename: "squirrel", sha256: "0".repeat(64), size: 1 },
        "linux-arm64": {
          filename: "squirrel",
          sha256: "0".repeat(64),
          size: 1,
        },
        "windows-x64": {
          filename: "squirrel",
          sha256: "0".repeat(64),
          size: 1,
        },
      },
    } as ReleaseManifest;

    test("caller abort surfaces as DOWNLOAD_ABORTED", async () => {
      globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })) as unknown as typeof fetch;

      const controller = new AbortController();
      const pending = downloadBinary(manifest, "darwin-arm64", {
        signal: controller.signal,
      });
      controller.abort();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("DOWNLOAD_ABORTED");
    });

    test("pre-aborted signal never downloads", async () => {
      let fetched = false;
      globalThis.fetch = ((
        _url: string | URL | Request,
        init?: RequestInit
      ) => {
        fetched = true;
        if (init?.signal?.aborted) {
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        return Promise.resolve(new Response("binary", { status: 200 }));
      }) as unknown as typeof fetch;

      const controller = new AbortController();
      controller.abort();
      const result = await downloadBinary(manifest, "darwin-arm64", {
        signal: controller.signal,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("DOWNLOAD_ABORTED");
      // fetch may or may not be reached depending on runtime abort timing —
      // the contract under test is the DOWNLOAD_ABORTED result, not the path.
      void fetched;
    });
  });

  // #1085: the per-target-version failed-attempt counter that drives the loud
  // fallback box. maybeSpawnAutoUpdate needs an eligible (managed) install; on
  // POSIX it also spawns a detached updater child, so both are stubbed and the
  // test only exercises the counter write, never a real install.
  describe("auto-update attempt counter (#1085)", () => {
    function eligibleWith(overrides: Partial<UserSettings>): UserSettings {
      return settingsWith({
        auto_update: true,
        pending_update_notification: {
          from_version: "0.0.1",
          to_version: "0.0.2",
          release_url: null,
        },
        ...overrides,
      });
    }

    function stubSpawn() {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      spyOn(childProcess, "spawn").mockReturnValue({
        unref() {},
      } as unknown as ReturnType<typeof childProcess.spawn>);
    }

    test("first attempt for a version records count 1", () => {
      stubSpawn();
      maybeSpawnAutoUpdate(eligibleWith({}));

      const saved = loadUserSettings();
      expect(saved.ok).toBe(true);
      if (saved.ok) {
        expect(saved.data.auto_update_attempts).toEqual({
          version: "0.0.2",
          count: 1,
        });
      }
    });

    test("repeat attempt for the same version increments the count", () => {
      stubSpawn();
      maybeSpawnAutoUpdate(
        eligibleWith({ auto_update_attempts: { version: "0.0.2", count: 1 } })
      );

      const saved = loadUserSettings();
      if (saved.ok) expect(saved.data.auto_update_attempts?.count).toBe(2);
    });

    test("a new pending version resets the count to 1", () => {
      stubSpawn();
      maybeSpawnAutoUpdate(
        eligibleWith({ auto_update_attempts: { version: "0.0.1", count: 5 } })
      );

      const saved = loadUserSettings();
      if (saved.ok) {
        expect(saved.data.auto_update_attempts).toEqual({
          version: "0.0.2",
          count: 1,
        });
      }
    });
  });

  // #1089 AC: cover both platform-routing branches of maybeSpawnAutoUpdate by
  // mocking node:os platform().
  describe("maybeSpawnAutoUpdate platform routing (#1089)", () => {
    function eligible(): UserSettings {
      return settingsWith({
        auto_update: true,
        pending_update_notification: {
          from_version: "0.0.1",
          to_version: "0.0.2",
          release_url: null,
        },
      });
    }

    test("win32 deferred (command settled) never spawns AND never advances the counter", async () => {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      spyOn(os, "platform").mockReturnValue("win32");
      const spawnSpy = spyOn(childProcess, "spawn");
      // Settle first so the inline start defers (commandSettled guard).
      await finishInlineAutoUpdate(0);

      maybeSpawnAutoUpdate(eligible());

      expect(spawnSpy).not.toHaveBeenCalled();
      const saved = loadUserSettings();
      expect(saved.ok).toBe(true);
      if (saved.ok) {
        // #1085: the failed-attempt counter must NOT advance for an attempt
        // that never ran — otherwise fast commands whose post-check finishes
        // after settle would trip the loud "didn't complete" box falsely.
        expect(saved.data.auto_update_attempts ?? null).toBeNull();
        // The throttle timestamp is still recorded regardless (unchanged).
        expect(saved.data.last_auto_update_attempt).toBeTruthy();
      }
    });

    test("win32 genuine inline start advances the counter", async () => {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      spyOn(os, "platform").mockReturnValue("win32");
      // Stub the network so the inline runner (runAutoUpdate) fails fast and
      // settles cleanly; the counter bump is synchronous before any of this.
      captureTelemetry();
      spyOn(releasesModule, "checkForUpdates").mockRejectedValue(
        new Error("no network in test")
      );
      // commandSettled is false (fresh beforeEach) → the inline start runs.
      maybeSpawnAutoUpdate(eligible());

      const saved = loadUserSettings();
      expect(saved.ok).toBe(true);
      if (saved.ok) {
        expect(saved.data.auto_update_attempts).toEqual({
          version: "0.0.2",
          count: 1,
        });
      }
      await finishInlineAutoUpdate(0);
    });

    test("non-win32 spawns a detached updater child and advances the counter", () => {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      spyOn(os, "platform").mockReturnValue("linux");
      const spawnSpy = spyOn(childProcess, "spawn").mockReturnValue({
        unref() {},
      } as unknown as ReturnType<typeof childProcess.spawn>);

      maybeSpawnAutoUpdate(eligible());

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const saved = loadUserSettings();
      if (saved.ok) {
        expect(saved.data.auto_update_attempts).toEqual({
          version: "0.0.2",
          count: 1,
        });
      }
    });
  });

  // #1085: the predicate the banner uses to switch from the reassuring
  // one-liner to the loud manual-update box.
  describe("isAutoUpdateFallbackActive (#1085)", () => {
    function fallbackSettings(
      overrides: Partial<UserSettings> = {}
    ): UserSettings {
      return settingsWith({
        auto_update: true,
        pending_update_notification: {
          from_version: "0.0.1",
          to_version: "0.0.2",
          release_url: null,
        },
        auto_update_attempts: { version: "0.0.2", count: 2 },
        ...overrides,
      });
    }

    test("true after threshold failures for the pending version (managed)", () => {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      expect(isAutoUpdateFallbackActive(fallbackSettings())).toBe(true);
    });

    test("false below the threshold", () => {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      expect(
        isAutoUpdateFallbackActive(
          fallbackSettings({
            auto_update_attempts: { version: "0.0.2", count: 1 },
          })
        )
      ).toBe(false);
    });

    test("false when the counter is for a different version", () => {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      expect(
        isAutoUpdateFallbackActive(
          fallbackSettings({
            auto_update_attempts: { version: "0.0.1", count: 9 },
          })
        )
      ).toBe(false);
    });

    test("false once the update has applied for that version", () => {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      expect(
        isAutoUpdateFallbackActive(
          fallbackSettings({
            auto_update_applied: {
              from_version: "0.0.1",
              to_version: "0.0.2",
              at: new Date().toISOString(),
            },
          })
        )
      ).toBe(false);
    });

    test("false for an unmanaged (ineligible) install", () => {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(false);
      expect(isAutoUpdateFallbackActive(fallbackSettings())).toBe(false);
    });

    test("false when the pending version was dismissed", () => {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      expect(
        isAutoUpdateFallbackActive(
          fallbackSettings({ dismissed_update_version: "0.0.2" })
        )
      ).toBe(false);
    });
  });

  // #1089: hard process.exit() call sites route through safeExit, which settles
  // the inline updater before exiting; and the exit-grace abort now reaches the
  // checkForUpdates metadata phase so the settle stays bounded by the grace.
  describe("safeExit + exit-grace abort (#1089)", () => {
    test("safeExit settles an in-flight inline update, then exits with the code", async () => {
      let ranToCompletion = false;
      // Runner resolves immediately, so finishInlineAutoUpdate returns without
      // waiting on the grace — we're testing routing, not timing.
      startInlineAutoUpdate(async () => {
        ranToCompletion = true;
      });

      const exitSpy = spyOn(process, "exit").mockImplementation(((
        code?: number
      ) => {
        throw new Error(`__exit__:${code}`);
      }) as never);

      await expect(safeExit(2)).rejects.toThrow("__exit__:2");
      expect(ranToCompletion).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    test("abort at command exit ends a hung metadata check within the grace", async () => {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      // Eligible install on disk (auto_update defaults true).
      updateSettings({ auto_update: true });
      // checkForUpdates never resolves — only the exit abort, via raceAbort,
      // can end runAutoUpdate's wait. Without that race this would hang until
      // the test timeout.
      spyOn(releasesModule, "checkForUpdates").mockReturnValue(
        new Promise(() => {}) as ReturnType<
          typeof releasesModule.checkForUpdates
        >
      );

      const controller = new AbortController();
      const start = Date.now();
      const run = runAutoUpdate({ signal: controller.signal });
      controller.abort();
      await run;

      expect(Date.now() - start).toBeLessThan(1000);
    });
  });
});
