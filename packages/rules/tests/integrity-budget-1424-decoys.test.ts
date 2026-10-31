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

test("21,000 cue-bearing decoys before the real padded control: it is found, because every control keeps a floor of windows (#1459)", async () => {
  const real = `<a href="${OFF}" aria-label="${padded(400)}"><svg></svg></a>`;
  const { checks } = await run(`${decoys21k}${real}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 300_000);

test("21,000 cue-bearing decoys before a real control whose label has no cue word as written: found too (#1459)", async () => {
  // Fullwidth letters: the raw text has no sign-in word, so the control is not in the cue tier; its floor serves it.
  const obfuscated = `<a href="${OFF}" aria-label="${"a".repeat(400)} \uff33\uff49\uff47\uff4e \uff49\uff4e \uff57\uff49\uff54\uff48 \uff27\uff4f\uff4f\uff47\uff4c\uff45 ${"b".repeat(50)}"><svg></svg></a>`;
  const { checks } = await run(`${decoys21k}${obfuscated}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 300_000);

test("a deep padded label after the decoys is found or the page says controls went unread", async () => {
  const real = `<a href="${OFF}" aria-label="${padded(2_500)}"><svg></svg></a>`;
  const { checks } = await run(`${decoys21k}${real}`);
  expect(finished(checks)).toBe(true);
  expect(foundOrNoted(checks, "brand-impersonation")).toBe(true);
}, 300_000);
