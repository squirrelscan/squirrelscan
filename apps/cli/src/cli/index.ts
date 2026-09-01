// SquirrelScan CLI main entry

import { defineCommand, runMain } from "citty";

import type { UserSettings } from "@/self/types";

import { printAutoUpdateAppliedNotice } from "@/cli/banner";
import { setGlobalConfigPath } from "@/config";
import { registerInstall } from "@/self/register-install";
import { loadSettings } from "@/self/settings";
import { showTelemetryNotice } from "@/self/telemetry";
import {
  applyPendingUpdateInForeground,
  finishInlineAutoUpdate,
  foregroundUpdateTarget,
  runBackgroundUpdateCheck,
} from "@/self/updater";
import { rotateLogsIfNeeded } from "@/utils/log-rotation";
import { setLogLevel } from "@/utils/logger";

import { version } from "../../package.json";
import { analyze } from "./commands/analyze";
import { audit } from "./commands/audit";
import { auth } from "./commands/auth";
import { config } from "./commands/config";
import { crawl } from "./commands/crawl";
import { credits } from "./commands/credits";
import { feedback } from "./commands/feedback";
import { init } from "./commands/init";
import { keys } from "./commands/keys";
import { mcp } from "./commands/mcp";
import { report } from "./commands/report";
import { self } from "./commands/self";
import { skills } from "./commands/skills";

const main = defineCommand({
  meta: {
    name: "squirrel",
    version,
    description: "The website QA tool for your coding agent",
  },
  args: {
    "config-file": {
      type: "string",
      alias: "c",
      description: "Path to config file",
    },
  },
  setup({ args }) {
    setGlobalConfigPath(args["config-file"]);
  },
  subCommands: {
    audit,
    auth,
    crawl,
    credits,
    analyze,
    init,
    config,
    report,
    feedback,
    keys,
    mcp,
    self,
    skills,
  },
});

export function run(): void {
  // Load settings and configure log level
  const settings = loadSettings();
  if (settings.ok && settings.data.log_level) {
    setLogLevel(settings.data.log_level);
  }

  const effectiveSettings = settings.ok ? settings.data : undefined;
  const withBackgroundTasks = shouldRunBackgroundTasks(process.argv.slice(2));

  // An update a previous run already discovered is applied BEFORE the command,
  // and the original argv re-executed on the new binary, so a fresh run always
  // gets the newest version the CLI knows about (#170). The decision is
  // synchronous and settings-only: with nothing pending — the overwhelmingly
  // common case — this is a null check and startup is byte-for-byte the old
  // path, no await and no network.
  if (
    withBackgroundTasks &&
    effectiveSettings &&
    foregroundUpdateTarget(effectiveSettings)
  ) {
    void applyPendingUpdateInForeground(effectiveSettings)
      // Failure-safe: a broken update must never break the user's command.
      .catch(() => {})
      .then(() => startCommand(effectiveSettings, withBackgroundTasks));
    return;
  }

  startCommand(effectiveSettings, withBackgroundTasks);
}

/**
 * Whether this invocation gets the startup extras: the telemetry notice, the
 * update check/apply, install registration and log rotation.
 *
 * Skipped for simple commands and self install/update/uninstall (self install
 * resets settings, racing registerInstall; self update IS the updater —
 * including the detached --auto child — and must not spawn further checks or
 * installs), for `mcp` (JSON-RPC on stdout, nothing may pollute the stream),
 * and for --offline, which promises zero network.
 *
 * Exported for tests: it decides, among other things, which commands can print
 * the auto-updated notice.
 */
export function shouldRunBackgroundTasks(args: string[]): boolean {
  const isSelfInstallCommand =
    args[0] === "self" &&
    (args[1] === "install" || args[1] === "update" || args[1] === "uninstall");
  const isSimpleCommand =
    args.length === 0 ||
    args.includes("--version") ||
    args.includes("-v") ||
    args.includes("--help") ||
    args.includes("-h") ||
    isSelfInstallCommand ||
    args[0] === "mcp";

  return !isSimpleCommand && !args.includes("--offline");
}

function startCommand(
  settings: UserSettings | undefined,
  withBackgroundTasks: boolean
): void {
  if (withBackgroundTasks) {
    // Non-blocking background tasks
    if (settings) showTelemetryNotice(settings);
    runBackgroundUpdateCheck(settings);
    registerInstall(settings);
    rotateLogsIfNeeded().catch(() => {}); // Best effort, silent fail
  }

  // The one-time "✓ auto-updated" confirmation belongs to the RUN, not to any
  // one command: an update applied before `squirrel config` must be announced
  // by `squirrel config` (#170). Gated synchronously on the marker so the
  // ordinary run stays free of the await. printAutoUpdateAppliedNotice itself
  // only prints when this process IS the new version, and clears the marker.
  if (withBackgroundTasks && settings?.auto_update_applied) {
    void printAutoUpdateAppliedNotice(settings)
      .catch(() => {})
      .then(runCommand);
    return;
  }
  runCommand();
}

function runCommand(): void {
  // After the command settles, bound any in-process (Windows) auto-update so
  // a still-downloading binary can't hold the CLI open indefinitely (#1074).
  void runMain(main).finally(() => void finishInlineAutoUpdate());
}
