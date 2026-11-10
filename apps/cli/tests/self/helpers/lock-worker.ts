// Child process for settings-race-1660.test.ts: `bun lock-worker.ts <lockPath> <guardPath> <violationsPath> <startAtMs>` waits
// for the shared start time, then runs one critical section under withFileLock. The section creates `guardPath` exclusively; if
// it already exists another process is inside the same section, which is recorded in `violationsPath`.
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";

import { withFileLock } from "../../../src/self/settings";

const [lockPath, guardPath, violationsPath, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {
  // spin until the common start so the waiters collide on the stale lock
}
withFileLock(
  lockPath as string,
  () => {
    try {
      writeFileSync(guardPath as string, String(process.pid), { flag: "wx" });
    } catch {
      appendFileSync(violationsPath as string, `${process.pid}\n`);
      return;
    }
    const until = Date.now() + 15;
    while (Date.now() < until) {
      // hold the section long enough for a second holder to overlap
    }
    unlinkSync(guardPath as string);
  },
  { timeoutMs: 5_000, staleMs: 10_000 }
);
