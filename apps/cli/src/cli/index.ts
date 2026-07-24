// SquirrelScan CLI main entry

import { defineCommand, runMain } from "citty";

import { setGlobalConfigPath } from "@/config";
import { registerInstall } from "@/self/register-install";
import { loadSettings } from "@/self/settings";
import { showTelemetryNotice } from "@/self/telemetry";
import {
  finishInlineAutoUpdate,
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

  // Skip background tasks for simple commands and self install/update/uninstall
  // (self install resets settings, causing race condition with registerInstall;
  // self update is itself the updater — including the detached --auto child —
  // and must not spawn further checks or installs)
  const args = process.argv.slice(2);
  const isSelfInstallCommand =
    args[0] === "self" &&
    (args[1] === "install" || args[1] === "update" || args[1] === "uninstall");
  // mcp speaks JSON-RPC on stdout — skip background tasks so nothing pollutes the stream.
  const isMcpCommand = args[0] === "mcp";
  const isSimpleCommand =
    args.length === 0 ||
    args.includes("--version") ||
    args.includes("-v") ||
    args.includes("--help") ||
    args.includes("-h") ||
    isSelfInstallCommand ||
    isMcpCommand;

  // --offline promises zero network: skip update check + install registration
  const isOffline = args.includes("--offline");

  if (!isSimpleCommand && !isOffline) {
    // Non-blocking background tasks
    const effectiveSettings = settings.ok ? settings.data : undefined;
    if (effectiveSettings) showTelemetryNotice(effectiveSettings);
    runBackgroundUpdateCheck(effectiveSettings);
    registerInstall(effectiveSettings);
    rotateLogsIfNeeded().catch(() => {}); // Best effort, silent fail
  }

  // After the command settles, bound any in-process (Windows) auto-update so
  // a still-downloading binary can't hold the CLI open indefinitely (#1074).
  void runMain(main).finally(() => void finishInlineAutoUpdate());
}
