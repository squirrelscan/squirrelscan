// #1462: the integrity rules charge the attributes they read and the `aria-labelledby` targets they look up to a work budget, so a
// page of tiny multi-attribute controls cannot cost more than the rule's time budget. Deterministic tests: work counts, not
// wall-clock. The hostile shapes at the default rule budget are in integrity-default-budget-1462.test.ts. Synthetic pages.

import { afterEach, describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { RuleRunner } from "../src/runner";
import { attributeLimits, readControlAttributes, scanControls, shortlist } from "../src/integrity/controls";

const url = "https://example.com/";
const MB = 1_048_576;
const OFF = "https://credential-fixture.invalid/signin";
const O = "https://o.invalid/x";
const REAL = `<a href="${OFF}">Sign in with Google</a>`;
const page = (body: string) => `<!doctype html><html><head><title>Fixture</title></head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
const rep = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length));
const doc = (body: string) => parsePage(page(body), url).document!;
const defaults = { ...attributeLimits };
afterEach(() => Object.assign(attributeLimits, defaults));

test("the default budgets are the documented ones", () => {
  expect(defaults).toEqual({ shortlist: 2_000_000, prepare: 1_500_000, fold: 2_000_000 });
});

describe("readControlAttributes reads each control once, bounded", () => {
  const el = (markup: string): Element => doc(markup).querySelector("a, button, input")!;

  test("the first of each name wins, names are case-insensitive, and the cue flag follows aria-label, title and aria-labelledby", () => {
    const read = readControlAttributes(el('<a HREF="/first" href="/second" Aria-Label="L" TITLE="T" aria-labelledby="a b" data-x="1">x</a>'));
    expect(read).toMatchObject({ href: "/first", ariaLabel: "L", title: "T", labelledby: "a b", cue: true, overlong: false, scanned: 6 });
    const input = readControlAttributes(el('<input type="submit" value="V" alt="A">'));
    expect(input).toMatchObject({ value: "V", alt: "A", href: null, cue: false, scanned: 3 });
  });

  test("the href and the cue attributes are read wherever they are: the first 4,096 attributes, then a second pass over the rest within the room it is given (#1559)", () => {
    const junk = (n: number) => Array.from({ length: n }, (_, i) => `d${i}="v"`).join(" ");
    for (const n of [63, 64, 65, 101, 4_000]) {
      const read = readControlAttributes(el(`<a ${junk(n)} aria-label="late" title="t" href="/x">x</a>`));
      expect([n, read]).toMatchObject([n, { overlong: false, scanned: n + 3, ariaLabel: "late", title: "t", href: "/x", cue: true }]);
    }
    const past = readControlAttributes(el(`<a ${junk(4_100)} aria-label="late" href="/x">x</a>`));
    expect(past).toMatchObject({ overlong: false, scanned: 4_102, ariaLabel: "late", href: "/x" });
    // with no room for the second pass the first 4,096 are all that is read, and the control is reported overlong
    const cut = readControlAttributes(el(`<a ${junk(4_100)} aria-label="late" href="/x">x</a>`), 0);
    expect(cut).toMatchObject({ overlong: true, scanned: 4_096, ariaLabel: null, href: null });
    const early = readControlAttributes(el(`<a href="/x" aria-label="early" ${junk(4_100)}>x</a>`), 0);
    expect(early).toMatchObject({ overlong: true, scanned: 4_096, ariaLabel: "early", href: "/x" });
  });
});

describe("the shortlist is charged per control and per attribute", () => {
  const links = (n: number): Element[] => Array.from(doc(`<a href="${O}">x</a>`.repeat(n)).querySelectorAll("a"));

  test("a budget that covers 10 of 100 controls examines 10 and counts the other 90 unexamined", () => {
    const found = links(100);
    // each link costs 1 + its attribute count (1)
    const covered = shortlist(found, () => null, () => false, true, { left: 20 });
    expect([covered.chosen.length, covered.cut]).toEqual([10, 90]);
    const all = shortlist(found, () => null, () => false, true, { left: Infinity });
    expect([all.chosen.length, all.cut]).toEqual([100, 0]);
  });

  test("the charge is the attributes looked at: all of them, the second pass bounded by the budget left", () => {
    const junk = Array.from({ length: 4_200 }, (_, i) => `d${i}="v"`).join(" ");
    const found = Array.from(doc(`<a href="${O}" ${junk}>x</a>`.repeat(10)).querySelectorAll("a"));
    const budget = { left: 100_000 };
    const result = shortlist(found, () => null, () => false, true, budget);
    // 10 controls x (1 + 4,201 attributes looked at), none overlong
    expect(100_000 - budget.left).toBe(10 * 4_202);
    expect(result.chosen.every((entry) => !entry.read.overlong)).toBe(true);
    // a budget of 5,000 covers the first pass and 903 attributes more: the rest of the control is overlong, and the budget is spent, not overdrawn
    const small = { left: 5_000 };
    const longer = Array.from(doc(`<a href="${O}" ${Array.from({ length: 5_000 }, (_, i) => `e${i}="v"`).join(" ")}>x</a>`).querySelectorAll("a"));
    const cut = shortlist(longer, () => null, () => false, true, small);
    expect(small.left).toBe(0);
    expect(cut.chosen.length).toBe(1);
    expect(cut.chosen[0]!.read).toMatchObject({ overlong: true, scanned: 4_096 + 903 });
  });

  test("a control with more attributes than the budget can read is counted unread; one the budget covers is not", () => {
    const junk = (n: number) => Array.from({ length: n }, (_, i) => `d${i}="v"`).join(" ");
    // the default budget covers the second pass; a budget with room for 53 attributes past the 4,096th does not cover 5,000
    expect(scanControls(doc(`<a href="${O}" ${junk(5_000)}>x</a>`)).unread).toBe(0);
    attributeLimits.shortlist = 4_150;
    expect(scanControls(doc(`<a href="${O}" ${junk(5_000)}>x</a>`)).unread).toBe(1);
    attributeLimits.shortlist = defaults.shortlist;
    expect(scanControls(doc(`<a href="${O}" ${junk(4_095)}>x</a>`)).unread).toBe(0);
    expect(scanControls(doc(`<a href="${O}" ${junk(100)}>x</a>`)).unread).toBe(0);
  });

  test("a cut attribute read is never a silent skip: a link whose href or cue is past what the budget could read is counted unread; within it, it is read", () => {
    const junk = Array.from({ length: 5_000 }, (_, i) => `d${i}="v"`).join(" ");
    // the second pass finds the href and the cue past the 4,096th attribute (#1559)
    const found = scanControls(doc(`<a ${junk} href="${O}">Sign in with Google</a><a href="/x" ${junk} aria-label="Sign in with Google">x</a>`));
    expect([found.unread, found.controls.length]).toEqual([0, 2]);
    attributeLimits.shortlist = 4_150;
    // href past the cut: no destination was read, the control is counted (before: skipped as having none)
    expect(scanControls(doc(`<a ${junk} href="${O}">Sign in with Google</a>`)).unread).toBe(1);
    // a plainly local link whose cue attribute is past the cut: counted (before: skipped as having no cue)
    expect(scanControls(doc(`<a href="/x" ${junk} aria-label="Sign in with Google">x</a>`)).unread).toBe(1);
    attributeLimits.shortlist = defaults.shortlist;
    // within the cut the same links are read: the href and the cue are found at the 70th attribute
    const near = Array.from({ length: 70 }, (_, i) => `d${i}="v"`).join(" ");
    const read = scanControls(doc(`<a ${near} href="${O}">Sign in with Google</a><a href="/x" ${near} aria-label="Sign in with Google">x</a>`));
    expect([read.unread, read.controls.length]).toEqual([0, 2]);
    // the same links with their attributes inside the cut are read as before
    expect(scanControls(doc(`<a href="/x" aria-label="Sign in with Google">x</a>`)).unread).toBe(0);
    // a link with no href and a short attribute list has no destination and is not counted
    expect(scanControls(doc(`<a name="top">x</a><a href="${O}">y</a>`)).unread).toBe(0);
  });

  test("decoys that exhaust the listing budget, then the real control: counted unread and the rule reports scanTruncated", async () => {
    attributeLimits.shortlist = 1_000;
    const body = `${`<a href="${O}" a="1">x</a>`.repeat(2_000)}<a href="${OFF}">Sign in with Google</a>`;
    expect(scanControls(doc(body)).unread).toBeGreaterThanOrEqual(1_501);
    const parsed = parsePage(page(body), url);
    const runner = new RuleRunner({ config: { rule_options: {}, rules: { enable: ["integrity/brand-impersonation"] } } as never, ruleTimeBudgetMs: 0 });
    const result = await runner.runPageRules({ url, html: page(body), statusCode: 200, loadTime: 0, headers: {}, parsed } as never);
    const brand = (result.checks as Array<{ name?: string; details?: Record<string, unknown> }>).find((c) => c.name === "brand-impersonation");
    expect(brand?.details?.scanTruncated).toBe(true);
    expect(Number(brand?.details?.controlsUnread)).toBeGreaterThanOrEqual(1_501);
  }, 60_000);

  test("scanControls counts controls the page budget did not cover as unread", () => {
    attributeLimits.shortlist = 2_000;
    const scan = scanControls(doc(`${rep(`<a href="${O}" a="1" b="2">x</a>`, 200_000)}${REAL}`));
    // 2,000 units at 4 per control: 500 examined; everything after (the real control included) is counted
    expect(scan.controls.length).toBe(500);
    expect(scan.unread).toBeGreaterThan(3_000);
  });

  test("with the default budget the same page is read in full", () => {
    const scan = scanControls(doc(`${rep(`<a href="${O}" a="1" b="2">x</a>`, 200_000)}${REAL}`));
    expect(scan.controls.some((c) => c.labels.some((l) => /sign in with google/i.test(l)))).toBe(true);
    expect(scan.unread).toBe(0);
  });
});

describe("the prepare step is charged per control and per aria-labelledby id", () => {
  test("controls past the budget keep their destination, lose their label attributes and are counted cut", () => {
    attributeLimits.prepare = 30;
    const body = `${`<a href="${O}" aria-label="plain">x</a>`.repeat(2_000)}<a href="${O}" aria-label="Sign in with Google">x</a>`;
    const scan = scanControls(doc(body));
    // 30 units at 1 per control (no ids): 30 prepared with labels; the other 1,971, the real control included, are cut
    expect(scan.unread).toBe(2_001 - 30);
    expect(scan.controls.some((c) => c.labels.some((l) => /sign in with google/i.test(l)))).toBe(false);
    attributeLimits.prepare = defaults.prepare;
    const full = scanControls(doc(body));
    expect(full.controls.some((c) => c.labels.some((l) => /sign in with google/i.test(l)))).toBe(true);
  });

  test("an aria-labelledby id costs a unit: controls naming ids exhaust the budget sooner", () => {
    attributeLimits.prepare = 60;
    const body = `<span id="a">x</span>${`<a href="${O}" aria-labelledby="a a a a">x</a>`.repeat(2_000)}`;
    const scan = scanControls(doc(body));
    // 5 units per control (1 and one per id): 12 covered; the other 1,988 are counted
    expect(scan.unread).toBe(2_000 - 12);
  });

  test("the targets' reads come off the page's visits: many distinct large targets cut the controls' own reads", () => {
    const targets = Array.from({ length: 2_000 }, (_, i) => `<div id="t${i}">${"<b>x</b>".repeat(300)}</div>`).join("");
    const controls = Array.from({ length: 2_000 }, (_, i) => `<a href="${O}" aria-labelledby="t${i}">${"<b>y</b>".repeat(40)}</a>`).join("");
    const heavy = scanControls(doc(targets + controls));
    // 2,000 targets x 256 visits is over the page's 400,000 visits: the controls' reads share a quarter, and their 81 visits no longer fit
    expect(heavy.unread).toBeGreaterThan(1_000);
    // the same controls with 20 targets fit
    const few = Array.from({ length: 20 }, (_, i) => `<div id="t${i}">${"<b>x</b>".repeat(300)}</div>`).join("");
    const light = Array.from({ length: 2_000 }, (_, i) => `<a href="${O}" aria-labelledby="t${i % 20}">${"<b>y</b>".repeat(40)}</a>`).join("");
    expect(scanControls(doc(few + light)).unread).toBe(0);
  }, 120_000);
});
