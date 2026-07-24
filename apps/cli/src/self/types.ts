import { z } from "zod";

// Auth schema for CLI authentication state
export const AuthSchema = z
  .object({
    token: z.string(),
    userId: z.string(),
    email: z.string().email(),
    name: z.string().nullable().optional(),
    expiresAt: z.string(), // ISO date
  })
  .nullable();

export type AuthState = z.infer<typeof AuthSchema>;

// Background update-check cadence bounds (hours), the single source of truth
// for both the Zod schema below and the write-path validation in settings.ts.
// Floor keeps shared-IP runs under GitHub's 60/hr rate limit (2 calls/check);
// ceiling stops a huge value from silently disabling updates (use
// auto_update=false for that).
export const MIN_UPDATE_CHECK_INTERVAL_HOURS = 0.05; // 3 min
export const MAX_UPDATE_CHECK_INTERVAL_HOURS = 744; // 31 days

// Zod v4 schema for user settings
// User settings stored in ~/.squirrel/settings.json (user) and .squirrel/settings.json (local)
export const UserSettingsSchema = z.object({
  // Writable settings
  channel: z.enum(["stable", "beta"], {
    error: "channel must be 'stable' or 'beta'",
  }),
  auto_update: z.boolean({ error: "auto_update must be true or false" }),
  notifications: z.boolean({ error: "notifications must be true or false" }),
  telemetry: z.boolean({ error: "telemetry must be true or false" }),
  // Random tip shown under the audit preamble (stderr, interactive console
  // runs only — see cli/tips.ts for the full suppression rules).
  tips: z.boolean({ error: "tips must be true or false" }),
  // How often (hours) the background check may hit GitHub. Throttled per
  // interval regardless of how often the CLI runs, so a low value gives faster
  // hotfix pickup without hammering on every invocation. Bounds keep it under
  // GitHub's rate limit and stop a typo from silently disabling updates.
  update_check_interval_hours: z
    .number()
    .min(MIN_UPDATE_CHECK_INTERVAL_HOURS)
    .max(MAX_UPDATE_CHECK_INTERVAL_HOURS)
    .optional(),

  // Log settings
  log_level: z.enum(["error", "warn", "info", "debug"]).optional(),
  log_compress_after_days: z.number().min(1).optional(),
  log_delete_after_days: z.number().min(1).optional(),

  // Read-only settings (still validated)
  last_update_check: z.string().nullable(),
  pending_update_notification: z
    .object({
      from_version: z.string(),
      to_version: z.string(),
      release_url: z.string().nullable(),
    })
    .optional(),
  dismissed_update_version: z.string().nullable(),
  update_prompt_snoozed_until: z.string().nullable(),
  auto_update_disabled_reminder: z.string().nullable().optional(),
  // Set by the background auto-updater after a successful silent install;
  // the next run on the new binary prints a one-time notice and clears it.
  auto_update_applied: z
    .object({
      from_version: z.string(),
      to_version: z.string(),
      at: z.string(),
    })
    .nullable()
    .optional(),
  // Throttles background auto-install attempts (hourly), so a persistently
  // failing install doesn't spawn a download on every CLI run.
  last_auto_update_attempt: z.string().nullable().optional(),
  // Per-target-version failed-attempt counter for the background auto-updater.
  // maybeSpawnAutoUpdate increments it on each attempt; a successful install
  // (or a new pending version) resets it. Once it reaches the fallback
  // threshold for a version that never landed, the CLI stops reassuring the
  // user that the update is handled and shows the loud manual-update box
  // instead — the #1074 silent-failure escape hatch (#1085).
  auto_update_attempts: z
    .object({
      version: z.string(),
      count: z.number(),
    })
    .nullable()
    .optional(),
  // Custom --bin-dir recorded at install time so updates flip the symlink
  // the user actually has on PATH, not the default ~/.local/bin.
  install_bin_dir: z.string().nullable().optional(),

  // Install tracking
  id: z.string().nullable().optional(),
  registered: z.boolean().optional(),
  telemetry_notice_shown: z.boolean().nullable().optional(),
  user_feedback_email: z.string().email().nullable().optional(),

  // Authentication state
  auth: AuthSchema.optional(),

  // One-time consent for default cloud browser rendering (authed users).
  // null/undefined ⇒ never asked (prompt on the next auto-render opportunity);
  // "accepted" ⇒ render by default; "declined" ⇒ stay on plain HTTP. Explicit
  // `[cloud].rendering` config and the --render/--http flags bypass this.
  cloud_render_consent: z.enum(["accepted", "declined"]).nullable().optional(),

  // Set true once the user accepts the cloud-consent prompt that DISCLOSES the
  // estimated spend. Gates skipping the post-crawl prefetch confirm. Separate
  // from cloud_render_consent so a legacy "accepted" (render-only prompt, no
  // cost shown) still gets the spend prompt until the user has seen the cost.
  cloud_spend_ack: z.boolean().nullable().optional(),

  // One-time TTY notice that signed-in audits now auto-publish to the dashboard.
  // null/undefined ⇒ not shown yet; "true" once shown so we don't repeat it.
  auto_publish_notice_shown: z.boolean().nullable().optional(),

  // Per-tool BYOK credentials. Keys are tool ids (google-search, pangram,
  // dataforseo, gsc, google-indexing, bing-webmaster, github, analytics).
  // Values are either:
  //   - `{ _keychainRef: true }` — real secret lives in the OS keychain.
  //   - A plaintext credentials object (fallback when the keychain is
  //     unavailable, e.g. musl containers or CI without libsecret).
  // Missing key ⇒ tool silently excluded from the agent toolbox at runtime.
  tool_credentials: z
    .record(
      z.string(),
      z.union([
        z.object({ _keychainRef: z.literal(true) }),
        z.record(z.string(), z.string()),
      ])
    )
    .optional(),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;
export type ReleaseChannel = UserSettings["channel"];

// Writable settings keys
export const WRITABLE_SETTINGS = [
  "channel",
  "auto_update",
  "update_check_interval_hours",
  "notifications",
  "telemetry",
  "tips",
  "log_level",
  "log_compress_after_days",
  "log_delete_after_days",
] as const;

// Log level type for external use
export type LogLevel = "error" | "warn" | "info" | "debug";
export type WritableSetting = (typeof WRITABLE_SETTINGS)[number];

// Settings scope
export type SettingsScope = "user" | "local";

// Platform identifiers
export type Platform = "darwin" | "linux" | "win32";
export type Arch = "arm64" | "x64";
export type PlatformArch =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64"
  | "windows-x64";

// Manifest structure in each GitHub release
export interface ReleaseManifest {
  version: string;
  channel: ReleaseChannel;
  released_at: string;
  binaries: {
    [K in PlatformArch]?: {
      filename: string;
      sha256: string;
      size: number;
    };
  };
  release_notes_url: string;
}

// GitHub release info
export interface GitHubRelease {
  tag_name: string;
  name: string;
  prerelease: boolean;
  /** Drafts are invisible to install.sh and must never be update targets */
  draft: boolean;
  /** null for draft releases */
  published_at: string | null;
  assets: GitHubAsset[];
  html_url: string;
  body: string;
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

// Update check result
export interface UpdateCheckResult {
  available: boolean;
  current_version: string;
  latest_version: string | null;
  release_url: string | null;
  manifest: ReleaseManifest | null;
}

// Doctor check result
export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  passed: number;
  warnings: number;
  failed: number;
}

// Install result
export interface InstallResult {
  version: string;
  install_path: string;
  symlink_path: string;
  bin_in_path: boolean;
}

// Update result
export interface UpdateResult {
  updated: boolean;
  from_version: string;
  to_version: string | null;
  release_url: string | null;
}
