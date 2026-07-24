import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  type CommandError,
  type Result,
  ok,
  err,
  commandError,
} from "@/controllers/types";

import {
  getSettingsPath,
  findLocalSettingsPath,
  getLocalSettingsPath,
  getLocalSettingsDir,
} from "./paths";
import {
  type UserSettings,
  UserSettingsSchema,
  WRITABLE_SETTINGS,
  type WritableSetting,
  type SettingsScope,
  MIN_UPDATE_CHECK_INTERVAL_HOURS,
  MAX_UPDATE_CHECK_INTERVAL_HOURS,
} from "./types";

// Default cadence for the background update check, in hours. Overridable per
// install via the `update_check_interval_hours` setting (bounds in types.ts).
export const DEFAULT_UPDATE_CHECK_INTERVAL_HOURS = 1;

const DEFAULT_SETTINGS: UserSettings = {
  channel: "stable",
  last_update_check: null,
  auto_update: true,
  update_check_interval_hours: DEFAULT_UPDATE_CHECK_INTERVAL_HOURS,
  notifications: true,
  telemetry: true,
  tips: true,
  dismissed_update_version: null,
  update_prompt_snoozed_until: null,
  auto_update_disabled_reminder: null,
  log_level: "error",
  log_compress_after_days: 14,
  log_delete_after_days: 60,
  id: null,
  registered: false,
  telemetry_notice_shown: null,
  user_feedback_email: null,
  auth: null,
  cloud_render_consent: null,
  cloud_spend_ack: null,
  auto_publish_notice_shown: null,
};

// Check if a key is a writable setting
export function isWritableSetting(key: string): key is WritableSetting {
  return WRITABLE_SETTINGS.includes(key as WritableSetting);
}

// Delay before the single retry in readAndParseSettingsFile below. Long
// enough for a concurrent writeFileAtomic (a plain write + rename) to land,
// short enough to be invisible in normal CLI usage.
const READ_RETRY_DELAY_MS = 15;

/**
 * Write `content` to `path` atomically: write to a uniquely-named temp file
 * in the SAME directory, then rename it over the target. Same-filesystem
 * rename is a single atomic directory-entry swap (POSIX, and Windows via
 * MoveFileEx/REPLACE_EXISTING) — a concurrent reader can only ever observe
 * the fully-old or fully-new file, never a truncated/partial one (#805).
 *
 * Exported so the write path is directly testable without going through
 * getSettingsPath()/getLocalSettingsPath().
 */
export function writeFileAtomic(path: string, content: string): void {
  const dir = dirname(path);
  const tmpPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );

  // Settings can hold an auth token, so the temp file must never be
  // briefly group/world-readable, and a rewrite must never LOOSEN an
  // existing file's mode. Capture the pre-existing mode (if any) before
  // writing — it's used below to decide whether to preserve it (#1037).
  let existingMode: number | null = null;
  try {
    existingMode = statSync(path).mode & 0o777;
  } catch {
    // no pre-existing file (or it's unstatable) — the 0600 default applies
  }

  try {
    writeFileSync(tmpPath, content, { mode: 0o600 });
    renameSync(tmpPath, path);
    // Same-directory rename carries the temp file's mode (0600) onto the
    // target, so nothing further is needed for new files or files already
    // at 0600. Only re-chmod when the pre-existing file was even STRICTER
    // (e.g. hand-chmod'd 0400) — a looser historical mode (e.g. the old
    // umask-default 0644) is intentionally tightened to 0600, never restored.
    if (
      existingMode !== null &&
      existingMode !== 0o600 &&
      (existingMode & ~0o600) === 0
    ) {
      chmodSync(path, existingMode);
    }
  } catch (error) {
    // Best-effort cleanup — the original error below is what matters, not
    // whether we managed to remove the leftover temp file. Covers BOTH the
    // write (ENOSPC/EIO can leave a partial temp file, which may contain an
    // auth token — must not be left on disk) and the rename.
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw error;
  }
}

/**
 * Read + parse a settings file, retrying once (after READ_RETRY_DELAY_MS) on
 * ANY failure — read error, invalid JSON, or schema mismatch. writeFileAtomic
 * means a reader should never observe a torn file, but this is cheap
 * defense-in-depth for filesystems where same-directory rename isn't fully
 * atomic, or a reader lands in the narrow window of a non-atomic writer
 * elsewhere (#805).
 *
 * `readFile` is injectable so the retry path is directly testable without
 * mocking node:fs globally (which leaks across test files — see
 * apps/cli/MEMORY.md).
 */
export function readAndParseSettingsFile(
  path: string,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf-8")
): Result<Partial<UserSettings>> {
  const attempt = (): Result<Partial<UserSettings>> => {
    try {
      const content = readFile(path);
      return parseSettings(content, path);
    } catch (error) {
      // Preserve ENOENT as a distinct code so callers can tell "file
      // genuinely doesn't exist" apart from every other read failure
      // (permission denied, I/O error, etc.) — see loadUserSettings below,
      // which must treat ONLY the former as the silent logged-out case (#1037).
      const code =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "ENOENT"
          : "FILE_READ_ERROR";
      return err(
        commandError(
          code,
          `Failed to read settings: ${(error as Error).message}`
        )
      );
    }
  };

  const first = attempt();
  if (first.ok) return first;
  // A missing file won't materialize by waiting — skip the retry so the
  // (common) logged-out path isn't delayed for no reason.
  if (first.error.code === "ENOENT") return first;

  Bun.sleepSync(READ_RETRY_DELAY_MS);
  const second = attempt();
  if (second.ok) return second;

  // Both attempts failed — the FIRST error is the truthful one (the retry
  // exists only as defense-in-depth for the mid-rename torn-read window, not
  // because a later failure is more meaningful); note the retry's outcome
  // without letting it mask the original (#1037).
  return err(
    commandError(first.error.code, first.error.message, {
      retryError: second.error,
    })
  );
}

/**
 * Warning shown when a settings file EXISTS but failed to load (corrupt
 * JSON, unreadable, or fails schema validation) — as opposed to there simply
 * being no file (genuinely logged out, which must stay silent). Callers
 * derive the "file existed" condition from `!result.ok` on
 * loadUserSettings()/loadSettings(), which only ever return err() in that
 * case (a missing file short-circuits to `ok(DEFAULT_SETTINGS)`) (#805).
 */
export function formatSessionLoadWarning(error: CommandError): string {
  return (
    `Warning: session could not be loaded (${error.code}), running anonymous — ` +
    "run `squirrel auth status` to check your session."
  );
}

// Get the path for a settings scope
function getPathForScope(scope: SettingsScope): string {
  return scope === "user" ? getSettingsPath() : getLocalSettingsPath();
}

// Parse and validate settings JSON
function parseSettings(
  content: string,
  path: string
): Result<Partial<UserSettings>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return err(commandError("INVALID_JSON", `Failed to parse JSON in ${path}`));
  }

  // For partial settings (local), we don't require all fields
  // Just validate the fields that are present
  const result = UserSettingsSchema.partial().safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    return err(
      commandError(
        "INVALID_SETTINGS",
        `Invalid settings in ${path}:\n${issues}`
      )
    );
  }

  return ok(result.data as Partial<UserSettings>);
}

// Load settings from a specific scope only
export function loadSettingsFromScope(
  scope: SettingsScope
): Result<Partial<UserSettings>> {
  let path: string | null;
  if (scope === "user") {
    path = getSettingsPath();
  } else {
    const localResult = findLocalSettingsPath();
    if (!localResult.ok) return localResult;
    path = localResult.data;
  }
  if (!path) return ok({});

  // Attempt the read rather than existsSync-gating it first: existsSync
  // returns false for EACCES/inaccessible-parent too, which would
  // misclassify an existing-but-unreadable file as simply missing (#805/#1037).
  const result = readAndParseSettingsFile(path);
  if (!result.ok && result.error.code === "ENOENT") return ok({});
  return result;
}

// Load user settings only (with defaults). `settingsPath` defaults to the
// real getSettingsPath() — every production caller omits it, so behavior is
// unchanged. It exists as a test seam: CI found that spying on the paths
// module's getSettingsPath export (spyOn/mock.module) doesn't reliably
// intercept the call in every environment, so tests now pass an explicit
// path here instead of trying to redirect module resolution (#1037).
export function loadUserSettings(
  settingsPath: string = getSettingsPath()
): Result<UserSettings> {
  // No existsSync gate here on purpose (see loadSettingsFromScope above) —
  // only a genuinely missing file (ENOENT) should fall back to defaults.
  // Anything else (corrupt JSON, EACCES, ...) must surface as an error so
  // callers like audit.ts can warn loudly instead of running silently
  // anonymous (#805/#1037).
  const parseResult = readAndParseSettingsFile(settingsPath);
  if (!parseResult.ok) {
    if (parseResult.error.code === "ENOENT") {
      return ok({ ...DEFAULT_SETTINGS });
    }
    return parseResult;
  }

  return ok({ ...DEFAULT_SETTINGS, ...parseResult.data });
}

// Merged settings result with source tracking
export interface MergedSettings {
  effective: UserSettings;
  sources: Record<keyof UserSettings, SettingsScope>;
  userPath: string;
  localPath: string | null;
}

// Load merged settings (user + local override)
export function loadMergedSettings(): Result<MergedSettings> {
  const userPath = getSettingsPath();
  const localPathResult = findLocalSettingsPath();
  if (!localPathResult.ok) return localPathResult;
  const localPath = localPathResult.data;

  // Load user settings
  const userResult = loadUserSettings();
  if (!userResult.ok) return userResult;

  const userSettings = userResult.data;
  const sources: Record<string, SettingsScope> = {};

  // Initialize all sources as "user"
  for (const key of Object.keys(userSettings)) {
    sources[key] = "user";
  }

  // Load local settings if present — same ENOENT-only-fallback split as
  // loadUserSettings above (an existsSync gate here would silently skip an
  // existing-but-unreadable local override instead of surfacing it) (#1037).
  if (localPath) {
    const parseResult = readAndParseSettingsFile(localPath);
    if (!parseResult.ok) {
      if (parseResult.error.code !== "ENOENT") return parseResult;
    } else {
      const localSettings = parseResult.data;

      // Merge local settings on top, track sources
      for (const [key, value] of Object.entries(localSettings)) {
        if (value !== undefined) {
          (userSettings as Record<string, unknown>)[key] = value;
          sources[key] = "local";
        }
      }
    }
  }

  return ok({
    effective: userSettings,
    sources: sources as Record<keyof UserSettings, SettingsScope>,
    userPath,
    localPath,
  });
}

// Backwards compatible loadSettings (loads merged)
export function loadSettings(): Result<UserSettings> {
  const result = loadMergedSettings();
  if (!result.ok) return result;
  return ok(result.data.effective);
}

// Save settings to a specific scope
export function saveSettingsToScope(
  settings: Partial<UserSettings>,
  scope: SettingsScope
): Result<void> {
  const path = getPathForScope(scope);
  const dir = dirname(path);

  // For local scope, create .squirrel directory if needed
  if (scope === "local") {
    const localDir = getLocalSettingsDir();
    if (!existsSync(localDir)) {
      try {
        mkdirSync(localDir, { recursive: true });
      } catch (error) {
        return err(
          commandError(
            "FILE_WRITE_ERROR",
            `Failed to create .squirrel directory: ${(error as Error).message}`
          )
        );
      }
    }
  }

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileAtomic(path, JSON.stringify(settings, null, 2));
    return ok(undefined);
  } catch (error) {
    return err(
      commandError(
        "FILE_WRITE_ERROR",
        `Failed to save settings: ${(error as Error).message}`
      )
    );
  }
}

// Backwards compatible saveSettings (saves to user scope)
export function saveSettings(settings: UserSettings): Result<void> {
  return saveSettingsToScope(settings, "user");
}

// Parse a string value into the correct type for a setting
function parseSettingValue(
  key: WritableSetting,
  value: string
): Result<boolean | string | number> {
  switch (key) {
    case "channel":
      if (value !== "stable" && value !== "beta") {
        return err(
          commandError(
            "INVALID_VALUE",
            `Invalid value for 'channel': "${value}"\n  Valid options: stable, beta`
          )
        );
      }
      return ok(value);

    case "auto_update":
    case "notifications":
    case "telemetry":
    case "tips":
      if (value === "true") return ok(true);
      if (value === "false") return ok(false);
      return err(
        commandError(
          "INVALID_VALUE",
          `Invalid value for '${key}': "${value}"\n  Valid options: true, false`
        )
      );

    case "log_level":
      if (!["error", "warn", "info", "debug"].includes(value)) {
        return err(
          commandError(
            "INVALID_VALUE",
            `Invalid value for 'log_level': "${value}"\n  Valid options: error, warn, info, debug`
          )
        );
      }
      return ok(value);

    case "log_compress_after_days":
    case "log_delete_after_days": {
      const num = parseInt(value, 10);
      if (Number.isNaN(num) || num < 1) {
        return err(
          commandError(
            "INVALID_VALUE",
            `Invalid value for '${key}': "${value}"\n  Must be a positive integer (>= 1)`
          )
        );
      }
      return ok(num);
    }

    case "update_check_interval_hours": {
      const num = Number(value);
      if (
        !Number.isFinite(num) ||
        num < MIN_UPDATE_CHECK_INTERVAL_HOURS ||
        num > MAX_UPDATE_CHECK_INTERVAL_HOURS
      ) {
        return err(
          commandError(
            "INVALID_VALUE",
            `Invalid value for '${key}': "${value}"\n  Must be a number between ${MIN_UPDATE_CHECK_INTERVAL_HOURS} and ${MAX_UPDATE_CHECK_INTERVAL_HOURS} (hours)`
          )
        );
      }
      return ok(num);
    }

    default:
      return err(commandError("INVALID_KEY", `Unknown setting: ${key}`));
  }
}

// Set a single setting value
export function setSettingValue(
  key: string,
  value: string,
  scope: SettingsScope
): Result<{ key: string; value: unknown; scope: SettingsScope }> {
  // Check if the key is writable
  if (!isWritableSetting(key)) {
    if (
      [
        "last_update_check",
        "pending_update_notification",
        "dismissed_update_version",
        "update_prompt_snoozed_until",
      ].includes(key)
    ) {
      return err(
        commandError(
          "READ_ONLY_SETTING",
          `'${key}' is read-only\n  Writable settings: ${WRITABLE_SETTINGS.join(", ")}`
        )
      );
    }
    return err(
      commandError(
        "INVALID_KEY",
        `Unknown setting: '${key}'\n  Available settings: ${WRITABLE_SETTINGS.join(", ")}`
      )
    );
  }

  // Parse the value
  const parseResult = parseSettingValue(key, value);
  if (!parseResult.ok) return parseResult;

  const parsedValue = parseResult.data;

  // Load existing settings for this scope
  const existingResult = loadSettingsFromScope(scope);
  if (!existingResult.ok) return existingResult;

  const existing = existingResult.data;

  // Update and save
  const updated = { ...existing, [key]: parsedValue };
  const saveResult = saveSettingsToScope(updated, scope);
  if (!saveResult.ok) return saveResult;

  return ok({ key, value: parsedValue, scope });
}

// Backwards compatible updateSettings (updates user scope)
export function updateSettings(
  updates: Partial<UserSettings>
): Result<UserSettings> {
  const result = loadUserSettings();
  if (!result.ok) return result;

  const updated = { ...result.data, ...updates };
  const saveResult = saveSettings(updated);
  if (!saveResult.ok) return saveResult;

  return ok(updated);
}

export function shouldCheckForUpdates(settings: UserSettings): boolean {
  if (!settings.auto_update) return false;
  if (!settings.last_update_check) return true;

  // A corrupt timestamp would make hoursSinceCheck NaN, and `NaN >= interval`
  // is always false — permanently disabling checks. Treat it as due instead.
  const lastMs = Date.parse(settings.last_update_check);
  if (Number.isNaN(lastMs)) return true;

  const hoursSinceCheck = (Date.now() - lastMs) / (1000 * 60 * 60);

  // Clamp both ends so a value that bypassed the write-path schema (hand-edited
  // settings, in-memory construction) still behaves within sane bounds.
  const interval = Math.min(
    Math.max(
      settings.update_check_interval_hours ??
        DEFAULT_UPDATE_CHECK_INTERVAL_HOURS,
      MIN_UPDATE_CHECK_INTERVAL_HOURS
    ),
    MAX_UPDATE_CHECK_INTERVAL_HOURS
  );
  return hoursSinceCheck >= interval;
}

export { DEFAULT_SETTINGS, WRITABLE_SETTINGS };
