import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname } from "node:path";

import { AUTO_UPDATE_FALLBACK_THRESHOLD } from "@/constants";
import { type Result, ok, err, commandError } from "@/controllers/types";
import { logger } from "@/utils/logger";

import type { ReleaseManifest, UpdateResult, UserSettings } from "./types";

import { version } from "../../package.json";
import { updateSuppressedReason } from "./install-meta";
import {
  getReleasePath,
  getBinaryPath,
  getSymlinkPath,
  getUpdateLockPath,
  getUnmanagedUpdateHint,
  isValidReleaseVersion,
  isManagedInstall,
  detectPlatformArch,
} from "./paths";
import { checkForUpdates, downloadBinary } from "./releases";
import {
  loadSettings,
  updateSettings,
  shouldCheckForUpdates,
} from "./settings";
import { trackTelemetryEvent } from "./telemetry";

const BACKGROUND_CHECK_TIMEOUT_MS = 10000; // 10s max for background check
const AUTO_UPDATE_ATTEMPT_INTERVAL_HOURS = 1; // throttle background installs
// Grace given to a still-running in-process (Windows) auto-update after the
// command finishes: enough to let an almost-done download complete, short
// enough that the CLI never feels hung. Aborted attempts retry on a later
// run via the hourly throttle; long commands (audits) absorb the download.
const INLINE_UPDATE_EXIT_GRACE_MS = 10_000;
// Generous bound: a worst-case ~100MB download on a slow connection plus
// GitHub retries must finish well inside it, or a second updater could
// take over mid-install.
const UPDATE_LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * Whether this install can silently self-update: the user hasn't turned
 * auto_update off, and the running binary is the managed one (so flipping
 * the symlink actually takes effect).
 */
export function isAutoUpdateEligible(settings: UserSettings): boolean {
  return settings.auto_update && isManagedInstall();
}

/**
 * True when an eligible install's background auto-update has failed to land
 * the SAME pending version AUTO_UPDATE_FALLBACK_THRESHOLD+ times — the #1074
 * signature (a killed updater tells the user "handled in the background" on
 * every run while nothing ever installs). In this state the CLI drops the
 * reassuring one-liner for the loud "run: squirrel self update" box.
 *
 * Requires the counter's version to still match the pending notification and
 * the update never to have applied for that version.
 */
export function isAutoUpdateFallbackActive(settings: UserSettings): boolean {
  if (!isAutoUpdateEligible(settings)) return false;

  const notification = settings.pending_update_notification;
  if (!notification?.to_version) return false;
  if (settings.dismissed_update_version === notification.to_version)
    return false;

  const attempts = settings.auto_update_attempts;
  if (!attempts || attempts.version !== notification.to_version) return false;
  if (attempts.count < AUTO_UPDATE_FALLBACK_THRESHOLD) return false;

  // A successful install for this exact version clears the counter, but guard
  // anyway: never nag when the applied marker already matches the target.
  const applied = settings.auto_update_applied;
  if (applied && applied.to_version === notification.to_version) return false;

  return true;
}

/**
 * Single-instance guard for downloads/installs. A pid+timestamp lock file
 * under ~/.squirrel; locks past the staleness bound are treated as left
 * over from a crashed updater. Takeover is unlink-then-exclusive-create so
 * two waiters racing on the same stale lock can't both win, and release
 * only removes the lock this process owns.
 */
function acquireUpdateLock(): boolean {
  const lockPath = getUpdateLockPath();
  const payload = JSON.stringify({
    pid: process.pid,
    at: new Date().toISOString(),
  });

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // fall through — the write below will surface real problems
  }

  const tryExclusiveCreate = (): boolean => {
    try {
      writeFileSync(lockPath, payload, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };

  if (tryExclusiveCreate()) return true;

  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs > UPDATE_LOCK_STALE_MS) {
      // Remove the stale lock, then race for an exclusive re-create —
      // exactly one of the contenders gets the wx write.
      unlinkSync(lockPath);
      return tryExclusiveCreate();
    }
  } catch {
    // lock vanished or unreadable — treat as held to stay safe
  }
  return false;
}

function releaseUpdateLock(): void {
  const lockPath = getUpdateLockPath();
  try {
    // Only remove our own lock — after a stale takeover another process
    // may legitimately hold a newer one.
    const owner = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      pid?: number;
    };
    if (owner.pid !== process.pid) return;
    unlinkSync(lockPath);
  } catch {
    // already gone or unreadable — nothing safe to do
  }
}

/**
 * Run background update check on startup
 * Silent - catches all errors and doesn't interrupt CLI
 * Only checks for updates and stores notification - does not download
 */
export function runBackgroundUpdateCheck(settings?: UserSettings): void {
  // Fire-and-forget - don't return promise to avoid blocking process exit
  doBackgroundUpdateCheck(settings).catch(() => {});
}

async function doBackgroundUpdateCheck(
  parentSettings?: UserSettings
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    // Never touch the network (check) or spawn an installer in CI / opted-out
    // environments. Gated here so every background path is covered at once.
    const suppressed = updateSuppressedReason();
    if (suppressed) {
      logger.debug("update-check: suppressed", { reason: suppressed });
      return;
    }

    logger.debug("update-check: starting background check");

    const settingsResult = loadSettings();
    if (!settingsResult.ok) {
      logger.debug("update-check: failed to load settings");
      return;
    }

    const settings = settingsResult.data;
    // Use caller's settings for telemetry opt-out (avoids stale reads)
    const telemetrySettings = parentSettings ?? settings;

    // A previous run already found an update — install it now instead of
    // waiting for the next hourly check window.
    maybeSpawnAutoUpdate(settings);

    if (!shouldCheckForUpdates(settings)) {
      logger.debug("update-check: skipped, not due yet");
      return;
    }

    trackTelemetryEvent("update_check", telemetrySettings);

    // Race against timeout to prevent blocking process exit.
    // noRetry: use single fetch (requestOnceAsync) to avoid 3x retry + backoff
    // exceeding the 10s background timeout.
    const updateResult = await Promise.race([
      checkForUpdates(version, settings.channel, { noRetry: true }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("timeout")),
          BACKGROUND_CHECK_TIMEOUT_MS
        );
      }),
    ]);

    // Update timestamp after check completes (success or failure)
    const timestamp = new Date().toISOString();

    if (!updateResult.ok || !updateResult.data.available) {
      logger.debug("update-check: no update available");
      await updateSettings({ last_update_check: timestamp });
      return;
    }

    const { manifest } = updateResult.data;
    if (!manifest) {
      logger.debug("update-check: update available but no manifest");
      await updateSettings({ last_update_check: timestamp });
      return;
    }

    // Don't notify if this version was already dismissed
    if (settings.dismissed_update_version === manifest.version) {
      logger.debug("update-check: update dismissed by user");
      await updateSettings({ last_update_check: timestamp });
      return;
    }

    trackTelemetryEvent("update_available", telemetrySettings);
    logger.debug("update-check: update available", {
      version: manifest.version,
    });

    // Store pending notification and update timestamp
    const updated = await updateSettings({
      last_update_check: timestamp,
      pending_update_notification: {
        from_version: version,
        to_version: manifest.version,
        release_url: updateResult.data.release_url,
      },
    });

    // Kick off the silent install right away for eligible installs
    if (updated.ok) {
      maybeSpawnAutoUpdate(updated.data);
    }
  } catch (error) {
    trackTelemetryEvent("update_check_error", parentSettings);
    logger.debug("update-check: error during background check", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Still bump the timestamp so an unreachable/rate-limited GitHub isn't
    // re-hit on every single CLI run (2 API calls per check, 60/hr/IP limit).
    try {
      await updateSettings({ last_update_check: new Date().toISOString() });
    } catch {
      // best effort
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Kick off the silent update for an eligible install. POSIX spawns a
 * detached `squirrel self update --auto` child (new session — survives the
 * caller's exit). Windows runs the update IN THIS PROCESS: a detached child
 * never leaves the caller's Job Object there, and agent harnesses / CI
 * wrappers run CLIs in kill-on-close jobs that reaped the updater the
 * moment the tool call ended (#1074). finishInlineAutoUpdate() bounds the
 * exit delay. Throttled to one attempt per hour either way.
 *
 * Exported for tests.
 */
export function maybeSpawnAutoUpdate(settings: UserSettings): void {
  const notification = settings.pending_update_notification;
  if (!notification) return;

  // Skip reasons ride error_type so the per-platform funnel is diagnosable —
  // #1074 stayed invisible for a month precisely because skips and mid-flight
  // deaths produced zero telemetry. Deduped per process: this function runs
  // up to twice per CLI invocation (pending-notification fast path + post-
  // check), and once per run matches the update_notified cadence.
  const skip = (reason: string) => {
    logger.debug("update-check: auto-update skipped", { reason });
    if (emittedSkipReasons.has(reason)) return;
    emittedSkipReasons.add(reason);
    trackTelemetryEvent("update_auto_skipped", settings, {
      error_type: reason,
    });
  };

  // Silent: the background path already gates on this; CI runs would spam.
  if (updateSuppressedReason()) return;
  if (!isAutoUpdateEligible(settings)) {
    skip(settings.auto_update ? "unmanaged_install" : "auto_update_disabled");
    return;
  }
  if (settings.dismissed_update_version === notification.to_version) {
    skip("dismissed");
    return;
  }

  if (settings.last_auto_update_attempt) {
    const hoursSinceAttempt =
      (Date.now() - new Date(settings.last_auto_update_attempt).getTime()) /
      (1000 * 60 * 60);
    // Silent: fires on every run inside the window; the attempt it throttles
    // against was already reported.
    if (hoursSinceAttempt < AUTO_UPDATE_ATTEMPT_INTERVAL_HOURS) return;
  }

  // Record intent-to-attempt before dispatch — a crashing/killed updater must
  // not retry on every subsequent run. This is the THROTTLE only; it does not
  // touch the failed-attempt counter (see bumpAttemptCounter below).
  const recorded = updateSettings({
    last_auto_update_attempt: new Date().toISOString(),
  });
  if (!recorded.ok) {
    skip("settings_write_failed");
    return;
  }

  // Advance the per-version failed-attempt counter ONLY when an update
  // genuinely starts (#1085): an inline start deferred by commandSettled, or a
  // spawn that throws, never runs — counting it would trip the loud fallback
  // ("didn't complete on this system") for an attempt the updater never got to
  // make. Bumping at genuine start still counts #1074's killed-mid-update runs
  // (the updater started, then died). Increment for the same target, reset to 1
  // when the pending version changed; performUpdate clears it on success.
  const bumpAttemptCounter = () => {
    const prev = settings.auto_update_attempts;
    const count =
      prev && prev.version === notification.to_version ? prev.count + 1 : 1;
    updateSettings({
      auto_update_attempts: { version: notification.to_version, count },
    });
  };

  if (platform() === "win32") {
    if (startInlineAutoUpdate()) {
      bumpAttemptCounter();
      logger.debug("update-check: started inline auto-update", {
        to_version: notification.to_version,
      });
    }
    return;
  }

  try {
    const child = spawn(process.execPath, ["self", "update", "--auto"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    bumpAttemptCounter();
    logger.debug("update-check: spawned background auto-update", {
      to_version: notification.to_version,
    });
  } catch (error) {
    skip("spawn_failed");
    logger.debug("update-check: failed to spawn auto-update", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Single-flight state for the in-process (Windows) updater. The pending
// promise keeps the Bun event loop alive, so the CLI naturally waits for it —
// finishInlineAutoUpdate() bounds that wait at command end.
let inlineUpdate: {
  promise: Promise<void>;
  controller: AbortController;
} | null = null;
// Once the command has settled nothing bounds a NEW inline update, so late
// starts (background check finishing after a short command) must not begin —
// the pending notification is saved and the next run installs at command
// start, with the whole command duration to download.
let commandSettled = false;
// Per-process dedup for update_auto_skipped (see skip() above).
const emittedSkipReasons = new Set<string>();

/**
 * Reset module-level updater state between tests.
 * @internal
 */
export function resetUpdaterStateForTests(): void {
  inlineUpdate = null;
  commandSettled = false;
  emittedSkipReasons.clear();
}

/**
 * Exported for tests — production entry is maybeSpawnAutoUpdate.
 *
 * Returns whether the runner GENUINELY started this call — false when it was
 * deferred (command already settled) or a single-flight run is already in
 * flight. Callers use this to only advance the failed-attempt counter for an
 * update that actually began (#1085).
 * @internal
 */
export function startInlineAutoUpdate(
  runner: (signal: AbortSignal) => Promise<void> = (signal) =>
    runAutoUpdate({ signal })
): boolean {
  if (inlineUpdate) return false;
  if (commandSettled) {
    logger.debug("auto-update: command settled, deferring to next run");
    return false;
  }
  const controller = new AbortController();
  inlineUpdate = {
    controller,
    promise: runner(controller.signal).catch(() => {}),
  };
  return true;
}

/**
 * Bound process exit on a still-running in-process auto-update: give an
 * almost-finished download a short grace, then abort and wait for the
 * runner to settle (lock release, telemetry). No-op when nothing is running.
 * Called after the command finishes (cli/index.ts); hard process.exit()
 * paths skip it, which is safe — installs are atomic (tmp + rename) and the
 * attempt retries on a later run.
 */
export async function finishInlineAutoUpdate(
  graceMs = INLINE_UPDATE_EXIT_GRACE_MS
): Promise<void> {
  commandSettled = true;
  if (!inlineUpdate) return;
  const { promise, controller } = inlineUpdate;
  const timer = setTimeout(() => controller.abort(), graceMs);
  // The grace timer must never itself hold the process open.
  timer.unref?.();
  // Both the download AND the metadata check observe the abort now (the latter
  // via raceAbort in runAutoUpdate), so this wait is bounded by the grace — not
  // grace + a full request timeout (#1089).
  await promise;
  clearTimeout(timer);
  inlineUpdate = null;
}

/**
 * Exit the process after settling any in-flight inline (Windows) auto-update.
 * Command handlers that call process.exit() directly bypass
 * runMain(main).finally(finishInlineAutoUpdate) in cli/index.ts, which would
 * kill a mid-download inline updater — a rarer repro of #1074. Route those hard
 * exits through here so the update settles (or aborts within the grace) first,
 * then exits with the same code (#1089).
 */
export async function safeExit(code: number): Promise<never> {
  await finishInlineAutoUpdate();
  process.exit(code);
}

/** Sentinel returned by raceAbort when the signal fired before the promise settled. */
const ABORTED = Symbol("aborted");

/**
 * Resolve to ABORTED as soon as `signal` fires, without waiting for `promise`
 * to settle. Lets an un-cancellable await (the checkForUpdates metadata phase,
 * whose request tool owns its own AbortController) be cut short at command exit
 * so the settle wait stays bounded by the grace (#1089). The abandoned promise
 * keeps running until the process exits, which is exactly when this is used.
 * Rejections propagate unchanged so real errors still reach the caller's catch.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then((value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      })
      .catch((error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
  });
}

/**
 * Silent auto-update — the body of a detached `self update --auto` child
 * (POSIX) or the in-process runner (Windows). No console output — outcomes
 * surface via telemetry and the auto_update_applied notice on the next run.
 */
export async function runAutoUpdate(options?: {
  signal?: AbortSignal;
}): Promise<void> {
  const settingsResult = loadSettings();
  if (!settingsResult.ok) return;

  const settings = settingsResult.data;
  if (!isAutoUpdateEligible(settings)) return;
  // Belt-and-braces: the detached `self update --auto` child re-validates the
  // environment so a CI / opted-out machine never downloads or flips a binary,
  // even if it was somehow invoked directly.
  if (updateSuppressedReason()) return;

  // Before any slow work: a started-with-no-outcome install is one whose
  // updater was killed mid-flight — #1074's field signature, previously
  // indistinguishable from never-started.
  trackTelemetryEvent("update_auto_started", settings);

  if (!acquireUpdateLock()) {
    logger.debug("auto-update: another update is in progress");
    return;
  }

  try {
    // Inline (signal-bearing) runs skip the 3x retry so an abort at command
    // exit can't be held hostage by retry backoff; the detached child keeps
    // retries since nothing is waiting on it.
    const updateResult = await raceAbort(
      checkForUpdates(version, settings.channel, {
        noRetry: options?.signal !== undefined,
      }),
      options?.signal
    );
    if (updateResult === ABORTED) {
      logger.debug("auto-update: aborted during update check");
      return;
    }
    if (!updateResult.ok) {
      if (options?.signal?.aborted) {
        logger.debug("auto-update: aborted at command exit");
        return;
      }
      trackTelemetryEvent("update_auto_error", settings, {
        error_type: updateResult.error.code,
      });
      return;
    }

    if (!updateResult.data.available || !updateResult.data.manifest) {
      // The pending notification points at something no longer installable
      // (release pulled, or we already updated) — clear it so we stop
      // nagging and respawning.
      updateSettings({ pending_update_notification: undefined });
      return;
    }

    const manifest = updateResult.data.manifest;
    if (settings.dismissed_update_version === manifest.version) return;

    const applyResult = await performUpdate(manifest, settings, options);
    if (!applyResult.ok) {
      if (options?.signal?.aborted) {
        // Expected when the command finished before the download — not an
        // error; the attempt retries on a later run.
        logger.debug("auto-update: aborted at command exit");
        return;
      }
      trackTelemetryEvent("update_auto_error", settings, {
        error_type: applyResult.error.code,
      });
      logger.debug("auto-update: failed", { error: applyResult.error.message });
      return;
    }

    updateSettings({
      auto_update_applied: {
        from_version: version,
        to_version: manifest.version,
        at: new Date().toISOString(),
      },
    });
    trackTelemetryEvent("update_auto", settings);
    logger.debug("auto-update: installed", { version: manifest.version });
  } catch (error) {
    if (options?.signal?.aborted) {
      logger.debug("auto-update: aborted at command exit");
      return;
    }
    trackTelemetryEvent("update_auto_error", settings, {
      error_type: error instanceof Error ? error.name : "Error",
    });
    logger.debug("auto-update: error", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    releaseUpdateLock();
  }
}

/**
 * Download, verify, install, and flip the symlink for a release.
 * Shared by interactive and silent updates. Clears the pending
 * notification state on success.
 */
async function performUpdate(
  manifest: ReleaseManifest,
  settings: UserSettings,
  options?: { signal?: AbortSignal }
): Promise<Result<void>> {
  const platformArch = detectPlatformArch();
  const downloadResult = await downloadBinary(manifest, platformArch, {
    signal: options?.signal,
  });
  if (!downloadResult.ok) return downloadResult;

  const installResult = await installVersion(
    manifest.version,
    downloadResult.data
  );
  if (!installResult.ok) return installResult;

  const symlinkResult = updateSymlink(
    manifest.version,
    settings.install_bin_dir ?? undefined
  );
  if (!symlinkResult.ok) return symlinkResult;

  const saved = updateSettings({
    last_update_check: new Date().toISOString(),
    pending_update_notification: undefined,
    dismissed_update_version: null,
    update_prompt_snoozed_until: null,
    // The install landed — clear the failed-attempt counter so the loud
    // fallback box never shows for a version that actually updated (#1085).
    auto_update_attempts: null,
  });
  if (!saved.ok) return saved;

  return ok(undefined);
}

/**
 * Run interactive update with console output
 */
export async function runInteractiveUpdate(options?: {
  /** Update even when the running binary isn't the managed install */
  force?: boolean;
}): Promise<Result<UpdateResult>> {
  const settingsResult = loadSettings();
  if (!settingsResult.ok) return settingsResult;

  const settings = settingsResult.data;

  if (!isManagedInstall() && !options?.force) {
    return err(
      commandError(
        "UNMANAGED_INSTALL",
        `This squirrel binary isn't managed by 'self update' — update it with: ${getUnmanagedUpdateHint()}\n` +
          "(or re-run with --force to install the managed version alongside it)"
      )
    );
  }

  trackTelemetryEvent("update", settings);

  if (!acquireUpdateLock()) {
    return err(
      commandError(
        "UPDATE_IN_PROGRESS",
        "Another update is already in progress — try again in a minute"
      )
    );
  }

  try {
    console.log("Checking for updates...");

    const updateResult = await checkForUpdates(version, settings.channel);
    if (!updateResult.ok) return updateResult;

    if (!updateResult.data.available) {
      return ok({
        updated: false,
        from_version: version,
        to_version: null,
        release_url: null,
      });
    }

    const { manifest, release_url } = updateResult.data;
    if (!manifest) {
      return err(
        commandError("NO_MANIFEST", "Update available but no manifest found")
      );
    }

    console.log(`Downloading v${manifest.version}...`);
    console.log("Installing...");

    const applyResult = await performUpdate(manifest, settings);
    if (!applyResult.ok) return applyResult;

    return ok({
      updated: true,
      from_version: version,
      to_version: manifest.version,
      release_url,
    });
  } finally {
    releaseUpdateLock();
  }
}

/**
 * Check only - returns update info without installing
 */
export async function checkOnly(): Promise<
  Result<{
    available: boolean;
    current_version: string;
    latest_version: string | null;
    release_url: string | null;
  }>
> {
  const settingsResult = loadSettings();
  if (!settingsResult.ok) return settingsResult;

  const settings = settingsResult.data;

  // Update last check time
  await updateSettings({ last_update_check: new Date().toISOString() });

  const result = await checkForUpdates(version, settings.channel);
  if (!result.ok) return result;

  return ok({
    available: result.data.available,
    current_version: result.data.current_version,
    latest_version: result.data.latest_version,
    release_url: result.data.release_url,
  });
}

/**
 * Install a version to the releases directory
 */
export async function installVersion(
  version: string,
  binaryData: ArrayBuffer
): Promise<Result<void>> {
  let tmpPath: string | null = null;
  try {
    if (!isValidReleaseVersion(version)) {
      return err(commandError("INVALID_RELEASE", "Release version is invalid"));
    }
    const releasePath = getReleasePath(version);
    const binaryPath = getBinaryPath(version);

    // Write to a temp file and rename into place — a crash mid-write must
    // never leave a corrupt binary at the path the symlink will point to.
    tmpPath = `${binaryPath}.tmp-${process.pid}`;
    if (!existsSync(releasePath)) {
      mkdirSync(releasePath, { recursive: true });
    }

    writeFileSync(tmpPath, Buffer.from(binaryData));
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, binaryPath);

    return ok(undefined);
  } catch (error) {
    if (tmpPath) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // tmp never written or already cleaned up
      }
    }
    return err(
      commandError(
        "INSTALL_FAILED",
        `Failed to install: ${(error as Error).message}`
      )
    );
  }
}

/**
 * Update the symlink to point to a new version
 * Old versions are kept for potential rollback
 */
export function updateSymlink(
  version: string,
  customBinDir?: string
): Result<void> {
  const symlinkPath = getSymlinkPath(customBinDir);
  const symlinkDir = dirname(symlinkPath);

  try {
    if (!isValidReleaseVersion(version)) {
      return err(commandError("INVALID_RELEASE", "Release version is invalid"));
    }
    const binaryPath = getBinaryPath(version);
    if (!existsSync(symlinkDir)) {
      mkdirSync(symlinkDir, { recursive: true });
    }

    // Build the new link next to the old one and rename it into place —
    // unlink-then-create would leave the user with no `squirrel` on PATH
    // if the create fails (now likelier: this also runs unattended).
    const tmpLink = `${symlinkPath}.tmp-${process.pid}`;
    try {
      unlinkSync(tmpLink);
    } catch {
      // no stale tmp link
    }
    symlinkSync(binaryPath, tmpLink);
    try {
      renameSync(tmpLink, symlinkPath);
    } catch {
      // Some filesystems/Windows policies refuse rename-over-existing for
      // links — fall back to the old swap and clean up the tmp link.
      try {
        if (existsSync(symlinkPath)) unlinkSync(symlinkPath);
        symlinkSync(binaryPath, symlinkPath);
      } finally {
        try {
          unlinkSync(tmpLink);
        } catch {
          // already renamed or never created
        }
      }
    }

    return ok(undefined);
  } catch (error) {
    return err(
      commandError(
        "SYMLINK_FAILED",
        `Failed to update symlink: ${(error as Error).message}`
      )
    );
  }
}
