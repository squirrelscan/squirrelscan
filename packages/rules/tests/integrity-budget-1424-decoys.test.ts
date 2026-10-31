import { expect, test } from "bun:test";
import { OFF, run, finished, fired, foundOrNoted, padded } from "./integrity-budget-fixture";

// #1424: 21,000 cue-bearing decoys (about 8 MB), in a file of their own so its memory and time stay under a lane's
// test watchdog (#1465).

// 21,000 cue-bearing decoys (about 8 MB) spend more windows than the page budget has.
const decoys21k = Array.from({ length: 21_000 }, (_, i) => `<a href="https://p.invalid/${i}" title="${"sign in please ".repeat(24)}">x</a>`).join("");

test("21,000 cue-bearing decoys after the real padded control: it is found, because the first controls are read in full", async () => {
  // Cue-bearing text after the phrase too, so a share of one window (the last) would miss the phrase.
  const real = `<a href="${OFF}" aria-label="${"a".repeat(2_500)} Sign in with Google ${"sign in please ".repeat(300)}"><svg></svg></a>`;
  const { checks } = await run(`${real}${decoys21k}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 300_000);

test("21,000 cue-bearing decoys before the real padded control: found, or the page says controls went unread", async () => {
  const real = `<a href="${OFF}" aria-label="${padded(2_500)}"><svg></svg></a>`;
  const { checks } = await run(`${decoys21k}${real}`);
  expect(finished(checks)).toBe(true);
  expect(foundOrNoted(checks, "brand-impersonation")).toBe(true);
  const note = checks.find((c) => c.details?.scanTruncated === true);
  if (!fired(checks, "brand-impersonation")) expect(Number(note?.details?.controlsUnread)).toBeGreaterThan(0);
}, 300_000);
