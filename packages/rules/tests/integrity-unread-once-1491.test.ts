// #1491: `controlsUnread` counts a control once, however many of its bounds it hit (its attribute bound, its window caps, its
// text read), and still counts controls cut by the prepared-controls cap, by the logo-alt cap and by the templates.

import { expect, test } from "bun:test";

import { OFF, run } from "./integrity-budget-fixture";

type Check = { details?: Record<string, unknown> };
const unread = (checks: Check[]): number => Number(checks.find((c) => c.details?.scanTruncated === true)?.details?.controlsUnread ?? 0);
/** `controlsUnread` as the brand finding carries it when the page also has a finding, else from the note. */
const counted = (checks: Check[]): number => Number(checks.find((c) => c.details?.controlsUnread !== undefined)?.details?.controlsUnread ?? 0);

/** An attribute over the 16,000 characters read, with more cue windows than the per-attribute cap. */
const BIG_ATTRIBUTE = `${"sign in ".repeat(2_500)}${"a".repeat(2_000)}`;
/** More nodes inside the control than even the long read visits: its text read is cut as well. */
const BIG_TEXT = "<b>x</b>".repeat(6_000);

test("a control over the attribute bound and the window cap is counted once", async () => {
  const { checks } = await run(`<a href="${OFF}" aria-label="${BIG_ATTRIBUTE}"><svg></svg></a>`);
  expect(unread(checks)).toBe(1);
}, 120_000);

test("a control over the attribute bound, the window cap AND the text read is counted once, and so are three of them", async () => {
  const one = (i: number) => `<a href="https://p.invalid/${i}" aria-label="${BIG_ATTRIBUTE}">${BIG_TEXT}</a>`;
  expect(unread((await run(one(0))).checks)).toBe(1);
  expect(unread((await run(one(1) + one(2) + one(3))).checks)).toBe(3);
}, 120_000);

test("each bound alone still counts the control", async () => {
  expect(unread((await run(`<a href="${OFF}" aria-label="${BIG_ATTRIBUTE}"><svg></svg></a>`)).checks)).toBe(1);
  expect(unread((await run(`<a href="${OFF}" aria-label="Sign in">${BIG_TEXT}</a>`)).checks)).toBe(1);
}, 120_000);

test("a finding on the page carries the count too, once", async () => {
  const { checks } = await run(`<a href="${OFF}" aria-label="${BIG_ATTRIBUTE} Sign in with Google">${BIG_TEXT}</a>`);
  expect(counted(checks)).toBe(1);
}, 120_000);

test("controls cut by the prepared-controls cap are still counted, each once", async () => {
  // 60,500 off-site links with a title: 500 past the 60,000 prepared are counted, nothing else is cut
  const decoys = '<a href="https://p.invalid/x" title="t">x</a>'.repeat(60_500);
  expect(unread((await run(decoys)).checks)).toBe(500);
}, 240_000);

test("a control cut by the logo-alt cap is counted once, with the attribute bound hit as well", async () => {
  const alts = Array.from({ length: 6 }, (_, i) => `<img src="/l${i}.png" alt="${"b".repeat(400)}">`).join("");
  const { checks } = await run(`<a href="${OFF}" aria-label="${BIG_ATTRIBUTE}">${alts}</a>`);
  expect(unread(checks)).toBe(1);
}, 120_000);

test("two controls cut for different reasons (attribute bound, text read) are two, and a third cut by both is three", async () => {
  const attr = `<a href="https://a.invalid/1" aria-label="${BIG_ATTRIBUTE}"><svg></svg></a>`;
  const text = `<a href="https://a.invalid/2" aria-label="Sign in">${BIG_TEXT}</a>`;
  const both = `<a href="https://a.invalid/3" aria-label="${BIG_ATTRIBUTE}">${BIG_TEXT}</a>`;
  expect(unread((await run(attr + text)).checks)).toBe(2);
  expect(unread((await run(attr + text + both)).checks)).toBe(3);
}, 120_000);

test("controls of different rank (an off-site link, a button in a form, a sign-in label) are each counted once", async () => {
  const offSite = `<a href="https://a.invalid/1" aria-label="${BIG_ATTRIBUTE}">${BIG_TEXT}</a>`;
  const button = `<form action="https://a.invalid/f" method="post"><button aria-label="${BIG_ATTRIBUTE}">${BIG_TEXT}</button></form>`;
  const labelled = `<a href="/local" aria-label="${BIG_ATTRIBUTE} Sign in">${BIG_TEXT}</a>`;
  expect(unread((await run(offSite)).checks)).toBe(1);
  expect(unread((await run(offSite + button)).checks)).toBe(2);
  expect(unread((await run(offSite + button + labelled)).checks)).toBe(3);
}, 120_000);
