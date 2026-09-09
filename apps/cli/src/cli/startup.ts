// Startup extras for a full CLI run: the foreground update, the telemetry
// notice, the background update check, install registration and log
// rotation. Loaded on demand by run() in ./index.ts so the light path
// (`--version`, `self install`, `mcp`, --offline, ...) never evaluates the
// updater/telemetry/banner graph: that graph alone put ~35 MB on the resident
// set of every invocation, which is what got `self install` OOM-killed on
// memory-capped machines (#2023). Keep this module free of command imports so
// it can never pull a subcommand chunk into the entry.

import type { ArgsDef, CommandDef } from "citty";

import { runMain } from "citty";

import type { UserSettings } from "@/self/types";

import { printAutoUpdateAppliedNotice } from "@/cli/banner";
import { registerInstall } from "@/self/register-install";
import { showTelemetryNotice } from "@/self/telemetry";
import {
  applyPendingUpdateInForeground,
  finishInlineAutoUpdate,
  foregroundUpdateTarget,
  runBackgroundUpdateCheck,
} from "@/self/updater";
import { rotateLogsIfNeeded } from "@/utils/log-rotation";

/**
 * Run `main` with every startup extra. `settings` is the snapshot run() took
 * before deciding to load this module; undefined when settings were unreadable.
 */
export function runWithStartupExtras<T extends ArgsDef>(
  main: CommandDef<T>,
  settings: UserSettings | undefined
): void {
  // An update a previous run already discovered is applied BEFORE the command,
  // and the original argv re-executed on the new binary, so a fresh run always
  // gets the newest version the CLI knows about (#170). The decision is
  // synchronous and settings-only: with nothing pending — the overwhelmingly
  // common case — this is a null check and no network.
  if (settings && foregroundUpdateTarget(settings)) {
    void applyPendingUpdateInForeground(settings)
      // Failure-safe: a broken update must never break the user's command.
      .catch(() => {})
      .then(() => startCommand(main, settings));
    return;
  }

  startCommand(main, settings);
}

function startCommand<T extends ArgsDef>(
  main: CommandDef<T>,
  settings: UserSettings | undefined
): void {
  // Non-blocking background tasks
  if (settings) showTelemetryNotice(settings);
  runBackgroundUpdateCheck(settings);
  registerInstall(settings);
  rotateLogsIfNeeded().catch(() => {}); // Best effort, silent fail

  // The one-time "✓ auto-updated" confirmation belongs to the RUN, not to any
  // one command: an update applied before `squirrel config` must be announced
  // by `squirrel config` (#170). Gated synchronously on the marker so the
  // ordinary run stays free of the await. printAutoUpdateAppliedNotice itself
  // only prints when this process IS the new version, and clears the marker.
  if (settings?.auto_update_applied) {
    void printAutoUpdateAppliedNotice(settings)
      .catch(() => {})
      .then(() => runCommand(main));
    return;
  }
  runCommand(main);
}

function runCommand<T extends ArgsDef>(main: CommandDef<T>): void {
  // After the command settles, bound any in-process (Windows) auto-update so
  // a still-downloading binary can't hold the CLI open indefinitely (#1074).
  void runMain(main).finally(() => void finishInlineAutoUpdate());
}
