// #1465: the work bounds of the integrity control scan, pinned with the rule clock off. A bound that nothing
// asserts can be widened a thousandfold and every test stays green; each case below fails when its bound is lifted
// (the page's two window budgets, the windows one control may take, the page's visit budget).

import { expect, test } from "bun:test";

import { integrityLimits } from "../src/integrity/controls";
import { run } from "./integrity-budget-fixture";

type Check = { details?: Record<string, unknown> };
/** The `controlsUnread` the page reports, or 0 when it reports none. */
const unread = (checks: Check[]): number => Number(checks.find((c) => c.details?.scanTruncated === true)?.details?.controlsUnread ?? 0);

/** A label with 40 windows past its first that hold a cue word: the most one attribute adds. */
const LABEL = Array.from({ length: 700 }, () => "sign in ").join("").slice(0, 6_200);

test("the default window budgets are the ones the page documents", () => {
  expect(integrityLimits).toEqual({ sequentialWindows: 10_000, sharedWindows: 10_000 });
});

test("600 controls with 40 cue windows each: the two budgets serve 250 in full and share the rest, so the rest are counted unread", async () => {
  const body = Array.from({ length: 600 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${LABEL}">x</a>`).join("");
  const found = unread((await run(body)).checks);
  // Without either budget every control is served in full and nothing is unread; with only the ordered budget
  // (250 controls) the other 350 are all cut; the shared budget gives each of those 28 of its 40, still short.
  expect(found).toBeGreaterThan(250);
  expect(found).toBeLessThanOrEqual(350);
});

test("a page with half the budgets reports more unread than the default, and none with ample ones", async () => {
  const saved = { ...integrityLimits };
  const body = Array.from({ length: 300 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${LABEL}">x</a>`).join("");
  try {
    const defaults = unread((await run(body)).checks);
    integrityLimits.sequentialWindows = 2_000;
    integrityLimits.sharedWindows = 2_000;
    const tight = unread((await run(body)).checks);
    integrityLimits.sequentialWindows = 1_000_000;
    integrityLimits.sharedWindows = 1_000_000;
    const ample = unread((await run(body)).checks);
    expect(tight).toBeGreaterThan(defaults);
    expect(ample).toBe(0);
    // 300 controls x 40 windows is 12,000: the default 10,000 + 10,000 budgets cover it.
    expect(defaults).toBe(0);
  } finally {
    Object.assign(integrityLimits, saved);
  }
});

test("one control whose attributes ask for more than 160 windows is cut at 160 and counted", async () => {
  // aria-label, title and three image alts: 5 attributes x 40 windows = 200 wanted, at most 160 served.
  const body = `<a href="https://p.invalid/x" aria-label="${LABEL}" title="${LABEL}"><img alt="${LABEL}"><img alt="${LABEL}"><img alt="${LABEL}"></a>`;
  expect(unread((await run(body)).checks)).toBe(1);
  // four attributes (160 windows) fit the cap: nothing is cut
  const four = `<a href="https://p.invalid/x" aria-label="${LABEL}" title="${LABEL}"><img alt="${LABEL}"><img alt="${LABEL}"></a>`;
  expect(unread((await run(four)).checks)).toBe(0);
});

test("3,000 controls of about 200 nodes each spend the page's visits: each read is cut short of its nodes and counted", async () => {
  const kids = Array.from({ length: 100 }, () => "<b>x</b>").join("");
  const body = Array.from({ length: 3_000 }, (_, i) => `<a href="https://p.invalid/${i}">${kids}</a>`).join("");
  // 400,000 visits over 3,000 controls is about 133 each, under the 200 nodes a control has (100 elements, each with a text node): all are cut. Were the page's
  // budget not there every control would get its full 256 and none would be cut.
  expect(unread((await run(body)).checks)).toBeGreaterThan(2_000);
}, 120_000);
