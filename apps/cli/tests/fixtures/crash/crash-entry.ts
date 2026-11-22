// Spawned by tests/self/crash-reporter.test.ts: installs the CLI's crash
// handlers, then crashes the way argv[2] asks.
import { defineCommand } from "citty";

import { runCli } from "@/cli/run-cli";
import { installCrashHandlers } from "@/self/crash-reporter";

installCrashHandlers();

const mode = process.argv[2];
if (mode === "reject") {
  void Promise.reject(new TypeError("https://secret.example/page failed"));
} else if (mode === "command") {
  // A command that throws: runCli's catch, not the process handlers.
  const main = defineCommand({
    meta: { name: "squirrel" },
    subCommands: {
      command: defineCommand({
        meta: { name: "command" },
        run() {
          throw new SyntaxError("https://secret.example/page failed");
        },
      }),
    },
  });
  void runCli(main, {
    version: "0.0.0",
    setupDone: true,
    rawArgs: ["command"],
  });
} else {
  setTimeout(() => {
    throw new RangeError("https://secret.example/page failed");
  }, 0);
}
