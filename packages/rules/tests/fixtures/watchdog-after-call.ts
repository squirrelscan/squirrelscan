// Child process for rule-time-budget-disarm-578.test.ts. Inside one task, as the
// audit's page loop runs: a fast call under a short budget, then work that runs
// past that budget, synchronously and in a microtask. If the watchdog were left
// armed, the work would be terminated and the lines after it would never print.

import { runWithinBudget } from "../../src/rule-budget";

function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}

setTimeout(() => {
  console.log(runWithinBudget(() => "returned", 50));
  spin(200);
  console.log("sync ok");
  void Promise.resolve().then(() => {
    spin(200);
    console.log("microtask ok");
  });
}, 0);
