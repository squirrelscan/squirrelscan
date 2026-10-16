// #578 — Bun leaves the vm watchdog armed after `runInContext` returns. Work that
// ran past the budget after a fast rule, in the same task, used to be terminated:
// no error, no report, exit 0. runWithinBudget now pushes the deadline out of
// reach after every call. A terminated process cannot report, so the scenario
// runs in a child process that must reach the end. (A rule that ends just past
// its deadline is a separate race, #880, not covered here.)

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("runWithinBudget leaves no deadline behind (#578)", () => {
  test("work past the budget after a fast call still runs, sync and in a microtask", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/watchdog-after-call.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => child.kill(), 15_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(killer);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "returned\nsync ok\nmicrotask ok\n",
      stderr: "",
      exitCode: 0,
    });
  }, 30_000);
});
