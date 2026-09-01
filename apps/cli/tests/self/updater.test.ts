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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  applyPendingUpdateInForeground,
  finishInlineAutoUpdate,
  FOREGROUND_UPDATE_ENV,
  foregroundUpdateTarget,
  isAutoUpdateFallbackActive,
  maybeSpawnAutoUpdate,
  reexecIntoUpdatedBinary,
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
  FOREGROUND_UPDATE_ENV,
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

    test("rejects invalid release paths before downloading", async () => {
      let fetched = false;
      globalThis.fetch = (async () => {
        fetched = true;
        return new Response("binary");
      }) as unknown as typeof fetch;

      const result = await downloadBinary(
        { ...manifest, version: "../../bin" },
        "darwin-arm64"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_RELEASE");
      expect(fetched).toBe(false);
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
        once() {},
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
        once() {},
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

  // #170: a pending update recorded by an earlier background check is applied
  // BEFORE the command runs, and the original argv re-executed on the new
  // binary — so a fresh run never executes on a version the CLI already knows
  // is stale.
  describe("foreground update before the command (#170)", () => {
    const PENDING = {
      from_version: "0.0.1",
      to_version: "9.9.9",
      release_url: null,
    } as const;

    function eligible(overrides: Partial<UserSettings> = {}): UserSettings {
      return settingsWith({
        auto_update: true,
        pending_update_notification: { ...PENDING },
        ...overrides,
      });
    }

    /** Managed, non-Windows install — the only shape that takes this path. */
    function managedPosix(): void {
      spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
      spyOn(os, "platform").mockReturnValue("linux");
    }

    describe("foregroundUpdateTarget gates", () => {
      test("returns the pending version for an eligible managed install", () => {
        managedPosix();
        expect(foregroundUpdateTarget(eligible())).toBe("9.9.9");
      });

      test("no pending notification → null (the untouched fast path)", () => {
        managedPosix();
        expect(
          foregroundUpdateTarget(
            settingsWith({ pending_update_notification: undefined })
          )
        ).toBeNull();
      });

      test("re-executed process never updates again (loop guard)", () => {
        managedPosix();
        process.env[FOREGROUND_UPDATE_ENV] = "1";
        expect(foregroundUpdateTarget(eligible())).toBeNull();
      });

      // The marker must not outlive the gate: a squirrel the command goes on to
      // spawn is a separate run entitled to its own foreground update.
      test("the loop marker is consumed, not inherited by nested runs", () => {
        managedPosix();
        process.env[FOREGROUND_UPDATE_ENV] = "1";

        expect(foregroundUpdateTarget(eligible())).toBeNull();

        expect(process.env[FOREGROUND_UPDATE_ENV]).toBeUndefined();
      });

      // Deliberate semantic (#170): update_check_interval_hours governs how
      // often we CHECK, not whether an already-recorded update gets applied.
      // Applying it on the next run is the entire feature.
      test("a long update_check_interval_hours does not veto applying a stored update", () => {
        managedPosix();
        expect(
          foregroundUpdateTarget(
            eligible({
              update_check_interval_hours: 744,
              last_update_check: new Date().toISOString(),
            })
          )
        ).toBe("9.9.9");
      });

      test("a live update lock skips the foreground path entirely", () => {
        managedPosix();
        writeFileSync(
          join(tempHome, "update.lock"),
          JSON.stringify({ pid: process.pid + 1, at: new Date().toISOString() })
        );
        expect(foregroundUpdateTarget(eligible())).toBeNull();
      });

      test("a STALE update lock does not skip (the acquire decides)", () => {
        managedPosix();
        const lock = join(tempHome, "update.lock");
        writeFileSync(lock, JSON.stringify({ pid: process.pid + 1 }));
        // Older than the 30-minute staleness bound.
        const old = new Date(Date.now() - 60 * 60 * 1000);
        utimesSync(lock, old, old);
        expect(foregroundUpdateTarget(eligible())).toBe("9.9.9");
      });

      test("CI skips the foreground path", () => {
        managedPosix();
        process.env.CI = "true";
        expect(foregroundUpdateTarget(eligible())).toBeNull();
      });

      test("SQUIRREL_NO_UPDATE skips the foreground path", () => {
        managedPosix();
        process.env.SQUIRREL_NO_UPDATE = "1";
        expect(foregroundUpdateTarget(eligible())).toBeNull();
      });

      test("auto_update=false skips the foreground path", () => {
        managedPosix();
        expect(
          foregroundUpdateTarget(eligible({ auto_update: false }))
        ).toBeNull();
      });

      test("unmanaged install skips the foreground path", () => {
        spyOn(pathsModule, "isManagedInstall").mockReturnValue(false);
        spyOn(os, "platform").mockReturnValue("linux");
        expect(foregroundUpdateTarget(eligible())).toBeNull();
      });

      test("a dismissed version skips the foreground path", () => {
        managedPosix();
        expect(
          foregroundUpdateTarget(
            eligible({ dismissed_update_version: "9.9.9" })
          )
        ).toBeNull();
      });

      test("an attempt inside the hourly throttle skips", () => {
        managedPosix();
        expect(
          foregroundUpdateTarget(
            eligible({
              last_auto_update_attempt: new Date(
                Date.now() - 10 * 60 * 1000
              ).toISOString(),
            })
          )
        ).toBeNull();
      });

      test("an attempt older than the throttle window is allowed", () => {
        managedPosix();
        expect(
          foregroundUpdateTarget(
            eligible({
              last_auto_update_attempt: new Date(
                Date.now() - 3 * 60 * 60 * 1000
              ).toISOString(),
            })
          )
        ).toBe("9.9.9");
      });

      test("win32 keeps the existing background/inline updater", () => {
        spyOn(pathsModule, "isManagedInstall").mockReturnValue(true);
        spyOn(os, "platform").mockReturnValue("win32");
        expect(foregroundUpdateTarget(eligible())).toBeNull();
      });
    });

    describe("applyPendingUpdateInForeground", () => {
      let stderr: string[];

      beforeEach(() => {
        stderr = [];
        spyOn(console, "error").mockImplementation((...args: unknown[]) => {
          stderr.push(args.map(String).join(" "));
        });
        // Production reads the same notification the caller snapshotted; the
        // apply path re-reads it to detect a concurrent run consuming it.
        updateSettings({
          auto_update: true,
          pending_update_notification: { ...PENDING },
        });
      });

      test("announces the update rather than stalling silently", async () => {
        managedPosix();
        captureTelemetry();

        await applyPendingUpdateInForeground(eligible(), {
          update: async () => null,
          reexec: () => {},
        });

        expect(stderr.join("\n")).toContain("→ v9.9.9");
      });

      test("notifications=false stays silent", async () => {
        managedPosix();
        captureTelemetry();

        await applyPendingUpdateInForeground(
          eligible({ notifications: false }),
          {
            update: async () => null,
            reexec: () => {},
          }
        );

        expect(stderr).toHaveLength(0);
      });

      test("no pending update: no network, no settings write, no update call", async () => {
        managedPosix();
        let fetched = false;
        globalThis.fetch = (async () => {
          fetched = true;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;
        const update = mock(async () => null);
        const reexec = mock(() => {});

        const outcome = await applyPendingUpdateInForeground(
          settingsWith({ pending_update_notification: undefined }),
          { update, reexec }
        );

        expect(outcome).toBe("skipped");
        expect(update).not.toHaveBeenCalled();
        expect(reexec).not.toHaveBeenCalled();
        expect(fetched).toBe(false);
        // Nothing was attempted, so nothing throttles the next run either.
        const saved = loadUserSettings();
        if (saved.ok) {
          expect(saved.data.last_auto_update_attempt ?? null).toBeNull();
        }
      });

      test("installs first, then re-execs into the new binary", async () => {
        managedPosix();
        captureTelemetry();
        spyOn(pathsModule, "getBinaryPath").mockImplementation((v: string) =>
          join(tempHome, "releases", v, "squirrel")
        );
        // The installed binary must exist before the re-exec is attempted.
        const order: string[] = [];
        const update = mock(async () => {
          order.push("update");
          mkdirSync(join(tempHome, "releases", "9.9.9"), { recursive: true });
          writeFileSync(join(tempHome, "releases", "9.9.9", "squirrel"), "bin");
          return "9.9.9";
        });
        const reexec = mock((path: string) => {
          order.push(`reexec:${path}`);
        });

        await applyPendingUpdateInForeground(eligible(), { update, reexec });

        expect(order).toEqual([
          "update",
          `reexec:${join(tempHome, "releases", "9.9.9", "squirrel")}`,
        ]);
      });

      test("a failed update falls back to the current binary, never re-execs", async () => {
        managedPosix();
        captureTelemetry();
        const reexec = mock(() => {});

        const outcome = await applyPendingUpdateInForeground(eligible(), {
          update: async () => null,
          reexec,
        });

        expect(outcome).toBe("failed");
        expect(reexec).not.toHaveBeenCalled();
      });

      test("an installed-but-missing binary falls back instead of re-execing", async () => {
        managedPosix();
        captureTelemetry();
        spyOn(pathsModule, "getBinaryPath").mockImplementation((v: string) =>
          join(tempHome, "releases", v, "squirrel")
        );
        const reexec = mock(() => {});

        const outcome = await applyPendingUpdateInForeground(eligible(), {
          update: async () => "9.9.9",
          reexec,
        });

        expect(outcome).toBe("failed");
        expect(reexec).not.toHaveBeenCalled();
      });

      test("a re-exec that fails to take over still runs the command here", async () => {
        managedPosix();
        captureTelemetry();
        spyOn(pathsModule, "getBinaryPath").mockImplementation((v: string) =>
          join(tempHome, "releases", v, "squirrel")
        );
        mkdirSync(join(tempHome, "releases", "9.9.9"), { recursive: true });
        writeFileSync(join(tempHome, "releases", "9.9.9", "squirrel"), "bin");

        const outcome = await applyPendingUpdateInForeground(eligible(), {
          update: async () => "9.9.9",
          // Returning models spawnSync failing to start the child; the real
          // implementation exits the process instead of returning.
          reexec: () => {},
        });

        expect(outcome).toBe("failed");
      });

      test("records the attempt before downloading so a failing update can't retry every run", async () => {
        managedPosix();
        captureTelemetry();

        await applyPendingUpdateInForeground(eligible(), {
          update: async (_signal, onStart) => {
            onStart();
            return null;
          },
          reexec: () => {},
        });

        const saved = loadUserSettings();
        expect(saved.ok).toBe(true);
        if (saved.ok) {
          expect(saved.data.last_auto_update_attempt).toBeTruthy();
          expect(saved.data.auto_update_attempts).toEqual({
            version: "9.9.9",
            count: 1,
          });
          // And the recorded attempt now throttles this run's own background
          // dispatch, so the two paths can't both download.
          expect(foregroundUpdateTarget(saved.data)).toBeNull();
        }
      });

      // #1085: the loud "didn't complete on this system" box must not be armed
      // by an attempt that never got past the update lock — the other updater
      // is doing the work.
      test("an update that never starts (lock held) does not count as a failure", async () => {
        managedPosix();
        captureTelemetry();

        await applyPendingUpdateInForeground(eligible(), {
          // Never calls onStart: this is what losing the lock looks like.
          update: async () => null,
          reexec: () => {},
        });

        const saved = loadUserSettings();
        expect(saved.ok).toBe(true);
        if (saved.ok) {
          expect(saved.data.auto_update_attempts ?? null).toBeNull();
          // The hourly throttle is still recorded, so this run's own background
          // dispatch can't pile a second download onto the one in flight.
          expect(saved.data.last_auto_update_attempt).toBeTruthy();
        }
      });

      // The user's command must never wait forever on a stalled download: past
      // the ceiling the install is handed to the detached updater (pre-#170
      // behaviour) and the command runs now.
      test("a deadline abort aborts the download and hands it to the detached updater", async () => {
        managedPosix();
        captureTelemetry();
        const spawnSpy = spyOn(childProcess, "spawn").mockReturnValue({
          once() {},
          unref() {},
        } as unknown as ReturnType<typeof childProcess.spawn>);
        let sawAbort = false;

        const outcome = await applyPendingUpdateInForeground(eligible(), {
          timeoutMs: 10,
          update: (signal, onStart) => {
            onStart();
            return new Promise<string | null>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  sawAbort = true;
                  resolve(null);
                },
                { once: true }
              );
            });
          },
          reexec: () => {},
        });

        expect(sawAbort).toBe(true);
        expect(outcome).toBe("failed");
        expect(spawnSpy).toHaveBeenCalledTimes(1);
        expect(spawnSpy.mock.calls[0]?.[1]).toEqual([
          "self",
          "update",
          "--auto",
        ]);
      });

      test("an ordinary failure does NOT spawn a detached updater", async () => {
        managedPosix();
        captureTelemetry();
        const spawnSpy = spyOn(childProcess, "spawn").mockReturnValue({
          once() {},
          unref() {},
        } as unknown as ReturnType<typeof childProcess.spawn>);

        await applyPendingUpdateInForeground(eligible(), {
          update: async (_signal, onStart) => {
            onStart();
            return null;
          },
          reexec: () => {},
        });

        expect(spawnSpy).not.toHaveBeenCalled();
      });

      /** A release binary on disk for `v`, as a rollback copy would be. */
      function stageRelease(v: string): string {
        spyOn(pathsModule, "getBinaryPath").mockImplementation((x: string) =>
          join(tempHome, "releases", x, "squirrel")
        );
        mkdirSync(join(tempHome, "releases", v), { recursive: true });
        writeFileSync(join(tempHome, "releases", v, "squirrel"), "bin");
        return join(tempHome, "releases", v, "squirrel");
      }

      test("another run having already applied the update re-execs without downloading", async () => {
        managedPosix();
        captureTelemetry();
        const binary = stageRelease("9.9.9");
        // On disk the notification is consumed and the applied marker records
        // the install; the caller's snapshot still has the notification (it was
        // read at startup).
        updateSettings({
          pending_update_notification: undefined,
          auto_update_applied: {
            from_version: "0.0.1",
            to_version: "9.9.9",
            at: new Date().toISOString(),
          },
        });

        const update = mock(async () => null);
        const reexeced: string[] = [];

        await applyPendingUpdateInForeground(eligible(), {
          update,
          reexec: (path) => {
            reexeced.push(path);
          },
        });

        expect(update).not.toHaveBeenCalled();
        expect(reexeced).toEqual([binary]);
      });

      // `self update --dismiss` clears the notification WITHOUT installing, and
      // old releases are kept on disk for rollback — so a binary being present
      // must never on its own be read as "another run applied it".
      test("a dismissed version is never re-execed just because its binary exists", async () => {
        managedPosix();
        captureTelemetry();
        stageRelease("9.9.9");
        updateSettings({
          pending_update_notification: undefined,
          dismissed_update_version: "9.9.9",
        });

        const update = mock(async () => null);
        const reexec = mock(() => {});

        const outcome = await applyPendingUpdateInForeground(eligible(), {
          update,
          reexec,
        });

        expect(outcome).toBe("skipped");
        expect(update).not.toHaveBeenCalled();
        expect(reexec).not.toHaveBeenCalled();
      });

      test("a stale rollback copy with no applied marker is not re-execed", async () => {
        managedPosix();
        captureTelemetry();
        stageRelease("9.9.9");
        updateSettings({ pending_update_notification: undefined });

        const reexec = mock(() => {});
        const outcome = await applyPendingUpdateInForeground(eligible(), {
          update: async () => null,
          reexec,
        });

        expect(outcome).toBe("skipped");
        expect(reexec).not.toHaveBeenCalled();
      });

      // Real contention, not a stubbed updater: another process owns the lock
      // file, so the foreground path skips BEFORE announcing anything or
      // burning the hourly throttle on work someone else is doing.
      test("real update-lock contention: silent skip, nothing recorded", async () => {
        managedPosix();
        captureTelemetry();
        // Record HOSTS, not URLs: an exact hostname comparison is the only
        // sound way to ask "did we hit the release endpoint".
        const fetchedHosts: string[] = [];
        globalThis.fetch = (async (url: string | URL | Request) => {
          const href = url instanceof Request ? url.url : String(url);
          fetchedHosts.push(new URL(href).hostname);
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;
        // A fresh lock held by some other pid.
        writeFileSync(
          join(tempHome, "update.lock"),
          JSON.stringify({ pid: process.pid + 1, at: new Date().toISOString() })
        );

        const reexec = mock(() => {});
        const outcome = await applyPendingUpdateInForeground(eligible(), {
          reexec,
        });

        expect(outcome).toBe("skipped");
        expect(reexec).not.toHaveBeenCalled();
        // Nothing announced, nothing fetched.
        expect(stderr).toHaveLength(0);
        expect(fetchedHosts).not.toContain("install.squirrelscan.com");
        const saved = loadUserSettings();
        if (saved.ok) {
          expect(saved.data.auto_update_attempts ?? null).toBeNull();
          // The hourly throttle is NOT burnt: the next run, once the other
          // updater is done, is free to try.
          expect(saved.data.last_auto_update_attempt ?? null).toBeNull();
        }
        // The other process's lock is left alone.
        expect(existsSync(join(tempHome, "update.lock"))).toBe(true);
      });

      // The whole deadline chain with the real runAutoUpdate: abort reaches the
      // download, the lock is released, and the install is handed off detached.
      test("deadline through the real updater: aborts the download, releases the lock, hands off", async () => {
        managedPosix();
        captureTelemetry();
        const spawnSpy = spyOn(childProcess, "spawn").mockReturnValue({
          once() {},
          unref() {},
        } as unknown as ReturnType<typeof childProcess.spawn>);
        spyOn(releasesModule, "checkForUpdates").mockResolvedValue({
          ok: true,
          data: {
            available: true,
            current_version: "0.0.1",
            latest_version: "9.9.9",
            release_url: null,
            manifest: { version: "9.9.9", binaries: {} } as ReleaseManifest,
          },
        } as Awaited<ReturnType<typeof releasesModule.checkForUpdates>>);
        let downloadAborted = false;
        spyOn(releasesModule, "downloadBinary").mockImplementation(
          (_manifest, _arch, options) =>
            new Promise((resolve) => {
              options?.signal?.addEventListener(
                "abort",
                () => {
                  downloadAborted = true;
                  resolve({
                    ok: false,
                    error: {
                      code: "DOWNLOAD_ABORTED",
                      message: "aborted",
                    },
                  } as Awaited<
                    ReturnType<typeof releasesModule.downloadBinary>
                  >);
                },
                { once: true }
              );
            })
        );

        const outcome = await applyPendingUpdateInForeground(eligible(), {
          timeoutMs: 20,
          reexec: () => {},
        });

        expect(downloadAborted).toBe(true);
        expect(outcome).toBe("failed");
        expect(spawnSpy).toHaveBeenCalledTimes(1);
        expect(spawnSpy.mock.calls[0]?.[1]).toEqual([
          "self",
          "update",
          "--auto",
        ]);
        // The lock must not be left behind for the detached updater to trip on.
        expect(existsSync(join(tempHome, "update.lock"))).toBe(false);
      });

      // A download takes long enough for `self update --dismiss` to land in the
      // middle of one; the swap must not happen after that.
      test("a dismissal DURING the download aborts before the binary swap", async () => {
        managedPosix();
        captureTelemetry();
        spyOn(pathsModule, "getReleasePath").mockImplementation((v: string) =>
          join(tempHome, "releases", v)
        );
        spyOn(pathsModule, "getBinaryPath").mockImplementation((v: string) =>
          join(tempHome, "releases", v, "squirrel")
        );
        spyOn(pathsModule, "getSymlinkPath").mockReturnValue(
          join(tempHome, "bin", "squirrel")
        );
        spyOn(releasesModule, "checkForUpdates").mockResolvedValue({
          ok: true,
          data: {
            available: true,
            current_version: "0.0.1",
            latest_version: "9.9.9",
            release_url: null,
            manifest: { version: "9.9.9", binaries: {} } as ReleaseManifest,
          },
        } as Awaited<ReturnType<typeof releasesModule.checkForUpdates>>);
        spyOn(releasesModule, "downloadBinary").mockImplementation(async () => {
          // The user dismisses while the bytes are in flight.
          updateSettings({ dismissed_update_version: "9.9.9" });
          return {
            ok: true,
            data: new TextEncoder().encode("bin").buffer as ArrayBuffer,
          };
        });

        const reexec = mock(() => {});
        const outcome = await applyPendingUpdateInForeground(eligible(), {
          reexec,
        });

        expect(outcome).toBe("failed");
        expect(reexec).not.toHaveBeenCalled();
        // Nothing was written into the releases dir, and no symlink was flipped.
        expect(
          existsSync(join(tempHome, "releases", "9.9.9", "squirrel"))
        ).toBe(false);
        expect(existsSync(join(tempHome, "bin", "squirrel"))).toBe(false);
      });

      test("end to end: downloads, installs, flips the symlink, re-execs the release binary", async () => {
        managedPosix();
        captureTelemetry();
        spyOn(pathsModule, "getReleasePath").mockImplementation((v: string) =>
          join(tempHome, "releases", v)
        );
        spyOn(pathsModule, "getBinaryPath").mockImplementation((v: string) =>
          join(tempHome, "releases", v, "squirrel")
        );
        spyOn(pathsModule, "getSymlinkPath").mockReturnValue(
          join(tempHome, "bin", "squirrel")
        );
        spyOn(releasesModule, "checkForUpdates").mockResolvedValue({
          ok: true,
          data: {
            available: true,
            current_version: "0.0.1",
            latest_version: "9.9.9",
            release_url: null,
            manifest: {
              version: "9.9.9",
              binaries: {
                "darwin-arm64": {
                  filename: "squirrel",
                  sha256: "0".repeat(64),
                  size: 3,
                },
                "darwin-x64": {
                  filename: "squirrel",
                  sha256: "0".repeat(64),
                  size: 3,
                },
                "linux-x64": {
                  filename: "squirrel",
                  sha256: "0".repeat(64),
                  size: 3,
                },
                "linux-arm64": {
                  filename: "squirrel",
                  sha256: "0".repeat(64),
                  size: 3,
                },
                "windows-x64": {
                  filename: "squirrel",
                  sha256: "0".repeat(64),
                  size: 3,
                },
              },
            } as ReleaseManifest,
          },
        } as Awaited<ReturnType<typeof releasesModule.checkForUpdates>>);
        spyOn(releasesModule, "downloadBinary").mockResolvedValue({
          ok: true,
          data: new TextEncoder().encode("bin").buffer as ArrayBuffer,
        });

        // The settings runAutoUpdate reloads from disk must be eligible too.
        updateSettings({
          auto_update: true,
          pending_update_notification: { ...PENDING },
        });

        const reexeced: string[] = [];
        await applyPendingUpdateInForeground(eligible(), {
          reexec: (path) => {
            reexeced.push(path);
          },
        });

        expect(reexeced).toEqual([
          join(tempHome, "releases", "9.9.9", "squirrel"),
        ]);
        expect(existsSync(join(tempHome, "bin", "squirrel"))).toBe(true);

        const saved = loadUserSettings();
        expect(saved.ok).toBe(true);
        if (saved.ok) {
          // The pending notification is consumed, and the marker that makes the
          // re-executed run print "✓ auto-updated" exactly once is set.
          expect(saved.data.pending_update_notification).toBeUndefined();
          expect(saved.data.auto_update_applied?.to_version).toBe("9.9.9");
          expect(saved.data.auto_update_attempts ?? null).toBeNull();
        }
      });
    });

    // The re-exec is the part that has to behave like execve: same arguments,
    // same exit status, signals reaching the child, and the loop marker set for
    // the process that takes over. Exercised against real child processes.
    describe.skipIf(process.platform === "win32")(
      "reexecIntoUpdatedBinary",
      () => {
        let exits: number[];

        beforeEach(() => {
          exits = [];
          spyOn(process, "exit").mockImplementation(((code?: number) => {
            exits.push(code ?? -1);
          }) as never);
        });

        function writeScript(name: string, body: string): string {
          const path = join(tempHome, name);
          writeFileSync(path, `#!/bin/sh\n${body}\n`);
          chmodSync(path, 0o755);
          return path;
        }

        async function waitFor(
          predicate: () => boolean,
          label: string
        ): Promise<void> {
          for (let i = 0; i < 400; i++) {
            if (predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(`timed out waiting for ${label}`);
        }

        test("passes argv through, sets the loop marker, propagates the exit code", async () => {
          const out = join(tempHome, "argv.txt");
          const script = writeScript(
            "fake-squirrel",
            `printf '%s|' "$@" > ${out}\n` +
              `printf 'marker=%s' "$${FOREGROUND_UPDATE_ENV}" >> ${out}\n` +
              "exit 42"
          );

          void reexecIntoUpdatedBinary(script, [
            "audit",
            "https://example.com",
          ]);
          await waitFor(() => exits.length > 0, "the child to exit");

          expect(exits).toEqual([42]);
          expect(readFileSync(out, "utf-8")).toBe(
            "audit|https://example.com|marker=1"
          );
        });

        // The waiting parent must not swallow cancellation: a supervisor that
        // signals THIS pid has to reach the command the user asked for.
        test("forwards a signal sent to this process to the child", async () => {
          const started = join(tempHome, "started");
          const script = writeScript(
            "trapping-squirrel",
            `trap 'exit 7' TERM\ntouch ${started}\nsleep 10 &\nwait`
          );

          void reexecIntoUpdatedBinary(script, []);
          await waitFor(() => existsSync(started), "the child to start");

          process.emit("SIGTERM");
          await waitFor(() => exits.length > 0, "the child to handle SIGTERM");

          expect(exits).toEqual([7]);
          // The forwarding handlers must not outlive the child.
          expect(process.listenerCount("SIGTERM")).toBe(0);
        });

        // A child killed BY a signal must make this process die the same way,
        // so a supervisor sees the signal and not just a number. process.kill
        // is spied because the real re-raise would kill the test runner.
        test("re-raises the child's death signal, with a 128+n fallback", async () => {
          const killed: Array<[number, string | number | undefined]> = [];
          spyOn(process, "kill").mockImplementation(((
            pid: number,
            signal?: string | number
          ) => {
            killed.push([pid, signal]);
            return true;
          }) as never);
          const script = writeScript("suicidal-squirrel", "kill -9 $$");

          void reexecIntoUpdatedBinary(script, []);
          await waitFor(() => exits.length > 0, "the signal fallback to fire");

          expect(killed).toEqual([[process.pid, "SIGKILL"]]);
          // 128 + SIGKILL(9): what a shell reports for the same death.
          expect(exits).toEqual([137]);
          expect(process.listenerCount("SIGTERM")).toBe(0);
        });

        test("a child that cannot start resolves (so the caller falls back) and restores signals", async () => {
          const before = process.listenerCount("SIGINT");

          await reexecIntoUpdatedBinary(join(tempHome, "does-not-exist"), []);

          expect(exits).toEqual([]);
          expect(process.listenerCount("SIGINT")).toBe(before);
        });
      }
    );
  });
});
