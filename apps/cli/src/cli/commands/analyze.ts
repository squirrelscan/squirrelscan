// squirrel analyze [--id <id>] - run audit rules on stored crawl

import { defineCommand } from "citty";

import { runAnalyze } from "@/controllers/analyze";
import { warnIfSessionUnreadable } from "@/self/credentials";
import { loadUserSettings, updateSettings } from "@/self/settings";
import { safeExit } from "@/self/updater";
import { setLogInterceptor } from "@/utils/logger";

import {
  printHeader,
  printUpdateNotification,
  shouldShowAutoUpdateDisabledReminder,
  printAutoUpdateDisabledReminder,
  promptForUpdate,
  printFooter,
} from "../banner";
import { printDatabaseLockWarningIfNeeded } from "../db-lock-warning";
import { createProgress } from "../progress";

export const analyze = defineCommand({
  meta: {
    name: "analyze",
    description: "Run audit rules on stored crawl",
  },
  args: {
    id: {
      type: "string",
      description: "Crawl ID (defaults to latest)",
    },
  },
  async run({ args }) {
    const settings = loadUserSettings();
    warnIfSessionUnreadable(settings);
    printHeader(settings.ok ? settings.data.channel : "stable");
    if (settings.ok) {
      printUpdateNotification(settings.data);
      if (shouldShowAutoUpdateDisabledReminder(settings.data)) {
        updateSettings({
          auto_update_disabled_reminder: new Date().toISOString(),
        });
        printAutoUpdateDisabledReminder();
      }
      await promptForUpdate(settings.data, {}); // analyze is always interactive
    }

    if (args.id) {
      console.log(`Analyzing crawl: ${args.id}`);
    } else {
      console.log("Analyzing latest crawl...");
    }
    console.log("");

    const startTime = Date.now();
    const progress = createProgress("Analyzing audit rules");

    // Route logs through progress to keep progress line at bottom
    setLogInterceptor((msg) => progress.log(msg));

    const result = await runAnalyze({
      crawlId: args.id,
      onProgress: (p) => {
        if (p.phase === "rules" && p.current !== undefined) {
          progress.update(p.current, p.total);
        }
      },
    });

    // Clear log interceptor
    setLogInterceptor(undefined);

    if (!result.ok) {
      progress.fail(result.error.message);
      printDatabaseLockWarningIfNeeded(result.error.message);
      return safeExit(1);
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    progress.succeed(`Ran ${result.data.rulesRun} rules in ${durationSec}s`);

    console.log("");
    console.log(`Analysis complete: ${result.data.crawlId.slice(0, 8)}`);
    console.log(`  Site: ${result.data.baseUrl}`);
    console.log(
      `  Passed: ${result.data.passed} | Warnings: ${result.data.warnings} | Failed: ${result.data.failed}`
    );
    console.log("");
    console.log("Run 'squirrel report' to view results.");

    // Print footer
    printFooter();
  },
});
