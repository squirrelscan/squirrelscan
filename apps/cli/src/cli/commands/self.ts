import { defineCommand } from "citty";

import type { UserSettings } from "@/self/types";

import { warnIfSessionUnreadable } from "@/self/credentials";
import { redactValue } from "@/utils/redact";

import { version as pkgVersion } from "../../../package.json";

const REDACTED = "[REDACTED]";

/**
 * Deep-clone `settings` and mask every secret before display. Reuses
 * redactValue() for the clone + baseline pass (mirrors redactConfigForDisplay
 * in controllers/config.ts), then explicitly masks the two settings-specific
 * secrets the baseline pass can't recognize:
 *   - `auth` — the whole object, because `auth.token` is a live session bearer.
 *   - each `tool_credentials` value — a plaintext BYOK secret on
 *     keychain-unavailable installs — EXCEPT the `{ _keychainRef: true }`
 *     sentinel, which only points at the OS keychain and holds no secret.
 * Never mutates the caller's object — redactValue returns a fresh clone.
 */
export function redactSettingsForDisplay(
  settings: UserSettings
): Record<string, unknown> {
  const redacted = redactValue(settings) as Record<string, unknown>;

  // A live session bearer token lives under auth.token — mask the whole object.
  if (redacted.auth != null) {
    redacted.auth = REDACTED;
  }

  const creds = redacted.tool_credentials;
  if (creds != null && typeof creds === "object") {
    const credsRecord = creds as Record<string, unknown>;
    for (const [tool, cred] of Object.entries(credsRecord)) {
      // The keychain-ref sentinel holds no secret (the real key is in the OS
      // keychain); every other value is a plaintext BYOK credential.
      const isKeychainRef =
        cred != null &&
        typeof cred === "object" &&
        (cred as Record<string, unknown>)._keychainRef === true;
      if (!isKeychainRef) credsRecord[tool] = REDACTED;
    }
  }

  return redacted;
}

function getShellConfig(): { shell: string; rcFile: string } {
  const { platform } = process;
  const shell = process.env.SHELL ?? "";
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  if (platform === "win32") {
    return { shell: "powershell", rcFile: "$PROFILE" };
  }

  if (shell.includes("zsh")) {
    return { shell: "zsh", rcFile: `${home}/.zshrc` };
  }
  if (shell.includes("fish")) {
    return { shell: "fish", rcFile: `${home}/.config/fish/config.fish` };
  }
  if (shell.includes("bash")) {
    // Prefer .bashrc, use .bash_profile on macOS if .bashrc doesn't exist
    const { existsSync } = require("node:fs");
    if (existsSync(`${home}/.bashrc`)) {
      return { shell: "bash", rcFile: `${home}/.bashrc` };
    }
    return { shell: "bash", rcFile: `${home}/.bash_profile` };
  }

  return { shell: "sh", rcFile: `${home}/.profile` };
}

function printPathInstructions(binDir: string): void {
  const { platform } = process;
  const { shell, rcFile } = getShellConfig();

  console.log(`\nWarning: ${binDir} is not in your PATH`);

  if (platform === "win32") {
    console.log("\nTo add permanently, run:");
    console.log(
      `  [Environment]::SetEnvironmentVariable('Path', $env:Path + ';${binDir}', 'User')`
    );
    console.log("\nThen restart your terminal.");
  } else if (shell === "fish") {
    console.log(`\nAdd to ${rcFile}:`);
    console.log(`  fish_add_path ${binDir}`);
    console.log("\nOr run now:");
    console.log(
      `  echo 'fish_add_path ${binDir}' >> ${rcFile} && source ${rcFile}`
    );
  } else {
    console.log(`\nAdd to ${rcFile}:`);
    console.log(`  export PATH="${binDir}:$PATH"`);
    console.log("\nOr run now:");
    console.log(
      `  echo 'export PATH="${binDir}:$PATH"' >> ${rcFile} && source ${rcFile}`
    );
  }
}

const selfInstall = defineCommand({
  meta: {
    name: "install",
    description: "Bootstrap local installation",
  },
  args: {
    "bin-dir": {
      type: "string",
      description: "Custom bin directory for symlink (default: ~/.local/bin)",
    },
  },
  async run({ args }) {
    const { runSelfInstall } = await import("@/controllers/self/install");
    const result = await runSelfInstall(pkgVersion, {
      binDir: args["bin-dir"],
    });

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    console.log(`Installed v${result.data.version}`);
    console.log(`  Binary: ${result.data.install_path}`);
    console.log(`  Symlink: ${result.data.symlink_path}`);

    // Add Claude Code skill hint
    console.log(
      "\nTip: Run 'squirrel skills install' to add Claude Code integration"
    );

    if (!result.data.bin_in_path) {
      const binDir = result.data.symlink_path.replace(
        /\/squirrel(\.exe)?$/,
        ""
      );
      printPathInstructions(binDir);
    }
  },
});

const selfUpdate = defineCommand({
  meta: {
    name: "update",
    description: "Check and apply updates",
  },
  args: {
    check: {
      type: "boolean",
      description: "Only check for updates, don't install",
    },
    dismiss: {
      type: "boolean",
      description: "Dismiss update notification for current version",
    },
    force: {
      type: "boolean",
      description: "Update even if this binary isn't a managed install",
    },
    auto: {
      type: "boolean",
      description: "Silent background update (used internally by auto-update)",
    },
  },
  async run({ args }) {
    if (args.auto) {
      // Detached child spawned by the background updater — never prints,
      // reports via telemetry and the next-run notice.
      const { runAutoUpdate } = await import("@/self/updater");
      await runAutoUpdate();
      return;
    }

    if (args.dismiss) {
      const { loadSettings, updateSettings } = await import("@/self/settings");
      const settings = loadSettings();

      if (!settings.ok) {
        console.error(`Error: ${settings.error.message}`);
        process.exit(1);
      }

      const notification = settings.data.pending_update_notification;
      if (!notification) {
        console.log("No pending update notification to dismiss.");
        return;
      }

      const dismissResult = await updateSettings({
        dismissed_update_version: notification.to_version,
        pending_update_notification: undefined,
        update_prompt_snoozed_until: null,
      });

      if (!dismissResult.ok) {
        console.error(`Error: ${dismissResult.error.message}`);
        process.exit(1);
      }

      console.log(
        `Update notification dismissed for v${notification.to_version}`
      );
      return;
    }

    if (args.check) {
      const { runCheckOnly } = await import("@/controllers/self/update");
      const result = await runCheckOnly();

      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }

      if (result.data.available) {
        console.log(`Update available: v${result.data.latest_version}`);
        console.log("Run 'squirrel self update' to install");
      } else {
        console.log(
          `Already on latest version (${result.data.current_version})`
        );
      }
      return;
    }

    const { runSelfUpdate } = await import("@/controllers/self/update");
    const result = await runSelfUpdate({ force: args.force });

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    if (result.data.updated) {
      console.log(`Updated to v${result.data.to_version}`);
      if (result.data.release_url) {
        console.log(`See release notes: ${result.data.release_url}`);
      }
    } else {
      console.log(`Already on latest version (${result.data.from_version})`);
    }
  },
});

const selfCompletion = defineCommand({
  meta: {
    name: "completion",
    description: "Generate shell completions",
  },
  args: {
    shell: {
      type: "positional",
      description: "Shell type: bash, zsh, or fish",
      required: true,
    },
  },
  async run({ args }) {
    const { generateCompletion } = await import("@/self/completion");
    const shell = args.shell as "bash" | "zsh" | "fish";

    if (!["bash", "zsh", "fish"].includes(shell)) {
      console.error(`Unknown shell: ${shell}. Use: bash, zsh, or fish`);
      process.exit(1);
    }

    warnIfSessionUnreadable();
    const result = generateCompletion(shell);
    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    console.log(result.data);
  },
});

const selfDoctor = defineCommand({
  meta: {
    name: "doctor",
    description: "Run health checks",
  },
  async run() {
    const { runDoctorChecks } = await import("@/self/doctor");

    console.log("Running health checks...\n");

    const result = runDoctorChecks();
    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    const report = result.data;

    for (const check of report.checks) {
      const icon =
        check.status === "pass"
          ? "[OK]"
          : check.status === "warn"
            ? "[WARN]"
            : "[FAIL]";
      console.log(`${icon} ${check.name}: ${check.message}`);
      if (check.fix) {
        console.log(`    Fix: ${check.fix}`);
      }
    }

    console.log(
      `\nPassed: ${report.passed} | Warnings: ${report.warnings} | Failed: ${report.failed}`
    );

    if (report.failed > 0) {
      process.exit(1);
    }
  },
});

/**
 * `self disk --prune --keep N`: retire audits beyond the newest N and give the
 * space back (#1912).
 *
 * Deliberately awkward to fire by accident. `--keep` has no default because
 * retiring a crawl makes its report unrenderable and `report --list`, `--diff`
 * and `--regression-since` all reach into that history; the plan is printed and
 * confirmed before anything is deleted; and `--dry-run` stops after printing.
 */
async function runPrune(
  args: {
    keep?: string;
    project?: string;
    "dry-run"?: boolean;
    yes?: boolean;
  },
  deps: {
    formatBytes: (bytes: number) => string;
    planProjectPrune: typeof import("@/self/disk").planProjectPrune;
    runProjectPrune: typeof import("@/self/disk").runProjectPrune;
  }
): Promise<void> {
  const { formatBytes, planProjectPrune, runProjectPrune } = deps;
  const { existsSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { getProjectsPath } = await import("@/self/paths");

  // Whole-string match, not parseInt: `parseInt("1e3")` is 1, so `--keep 1e3
  // --yes` would keep ONE audit and delete the rest of a user's history while
  // reading as a request to keep a thousand. Same class as the batch-budget
  // parser in audit/stream-batch.ts.
  const raw = String(args.keep ?? "").trim();
  const keep = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(keep) || keep < 1) {
    console.error(
      "--prune needs --keep <n>, at least 1: the audits beyond the newest n stop being renderable,\n" +
        "so there is no default that would be safe to guess."
    );
    process.exit(1);
  }

  const root = getProjectsPath();
  const names = existsSync(root)
    ? readdirSync(root, { withFileTypes: true, encoding: "utf8" })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => !args.project || n === args.project)
        .sort()
    : [];

  if (args.project && names.length === 0) {
    console.error(`No project directory named ${args.project} under ${root}`);
    process.exit(1);
  }

  const plans = [];
  for (const name of names) {
    const plan = await planProjectPrune(join(root, name, "project.db"), keep);
    if (plan) plans.push({ name, plan });
  }

  if (plans.length === 0) {
    console.log(
      `Nothing to retire or reclaim: every project holds at most ${keep} ` +
        "audit(s), with no space waiting to be returned."
    );
    return;
  }

  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  console.log(`Keeping the newest ${keep} audit(s) per project.\n`);
  let rows = 0;
  let reclaimable = 0;
  // What the user is confirming is whether AUDITS are retired, not whether rows
  // are deleted. An audit outside the window with nothing deletable left in it
  // is still stamped retired and still stops opening, so the count of audits is
  // what decides the wording and the question. A project an audit already
  // retired has neither, and is still holding the space those deletes freed:
  // saying "retiring 0 audits" would read as a no-op when running it is the
  // whole point.
  let retiringAudits = 0;
  for (const { name, plan } of plans) {
    rows += plan.rows;
    reclaimable += plan.reclaimableBytes;
    retiringAudits += plan.retiring.length;
    const what =
      plan.retiring.length > 0
        ? `retiring ${plan.retiring.length} of ${
            plan.retiring.length + plan.keeping
          } audits`
        : `rebuilding to return ${formatBytes(plan.reclaimableBytes)}`;
    console.log(`${name}  ${formatBytes(plan.bytesBefore)}  ${what}`);
    for (const crawl of plan.retiring) {
      console.log(`    ${date(crawl.startedAt)}  ${crawl.id.slice(0, 8)}`);
    }
  }
  console.log(
    retiringAudits > 0
      ? `\n${retiringAudits} audit(s) and ${rows.toLocaleString()} rows across ` +
          `${plans.length} project(s). Their reports stop being renderable; ` +
          "the audits stay listed."
      : `\nNothing left to retire: ${formatBytes(reclaimable)} across ` +
          `${plans.length} project(s) is already free inside the files and ` +
          "only a rebuild returns it."
  );

  if (args["dry-run"]) {
    console.log("\nDry run: nothing was deleted.");
    return;
  }

  if (!args.yes) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        retiringAudits > 0 ? "\nRetire them? [y/N] " : "\nRebuild? [y/N] ",
        resolve
      );
    });
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Cancelled.");
      return;
    }
  }

  let before = 0;
  let after = 0;
  for (const { name, plan } of plans) {
    const result = await runProjectPrune(plan);
    before += result.bytesBefore;
    after += result.bytesAfter;
    console.log(
      `${name}: ${formatBytes(result.bytesBefore)} -> ${formatBytes(result.bytesAfter)}`
    );
  }
  console.log(`\nReclaimed ${formatBytes(Math.max(0, before - after))}.`);
}

const selfDisk = defineCommand({
  meta: {
    name: "disk",
    description: "Report what ~/.squirrel is using, per project and in total",
  },
  args: {
    json: {
      type: "boolean",
      description: "Emit the usage as JSON",
    },
    limit: {
      type: "string",
      description: "Show at most this many projects (default 15)",
    },
    prune: {
      type: "boolean",
      description:
        "Retire audits beyond --keep and reclaim the space (requires --keep)",
    },
    keep: {
      type: "string",
      description:
        "How many recent audits per project stay renderable. No default: this deletes report history, so it must be said out loud",
    },
    project: {
      type: "string",
      description: "Limit --prune to one project (its directory name)",
    },
    "dry-run": {
      type: "boolean",
      description: "With --prune, list what would go and stop",
    },
    yes: {
      type: "boolean",
      description: "Skip the confirmation prompt",
    },
  },
  async run({ args }) {
    const { collectDiskUsage, formatBytes, planProjectPrune, runProjectPrune } =
      await import("@/self/disk");

    if (args.prune) {
      return runPrune(args, { formatBytes, planProjectPrune, runProjectPrune });
    }

    const result = collectDiskUsage();
    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }
    const usage = result.data;

    if (args.json) {
      console.log(JSON.stringify(usage, null, 2));
      return;
    }

    const limit = Number.parseInt(String(args.limit ?? "15"), 10);
    const shown = usage.projects.slice(
      0,
      Number.isFinite(limit) && limit > 0 ? limit : 15
    );

    console.log("Projects");
    if (shown.length === 0) {
      console.log("  (none)");
    }
    for (const project of shown) {
      const detail = project.unreadable
        ? "unreadable"
        : `${project.crawls} audit${project.crawls === 1 ? "" : "s"}`;
      console.log(
        `  ${formatBytes(project.bytes).padStart(9)}  ${project.name}  (${detail})`
      );
    }
    const hidden = usage.projects.length - shown.length;
    if (hidden > 0) console.log(`  ... and ${hidden} more`);

    console.log("\nTotals");
    console.log(`  ${formatBytes(usage.projectsBytes).padStart(9)}  projects`);
    console.log(
      `  ${formatBytes(usage.contentStoreBytes).padStart(9)}  content store (shared)`
    );
    console.log(
      `  ${formatBytes(usage.linkCacheBytes).padStart(9)}  link cache (shared)`
    );
    console.log(`  ${formatBytes(usage.releasesBytes).padStart(9)}  releases`);
    console.log(`  ${formatBytes(usage.logsBytes).padStart(9)}  logs`);
    console.log(`  ${formatBytes(usage.totalBytes).padStart(9)}  total`);

    // Said once, about the biggest project, with the reason. `rule_results` is
    // about 204 rows per page per audit, so the audits a project is holding are
    // most of what it costs. The window itself lives in each project's
    // squirrel.toml rather than in the database, so this names the setting
    // instead of claiming a number it cannot know from here.
    const repeated = usage.projects.filter((p) => p.crawls > 1);
    if (repeated.length > 0) {
      const worst = repeated[0]!;
      const retired =
        worst.retiredCrawls > 0
          ? `, ${worst.retiredCrawls} already retired`
          : "";
      console.log(
        `\n${worst.name} holds ${worst.crawls} audits${retired} ` +
          `(${worst.ruleResultRows.toLocaleString()} rule results). An audit ` +
          `retires the ones outside [storage] keep_audits (default 3); this ` +
          `command is what returns their space to the filesystem.`
      );
    }
  },
});

const selfVersion = defineCommand({
  meta: {
    name: "version",
    description: "Show version information",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    warnIfSessionUnreadable();
    const { getVersionInfo } = await import("@/controllers/self/version");
    const result = getVersionInfo();

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    const info = result.data;

    if (args.json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log(`squirrel v${info.version}`);
      console.log(`  Channel: ${info.channel}`);
      console.log(`  Platform: ${info.platform}`);
      console.log(`  Bun: ${info.bun_version}`);
    }
  },
});

const selfSettingsShow = defineCommand({
  meta: {
    name: "show",
    description: "Show current settings",
  },
  args: {
    local: {
      type: "boolean",
      description: "Show only local project settings",
    },
    user: {
      type: "boolean",
      description: "Show only user settings",
    },
  },
  async run({ args }) {
    const {
      loadMergedSettings,
      loadSettingsFromScope,
      loadUserSettings,
      WRITABLE_SETTINGS,
    } = await import("@/self/settings");
    const { getSettingsPath, findLocalSettingsPath } =
      await import("@/self/paths");

    // Handle --local flag
    if (args.local) {
      const localPathResult = findLocalSettingsPath();
      if (!localPathResult.ok) {
        console.error(`Error: ${localPathResult.error.message}`);
        process.exit(1);
      }
      const localPath = localPathResult.data;
      if (!localPath) {
        console.log("No local settings found in this directory tree.");
        console.log(
          "Use 'squirrel self settings set <key> <value> --local' to create one."
        );
        return;
      }

      const result = loadSettingsFromScope("local");
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }

      console.log(`Local Settings (${localPath}):\n`);
      const settings = result.data;
      if (Object.keys(settings).length === 0) {
        console.log("  (no settings defined)");
      } else {
        for (const [key, value] of Object.entries(settings)) {
          console.log(`  ${key.padEnd(20)} = ${value}`);
        }
      }
      return;
    }

    // Handle --user flag
    if (args.user) {
      const result = loadUserSettings();
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }

      console.log(`User Settings (${getSettingsPath()}):\n`);
      for (const [key, value] of Object.entries(
        redactSettingsForDisplay(result.data)
      )) {
        if (value === undefined) continue;
        const displayValue =
          typeof value === "object" ? JSON.stringify(value) : String(value);
        const isWritable = WRITABLE_SETTINGS.includes(
          key as (typeof WRITABLE_SETTINGS)[number]
        );
        const suffix = isWritable ? "" : "  (read-only)";
        console.log(`  ${key.padEnd(28)} = ${displayValue}${suffix}`);
      }
      return;
    }

    // Default: show merged effective settings
    const result = loadMergedSettings();
    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    const { effective, sources, userPath, localPath } = result.data;

    console.log("Effective Settings:\n");
    for (const [key, value] of Object.entries(
      redactSettingsForDisplay(effective)
    )) {
      if (value === undefined) continue;
      const displayValue =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      const source = sources[key as keyof typeof sources];
      const isWritable = WRITABLE_SETTINGS.includes(
        key as (typeof WRITABLE_SETTINGS)[number]
      );

      let extra = "";
      if (key === "channel") {
        extra = "  options: stable, beta";
      } else if (isWritable) {
        extra = "";
      } else {
        extra = "  (read-only)";
      }

      console.log(
        `  ${key.padEnd(28)} = ${String(displayValue).padEnd(12)} (${source})${extra}`
      );
    }

    console.log(`\nUser:  ${userPath}`);
    console.log(`Local: ${localPath ?? "(none)"}`);
  },
});

const selfSettingsSet = defineCommand({
  meta: {
    name: "set",
    description: "Set a settings value",
  },
  args: {
    key: {
      type: "positional",
      description: "Setting key (channel, auto_update, notifications, tips)",
      required: true,
    },
    value: {
      type: "positional",
      description: "New value",
      required: true,
    },
    local: {
      type: "boolean",
      description: "Set in local project settings (.squirrel/settings.json)",
    },
    user: {
      type: "boolean",
      description: "Set in user settings (~/.squirrel/settings.json)",
    },
  },
  async run({ args }) {
    const { setSettingValue } = await import("@/self/settings");
    const { getSettingsPath, getLocalSettingsPath } =
      await import("@/self/paths");
    const scope = args.local ? "local" : "user";

    const result = setSettingValue(String(args.key), String(args.value), scope);

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    const path = scope === "user" ? getSettingsPath() : getLocalSettingsPath();
    console.log(`Set ${result.data.key} = ${result.data.value} (${scope})`);
    console.log(`  Written to: ${path}`);
  },
});

const selfSettings = defineCommand({
  meta: {
    name: "settings",
    description: "Manage CLI settings",
  },
  subCommands: {
    show: selfSettingsShow,
    set: selfSettingsSet,
  },
});

const selfUninstall = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove squirrel from the system",
  },
  args: {
    purge: {
      type: "boolean",
      description: "Also remove user settings",
    },
    force: {
      type: "boolean",
      description: "Skip confirmation prompt",
    },
  },
  async run({ args }) {
    const { getSquirrelPaths, getSymlinkPath } = await import("@/self/paths");
    const { runSelfUninstall } = await import("@/controllers/self/uninstall");
    const { createInterface } = await import("node:readline");

    const paths = getSquirrelPaths();
    const symlinkPath = getSymlinkPath();

    // Show what will be removed
    console.log("This will remove:");
    console.log(`  - Symlink at ${symlinkPath}`);
    console.log(`  - Cached releases at ${paths.releases}`);

    if (args.purge) {
      console.log(`  - User settings at ${paths.config}`);
    } else {
      console.log(`\nUser settings at ${paths.config} will be preserved.`);
      console.log("Use --purge to also remove settings.");
    }

    // Confirmation prompt unless --force
    if (!args.force) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question("\nContinue? [y/N] ", resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }

    const result = await runSelfUninstall({
      purge: args.purge ?? false,
      force: args.force ?? false,
    });

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    const data = result.data;

    if (data.symlink_removed) {
      console.log("✓ Removed symlink");
    }

    if (data.releases_removed) {
      const sizeMB = (data.releases_size_bytes / 1024 / 1024).toFixed(1);
      console.log(
        `✓ Removed cached releases (${data.releases_count} versions, ${sizeMB}MB)`
      );
    }

    if (data.settings_removed) {
      console.log("✓ Removed user settings");
    }

    console.log("✓ Uninstall complete");
    console.log(
      '\nNote: If you added shell completions, remove from your shell config:\n  eval "$(squirrel self completion <shell>)"'
    );
  },
});

export const self = defineCommand({
  meta: {
    name: "self",
    description: "Self-management commands",
  },
  subCommands: {
    disk: selfDisk,
    install: selfInstall,
    update: selfUpdate,
    completion: selfCompletion,
    doctor: selfDoctor,
    version: selfVersion,
    settings: selfSettings,
    uninstall: selfUninstall,
  },
});
