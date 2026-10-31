import { expect, test } from "bun:test";
import { REAL, run, finished, fired } from "./integrity-budget-fixture";

// #784: the two slowest hostile pages (about 40 s together), in a file of their own so the others stay short and
// a lane's test watchdog (150 s) does not cut a loaded run without a summary (#1465).

test("30,000 cross-host decoys with children before the real control: the fair share finds it", async () => {
  const decoy = `<a href="https://p.invalid/x">${"<i></i>".repeat(20)}</a>`;
  const { checks } = await run(`${decoy.repeat(30_000)}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);

// Characterisation: this passes on main too; it pins the behaviour on nested anchors.
test("20,000 unclosed anchors nest in each other; both rules finish and the innermost real control is found", async () => {
  const { checks } = await run(`${'<a href="https://p.invalid/x">x'.repeat(20_000)}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);
