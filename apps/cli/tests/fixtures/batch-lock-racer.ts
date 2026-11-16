// Child process for the batch lock race test: waits for a shared start time, races for the lock, holds it, prints the outcome.
import { acquireLock } from "../../src/batch/run";

const [outDir, startAt, deadPid] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {
  // spin to line the racers up
}
const lock = acquireLock(outDir!, (pid) => pid !== Number(deadPid));
if (typeof lock === "string") {
  console.log(`lost ${lock}`);
} else {
  console.log("won");
  await Bun.sleep(1500);
  lock();
}
