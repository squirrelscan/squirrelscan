// CLI header for squirrelscan
//
// Output Strategy:
// - Banners, headers, and update notifications → stderr (console.error)
//   This keeps them visible to users while not polluting stdout for piped/redirected output
// - Actual command results (JSON, reports, etc.) → stdout (console.log)
//   This allows users to redirect/pipe output without noise from UI elements

import {
  lockedRulesMessage,
  type LockedRulesReportShape,
} from "@squirrelscan/report";
import gradient from "gradient-string";
import { createInterface } from "node:readline";
import pc from "picocolors";

import type { ReleaseChannel, UserSettings } from "@/self/types";

import {
  UPDATE_SNOOZE_HOURS,
  UPDATE_NOTIFICATION_MAX_WIDTH,
  AUTO_UPDATE_DISABLED_REMINDER_DAYS,
} from "@/constants";
import { getUnmanagedUpdateHint, isManagedInstall } from "@/self/paths";
import { trackTelemetryEvent } from "@/self/telemetry";
import {
  isAutoUpdateEligible,
  isAutoUpdateFallbackActive,
} from "@/self/updater";

import { version } from "../../package.json";

// Respect NO_COLOR environment variable (https://no-color.org/)
const useColor = !process.env.NO_COLOR;

// Big blocky "squirrelscan" text
const BANNER_ART = `
 ▄█▀ ▄▀█ █ █ █ █▀▄ █▀▄ █▀▀ █   ▄█▀ ▄▀▀ ▄▀█ █▄ █
 ▀▄  █ █ █ █ █ ██▀ ██▀ █▀  █   ▀▄  █   █▀█ █ ▀█
 █▄▀ ▀▀█ ▀▄▀ █ █ █ █ █ █▄▄ █▄▄ █▄▀ ▀▄▄ █ █ █  █
`;

// Autumn/squirrel-themed gradient (orange/brown tones)
// Pre-compute the gradient banner at module load to avoid runtime overhead
const squirrelGradient = gradient(["#CD853F", "#D2691E", "#8B4513", "#A0522D"]);
const GRADIENT_BANNER = useColor ? squirrelGradient(BANNER_ART) : BANNER_ART;

/**
 * Print the fancy colorful banner
 */
export function consoleBanner() {
  console.error(GRADIENT_BANNER);
}

export function printHeader(channel: ReleaseChannel = "stable") {
  consoleBanner();

  const channelSuffix =
    channel === "beta" ? (useColor ? pc.yellow(" (beta)") : " (beta)") : "";
  const versionText =
    (useColor ? pc.dim(`v${version}`) : `v${version}`) + channelSuffix;
  const urlText = useColor
    ? pc.cyan("https://squirrelscan.com")
    : "https://squirrelscan.com";

  console.error(`  ${versionText}  •  ${urlText}`);
  console.error(useColor ? pc.dim("─".repeat(44)) : "─".repeat(44));
}

/**
 * Render a bordered notification box from content lines, sized to the longest
 * line (capped at UPDATE_NOTIFICATION_MAX_WIDTH). Returns the lines to print
 * (blank line above/below included); the caller colorizes and emits them.
 */
function buildUpdateBox(lines: string[]): string[] {
  // +4 accounts for box borders: "│ " (2 chars) at start + " │" (2 chars) at end.
  const boxWidth = Math.min(
    UPDATE_NOTIFICATION_MAX_WIDTH,
    Math.max(...lines.map((l) => l.length)) + 4
  );
  const topBorder = "┌" + "─".repeat(boxWidth - 2) + "┐";
  const bottomBorder = "└" + "─".repeat(boxWidth - 2) + "┘";
  const padded = lines.map((l) => `│ ${l.padEnd(boxWidth - 3)}│`);
  return ["", topBorder, ...padded, bottomBorder, ""];
}

/**
 * Print update notification if available
 * Prints to stderr to avoid polluting stdout
 */
export function printUpdateNotification(settings: UserSettings) {
  // Check if notifications are enabled
  if (!settings.notifications) return;

  // Check if update notification exists
  const notification = settings.pending_update_notification;
  if (!notification) return;

  // Validate version strings
  if (!notification.from_version || !notification.to_version) return;

  // Check if this version was dismissed
  if (settings.dismissed_update_version === notification.to_version) return;

  // #1085: a background updater that keeps dying (Windows job teardown, #1074)
  // would otherwise reassure the user "handled in the background" forever. Once
  // it has failed the same version enough times, show the loud manual box with
  // one honest line instead — always the managed hint, since fallback requires
  // an eligible (managed) install.
  if (isAutoUpdateFallbackActive(settings)) {
    const box = buildUpdateBox([
      `Update available: v${notification.from_version} → v${notification.to_version}`,
      "Background update didn't complete on this system.",
      "Run: squirrel self update",
      "Dismiss: squirrel self update --dismiss",
    ]);
    const colorize = useColor ? pc.yellow : (s: string) => s;
    let displayed = false;
    try {
      for (const line of box) console.error(line ? colorize(line) : line);
      displayed = true;
    } catch {
      // Don't let notification display failure break the CLI
    }
    if (displayed) {
      trackTelemetryEvent("update_notified", settings);
    }
    return;
  }

  // Auto-updating installs don't need the nag box — the background
  // updater is already on it; just say so in one line.
  if (isAutoUpdateEligible(settings)) {
    const msg = `Updating squirrel to v${notification.to_version} in the background — takes effect on your next run.`;
    console.error(useColor ? pc.dim(msg) : msg);
    trackTelemetryEvent("update_notified", settings);
    return;
  }

  // Build notification box
  const updateLine = `Update available: v${notification.from_version} → v${notification.to_version}`;
  const updateCmd = isManagedInstall()
    ? "Run: squirrel self update"
    : `Update: ${getUnmanagedUpdateHint()}`;
  const dismissCmd = "Dismiss: squirrel self update --dismiss";

  const box = buildUpdateBox([updateLine, updateCmd, dismissCmd]);

  // Print to stderr with colors (if enabled)
  const colorize = useColor ? pc.yellow : (s: string) => s;
  let displayed = false;
  try {
    for (const line of box) console.error(line ? colorize(line) : line);
    displayed = true;
  } catch {
    // Don't let notification display failure break the CLI
  }

  if (displayed) {
    trackTelemetryEvent("update_notified", settings);
  }
}

/**
 * End-of-run reminder for the loud-fallback state (#1085): after a long audit,
 * the start-of-run update box has scrolled far out of view, and the user is
 * looking at the report footer. Reprint a one-line reminder on stderr so a
 * silently-failing background update (Windows #1074) can't stay invisible.
 *
 * No telemetry here — printUpdateNotification already fired `update_notified`
 * once for this run at the start; the reminder must not duplicate it.
 */
export function printEndOfRunUpdateReminder(settings: UserSettings): void {
  if (!settings.notifications) return;
  if (!isAutoUpdateFallbackActive(settings)) return;

  const notification = settings.pending_update_notification;
  if (!notification?.to_version) return;

  const msg = `Update to v${notification.to_version} didn't complete in the background — run: squirrel self update`;
  console.error(useColor ? pc.yellow(msg) : msg);
}

/**
 * One-time notice after a background auto-update has taken effect.
 * Prints only when this process is already running the new version,
 * then clears the marker.
 */
export async function printAutoUpdateAppliedNotice(
  settings: UserSettings
): Promise<void> {
  const applied = settings.auto_update_applied;
  if (!applied) return;

  // Still running the old binary (e.g. resolved before the symlink flip) —
  // keep the marker for the run that actually lands on the new version.
  if (applied.to_version !== version) return;

  if (settings.notifications) {
    const msg = `✓ squirrel auto-updated v${applied.from_version} → v${applied.to_version}`;
    console.error(useColor ? pc.green(msg) : msg);
  }

  const { updateSettings } = await import("@/self/settings");
  updateSettings({ auto_update_applied: null });
}

/**
 * Footer line for cloud-/Pro-gated rules that didn't run this audit (#780).
 * Audience logic (anonymous/free/paid, quick coverage, --http opt-out,
 * failed audit) is entirely owned by the shared `lockedRulesMessage` helper —
 * this only formats it for the terminal — so the CLI, HTML report, and
 * llm/markdown/text exports can never say something different for the same
 * report. `null` when there's nothing locked (no line should print).
 */
export function lockedRulesFooterLine(
  report: LockedRulesReportShape
): string | null {
  const locked = lockedRulesMessage(report);
  if (!locked) return null;
  const label = `🔒 ${locked.heading}:`;
  const cta = locked.cta ? ` ${locked.cta.label}: ${locked.cta.url}` : "";
  return useColor
    ? `${pc.dim(label)} ${locked.action}${cta}`
    : `${label} ${locked.action}${cta}`;
}

/**
 * Print footer with issue link and feedback command
 * Prints to stderr to avoid polluting stdout
 * @param extraLines pre-formatted lines printed above the issues/feedback line
 *   (e.g. the audit command's credits-used summary)
 */
export function printFooter(extraLines?: string[]) {
  const issueText = useColor
    ? pc.dim("File issues: ") +
      pc.cyan("https://github.com/squirrelscan/squirrelscan/issues")
    : "File issues: https://github.com/squirrelscan/squirrelscan/issues";
  const feedbackText = useColor
    ? pc.dim("Send feedback: ") + pc.cyan("squirrel feedback")
    : "Send feedback: squirrel feedback";

  console.error();
  console.error(useColor ? pc.dim("─".repeat(60)) : "─".repeat(60));
  for (const line of extraLines ?? []) {
    console.error(line);
  }
  console.error(`${issueText}  •  ${feedbackText}`);
  console.error();
}

/**
 * Print a reminder when auto-updates are disabled
 * Shows once every 7 days to avoid nagging
 */
export function shouldShowAutoUpdateDisabledReminder(
  settings: UserSettings
): boolean {
  if (settings.auto_update) return false;

  const lastReminder = settings.auto_update_disabled_reminder;
  if (lastReminder) {
    const daysSince =
      (Date.now() - new Date(lastReminder).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < AUTO_UPDATE_DISABLED_REMINDER_DAYS) return false;
  }

  return true;
}

export function printAutoUpdateDisabledReminder(): void {
  const msg =
    "Auto-updates disabled. Run 'squirrel self settings set auto_update true' to enable.";
  console.error(useColor ? pc.dim(msg) : msg);
  console.error();
}

/**
 * Prompt user to update immediately (if in interactive mode)
 * Only prompts if:
 * - Update notification exists
 * - Not snoozed
 * - Interactive mode (no --format or --output, or --format=console)
 */
export async function promptForUpdate(
  settings: UserSettings,
  args: { format?: string; output?: string }
): Promise<void> {
  // Check if update notification exists
  const notification = settings.pending_update_notification;
  if (!notification) return;

  // Check if this version was dismissed
  if (settings.dismissed_update_version === notification.to_version) return;

  // The background auto-updater handles eligible installs — never prompt
  // on top of an in-flight silent update. Unmanaged installs can't be
  // updated by `self update` either, so prompting would only offer a
  // command that errors; the notification box already shows the right one.
  if (isAutoUpdateEligible(settings) || !isManagedInstall()) return;

  // Check if in interactive mode (TTY + no output redirection)
  const isInteractive =
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    (!args.format || args.format === "console") &&
    !args.output;
  if (!isInteractive) return;

  // Check if snoozed
  if (settings.update_prompt_snoozed_until) {
    const snoozedUntil = new Date(settings.update_prompt_snoozed_until);
    if (snoozedUntil > new Date()) return; // Still snoozed
  }

  // Prompt user
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr, // Use stderr to not pollute stdout
  });

  // Add 30-second timeout to prevent indefinite hangs
  const answer = await Promise.race([
    new Promise<string>((resolve, reject) => {
      rl.question(
        useColor ? pc.yellow("Update now? [Y/n] ") : "Update now? [Y/n] ",
        resolve
      );
      rl.on("error", reject);
    }),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("Input timeout")), 30000)
    ),
  ]);
  rl.close();

  const response = answer.trim().toLowerCase();

  if (response === "" || response === "y" || response === "yes") {
    trackTelemetryEvent("update_prompt_accepted", settings);
    // User wants to update now
    console.error(); // Blank line before update output

    try {
      const { runInteractiveUpdate } = await import("@/self/updater");
      const result = await runInteractiveUpdate();

      if (result.ok && result.data.updated) {
        console.error(
          useColor
            ? pc.green(`\n✓ Updated to v${result.data.to_version}`)
            : `\n✓ Updated to v${result.data.to_version}`
        );
        if (result.data.release_url) {
          console.error(`See release notes: ${result.data.release_url}`);
        }
      } else if (result.ok) {
        // The earlier notification referenced a version that's no longer
        // installable (e.g. release pulled or still draft). Say so instead
        // of silently doing nothing, and clear the stale prompt.
        console.error(
          `\nNo installable update found — staying on v${result.data.from_version}.`
        );
        const { updateSettings } = await import("@/self/settings");
        await updateSettings({
          pending_update_notification: undefined,
        });
      } else {
        console.error(
          useColor
            ? pc.red(`\n✗ Update failed: ${result.error.message}`)
            : `\n✗ Update failed: ${result.error.message}`
        );
      }
    } catch (error) {
      console.error(
        useColor
          ? pc.red(`\n✗ Update failed: ${(error as Error).message}`)
          : `\n✗ Update failed: ${(error as Error).message}`
      );
    }

    console.error(); // Blank line after update output
  } else {
    trackTelemetryEvent("update_prompt_declined", settings);
    // User declined - snooze
    const { updateSettings } = await import("@/self/settings");
    const snoozeUntil = new Date();
    snoozeUntil.setHours(snoozeUntil.getHours() + UPDATE_SNOOZE_HOURS);

    await updateSettings({
      update_prompt_snoozed_until: snoozeUntil.toISOString(),
    });

    console.error(
      useColor
        ? pc.dim(`Update snoozed for ${UPDATE_SNOOZE_HOURS} hours`)
        : `Update snoozed for ${UPDATE_SNOOZE_HOURS} hours`
    );
    console.error(); // Blank line
  }
}
