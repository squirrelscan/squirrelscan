// SquirrelScan CLI main entry
//
// Startup is split into a light path and a full path. The light path
// (`--version`, `--help`, `self install|update|uninstall`, `self disk`, `mcp`,
// `--offline`) evaluates citty, settings and the logger only; everything else
// (the updater, telemetry, install registration, the banner, the config
// loader, every subcommand) is a dynamic import bundled as its own chunk
// (`bun build --compile --splitting`), so it is neither parsed nor evaluated
// until a run actually needs it. Before this, every invocation paid for the
// audit engine and every rule package up front: `squirrel self install` sat
// at ~140 MB resident and was OOM-killed (exit 137) at the last step of
// install.sh on memory-capped machines (#2023).

import { defineCommand, runMain } from "citty";

import type { UserSettings } from "@/self/types";

import { loadSettings } from "@/self/settings";
import { setLogLevel } from "@/utils/logger";

import { version } from "../../package.json";

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
  async setup({ args }) {
    // The config loader is only evaluated when a path is given: with no flag
    // the global stays at its initial undefined, which is what
    // setGlobalConfigPath(undefined) would have set.
    const configFile = args["config-file"];
    if (configFile) {
      const { setGlobalConfigPath } = await import("@/config");
      setGlobalConfigPath(configFile);
    }
  },
  // Every subcommand is resolved lazily: citty only loads the one it runs
  // (all of them for --help). A static import graph evaluated the audit
  // engine and every rule package on EVERY invocation, which put the
  // resident set of `squirrel self install` at ~140 MB and got the installer
  // OOM-killed (exit 137) on memory-capped machines (#2023).
  subCommands: {
    audit: () => import("./commands/audit").then((m) => m.audit),
    auth: () => import("./commands/auth").then((m) => m.auth),
    crawl: () => import("./commands/crawl").then((m) => m.crawl),
    credits: () => import("./commands/credits").then((m) => m.credits),
    analyze: () => import("./commands/analyze").then((m) => m.analyze),
    init: () => import("./commands/init").then((m) => m.init),
    config: () => import("./commands/config").then((m) => m.config),
    report: () => import("./commands/report").then((m) => m.report),
    feedback: () => import("./commands/feedback").then((m) => m.feedback),
    keys: () => import("./commands/keys").then((m) => m.keys),
    mcp: () => import("./commands/mcp").then((m) => m.mcp),
    self: () => import("./commands/self").then((m) => m.self),
    skills: () => import("./commands/skills").then((m) => m.skills),
  },
});

export function run(): void {
  // Load settings and configure log level
  const settings = loadSettings();
  if (settings.ok && settings.data.log_level) {
    setLogLevel(settings.data.log_level);
  }

  const effectiveSettings = settings.ok ? settings.data : undefined;

  if (!shouldRunBackgroundTasks(process.argv.slice(2))) {
    // Light path: nothing but the command. No updater, no telemetry, no
    // registration, so none of their modules are loaded.
    void runMain(main);
    return;
  }

  // Failure-safe: the extras must never break the user's command. The
  // rejection handler covers the LOAD only (a two-argument then, so a throw
  // inside runWithStartupExtras cannot run the command a second time); the
  // command itself reports its own errors through runMain.
  void import("./startup").then(
    ({ runWithStartupExtras }) => runWithStartupExtras(main, effectiveSettings),
    () => void runMain(main)
  );
}

/**
 * Whether this invocation gets the startup extras: the telemetry notice, the
 * update check/apply, install registration and log rotation.
 *
 * Skipped for simple commands and self install/update/uninstall (self install
 * resets settings, racing registerInstall; self update IS the updater —
 * including the detached --auto child — and must not spawn further checks or
 * installs), for `mcp` (JSON-RPC on stdout, nothing may pollute the stream),
 * for `self disk` (it MEASURES the logs directory, and the maintenance below
 * compresses and deletes logs — leaving it in lets the command change the
 * number it is about to print, and lets an update land mid-measurement), and
 * for --offline, which promises zero network.
 *
 * Exported for tests: it decides, among other things, which commands can print
 * the auto-updated notice.
 */
export function shouldRunBackgroundTasks(args: string[]): boolean {
  const isSelfInstallCommand =
    args[0] === "self" &&
    (args[1] === "install" || args[1] === "update" || args[1] === "uninstall");
  const isSelfDisk = args[0] === "self" && args[1] === "disk";
  const isSimpleCommand =
    args.length === 0 ||
    args.includes("--version") ||
    args.includes("-v") ||
    args.includes("--help") ||
    args.includes("-h") ||
    isSelfInstallCommand ||
    isSelfDisk ||
    args[0] === "mcp";

  return !isSimpleCommand && !args.includes("--offline");
}
