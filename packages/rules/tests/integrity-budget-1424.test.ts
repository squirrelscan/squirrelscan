import { expect, test } from "bun:test";
import { integrityLimits } from "../src/integrity/controls";
import { OFF, REAL, run, finished, fired, foundOrNoted, label16k, padded } from "./integrity-budget-fixture";

// #1424: work is bounded per page, not per control; the window budget fails safe and says what it cut. Work bounds are
// the subject, so the runner's wall-clock budget is off (see integrity-budget-fixture.ts).

// ── long attribute labels: work is bounded per page, not per control (#1424) ─────────────────────────────────


test("300 controls with 16 KB labels full of sign words (unique tokens) before the real controls: finished, found", async () => {
  const hostile = Array.from({ length: 300 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${label16k(i)}">x</a>`).join("");
  const { checks } = await run(`${hostile}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);

test("300 controls with 16 KB U+FDFA labels before the real control: finished, found", async () => {
  const hostile = Array.from({ length: 300 }, (_, i) => `<a href="https://p.invalid/${i}" title="${"ﷺ".repeat(16_000)}">x</a>`).join("");
  const { checks } = await run(`${hostile}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);

test("5,000 controls with 1 KB labels in three attributes before the real control: finished, found", async () => {
  const label = (i: number) => Array.from({ length: 100 }, (_, j) => `log${i}x${j}`).join(" ");
  const hostile = Array.from({ length: 5_000 }, (_, i) => `<a href="https://p.invalid/${i}" title="${label(i)}" aria-label="${label(i)}"><img alt="${label(i)}"></a>`).join("");
  const { checks } = await run(`${hostile}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);

test("100,000 tiny controls with short titles before the real control: finished, found", async () => {
  const { checks } = await run(`${'<a href="https://p.invalid/x" title="t">x</a>'.repeat(100_000)}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);

test("a padded label after the hostile controls is found, or the page says controls went unread", async () => {
  const hostile = Array.from({ length: 300 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${label16k(i)}">x</a>`).join("");
  const real = `<a href="${OFF}" aria-label="${padded(2_000)}"><svg></svg></a>`;
  const { checks } = await run(`${hostile}${real}`);
  expect(finished(checks)).toBe(true);
  expect(foundOrNoted(checks, "brand-impersonation")).toBe(true);
}, 180_000);

test("the window budget reports what it cut: hostile cue windows past the page budget are counted unread", async () => {
  // About 48,000 cue windows in 300 controls against a 20,000-window page budget, and nothing else on the page.
  const hostile = Array.from({ length: 300 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${label16k(i)}">x</a>`).join("");
  const { checks } = await run(hostile);
  const note = checks.find((c) => c.details?.scanTruncated === true);
  expect(Number(note?.details?.controlsUnread)).toBeGreaterThan(0);
  // A page whose labels fit the budget and the per-attribute cap raises no note.
  const small = await run(Array.from({ length: 5 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${label16k(i).slice(0, 3_000)}">x</a>`).join(""));
  expect(small.checks.find((c) => c.details?.scanTruncated === true)).toBeUndefined();
}, 180_000);

// ── the window budget fails safe (#1424) ─────────────────────────────────────────────────────────────────────

test("5,000 benign long-label controls before the real padded control do not spend the budget it needs", async () => {
  const benign = Array.from({ length: 5_000 }, (_, i) => `<a href="https://p.invalid/${i}" title="${"lorem ipsum dolor sit amet ".repeat(20)}${i}">x</a>`).join("");
  const real = `<a href="${OFF}" aria-label="${padded(3_000)}"><svg></svg></a>`;
  const { checks } = await run(`${benign}${real}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);

test("hostile controls with unique sign-word padding served before it do not hide the real padded control", async () => {
  const hostile = Array.from({ length: 300 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${label16k(i)}">x</a>`).join("");
  const { checks } = await run(`${hostile}<a href="${OFF}" aria-label="${padded(2_000)}"><svg></svg></a>`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);

test("an exhausted window budget reads the first window of every control, and says what it left", async () => {
  const saved = { ...integrityLimits };
  integrityLimits.sequentialWindows = 10;
  integrityLimits.sharedWindows = 10;
  try {
    const hostile = Array.from({ length: 300 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${label16k(i)}">x</a>`).join("");
    // The phrase is in the first window of the last control: read whatever the budget.
    const near = await run(`${hostile}<a href="${OFF}" aria-label="Sign in with Google"><svg></svg></a>`);
    expect(fired(near.checks, "brand-impersonation")).toBe(true);
    // The phrase is past the first window of the last control: found, or the unread note is emitted.
    const far = await run(`${hostile}<a href="${OFF}" aria-label="${padded(3_000)}"><svg></svg></a>`);
    expect(finished(far.checks)).toBe(true);
    expect(foundOrNoted(far.checks, "brand-impersonation")).toBe(true);
    const note = far.checks.find((c) => c.details?.scanTruncated === true);
    if (!fired(far.checks, "brand-impersonation")) expect(Number(note?.details?.controlsUnread)).toBeGreaterThan(0);
    // With no hit at all the note is still emitted.
    const none = await run(hostile);
    expect(Number(none.checks.find((c) => c.details?.scanTruncated === true)?.details?.controlsUnread)).toBeGreaterThan(0);
  } finally {
    Object.assign(integrityLimits, saved);
  }
}, 180_000);

test("an attribute with more cue windows than the per-attribute cap is counted, not skipped", async () => {
  const { checks } = await run(`<a href="https://p.invalid/x" title="${label16k(1)}">x</a>`);
  expect(Number(checks.find((c) => c.details?.scanTruncated === true)?.details?.controlsUnread)).toBe(1);
}, 180_000);

test("300 controls with 16 KB U+FDFA labels finish (runner level, no clock)", async () => {
  const hostile = Array.from({ length: 300 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${"\ufdfa".repeat(16_000)}">x</a>`).join("");
  const { checks } = await run(`${hostile}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);
