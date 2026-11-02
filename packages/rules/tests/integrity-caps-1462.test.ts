// #1462: the integrity rules' caps decide `controlsUnread` by counts, not by wall-clock: for each fixture the number of controls the
// cap cuts is exact. A cap changed, or a charge removed, changes a number here. Synthetic pages, parsed once each.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { integrityCounters, scanControls } from "../src/integrity/controls";

const url = "https://example.com/";
const O = "https://o.invalid/x";
const OFF = "https://credential-fixture.invalid/signin";
const doc = (body: string) => parsePage(`<!doctype html><html><head><title>Fixture</title></head><body><main>${body}</main></body></html>`, url).document!;
const unread = (body: string): number => scanControls(doc(body)).unread;
beforeEach(() => {
  integrityCounters.enabled = true;
  integrityCounters.targetReads = 0;
});
afterEach(() => {
  integrityCounters.enabled = false;
});

describe("MAX_PREPARED (60,000)", () => {
  test("62,000 off-site links and a sign-in path link: the 2,001 least relevant are counted, the sign-in one is kept", () => {
    const scan = scanControls(doc(`${`<a href="${O}" a="1">x</a>`.repeat(62_000)}<a href="${OFF}">Sign in with Google</a>`));
    expect(scan.controls.length).toBe(60_000);
    expect(scan.unread).toBe(2_001);
    expect(scan.controls.some((c) => c.labels.some((l) => /sign in with google/i.test(l)))).toBe(true);
  }, 120_000);

  test("60,000 links are all prepared", () => {
    expect(unread(`<a href="${O}" a="1">x</a>`.repeat(60_000))).toBe(0);
  }, 120_000);
});

describe("MAX_LABELLEDBY (4)", () => {
  const targets = ["a", "b", "c", "d", "e"].map((id) => `<span id="${id}">x</span>`).join("");
  test("a control naming 5 ids is counted, one naming 4 is not", () => {
    expect(unread(`${targets}<a href="${O}" aria-labelledby="a b c d e">x</a>`)).toBe(1);
    expect(unread(`${targets}<a href="${O}" aria-labelledby="a b c d">x</a>`)).toBe(0);
  });
});

describe("the page's visits (TOTAL_VISITS 400,000, SHORT_VISITS 256, LONG_VISITS 4,000, LONG_BUDGET_VISITS 40,000)", () => {
  const withChildren = (count: number, children: number): string =>
    Array.from({ length: count }, (_, i) => `<a href="https://p.invalid/${i}">${"<b>x</b>".repeat(children)}</a>`).join("");

  test("2,000 controls of 241 visits each get 200 each: the long budget (checked before each read, so the last overshoots) serves the first 167, the rest are counted", () => {
    expect(unread(withChildren(2_000, 120))).toBe(2_000 - 167);
    // 1,000 controls get 256 each (the short cap), which covers 241: none is cut
    expect(unread(withChildren(1_000, 120))).toBe(0);
  }, 120_000);

  test("300 controls of 601 visits each: the short read (256) cuts them, the long budget (40,000 visits) serves 67 of them", () => {
    expect(unread(withChildren(300, 300))).toBe(300 - 67);
    // a lone control of that size is served by the long read
    expect(unread(withChildren(1, 300))).toBe(0);
    // and one of more than 4,000 visits is counted even then
    expect(unread(withChildren(1, 2_100))).toBe(1);
  }, 120_000);
});

describe("MAX_ALTS_PER_CONTROL (100)", () => {
  test("a control wrapping 101 logos is counted, one wrapping 100 is not", () => {
    const logos = (n: number) => `<a href="${O}">${'<img alt="a" src="/l.png">'.repeat(n)}</a>`;
    expect(unread(logos(101))).toBe(1);
    expect(unread(logos(100))).toBe(0);
  });
});

describe("each distinct aria-labelledby target is read once", () => {
  test("3,000 controls naming 5 distinct targets read the first 4 (MAX_LABELLEDBY), each once", () => {
    const targets = ["a", "b", "c", "d", "e"].map((id) => `<span id="${id}">x</span>`).join("");
    scanControls(doc(`${targets}${`<a href="${O}" aria-labelledby="a b c d e">x</a>`.repeat(3_000)}`));
    expect(integrityCounters.targetReads).toBe(4);
  }, 120_000);
});

describe("distinct aria-labelledby targets are metered before they are read (3/4 of TOTAL_VISITS)", () => {
  /** `count` nested targets (each read costs the 256-visit short cap) and `controls` links each naming 4 distinct ids. */
  const nested = (count: number): string => `${Array.from({ length: count }, (_, i) => `<span id="t${i}">`).join("")}x${"</span>".repeat(count)}`;
  const naming = (controls: number): string => Array.from({ length: controls }, (_, i) => `<a href="${O}" aria-labelledby="t${4 * i} t${4 * i + 1} t${4 * i + 2} t${4 * i + 3}">x</a>`).join("");

  test("10,000 distinct targets: 1,172 are read (the 300,000-visit bound is checked before each read) and the controls that name the rest are counted", () => {
    const scan = scanControls(doc(nested(10_000) + naming(2_500)));
    expect(integrityCounters.targetReads).toBe(1_172);
    // controls 0..292 name targets 0..1,171; the other 2,207 are cut
    expect(scan.unread).toBe(2_500 - 293);
  }, 120_000);

  test("targets that fit the bound are all read and nothing is counted", () => {
    const scan = scanControls(doc(nested(1_000) + naming(250)));
    expect(integrityCounters.targetReads).toBe(1_000);
    expect(scan.unread).toBe(0);
  }, 120_000);
});

describe("the edges of the page's visits", () => {
  const link = (i: number, children: number, tail = ""): string => `<a href="https://p.invalid/${i}">${"<b>x</b>".repeat(children)}${tail}</a>`;
  const many = (count: number, children: number, tail = ""): string => Array.from({ length: count }, (_, i) => link(i, children, tail)).join("");

  test("TOTAL_VISITS: 1,600 controls of 250 visits (400,000 / 1,600 = 250 each) are read whole; with 1,601 the share is 249 and the first are cut", () => {
    expect(unread(many(1_600, 125))).toBe(0);
    expect(unread(many(1_601, 125))).toBe(90);
    // A cut read costs less than the share, so the share grows back and few controls stay cut: the page's total is a bound on work,
    // not on detection. (399,999 for 400,000 moves the first share by one visit, which that growth hides: no fixture sees it.)
  }, 120_000);

  test("SHORT_VISITS: 300 controls of exactly 256 visits are read whole at 256 and cut at 255, and of 257 are cut", () => {
    expect(unread(many(300, 128))).toBe(0);
    expect(unread(many(300, 128, "t"))).toBe(144);
  }, 120_000);

  test("MIN_ALLOWANCE: with the targets' reads spent, 30,000 controls of 4 visits get 4 each (the floor), not 3", () => {
    const targets = Array.from({ length: 1_200 }, (_, i) => `<div id="t${i}">${"<b>x</b>".repeat(130)}</div>`).join("");
    const labelled = Array.from({ length: 1_200 }, (_, i) => `<a href="https://l.invalid/${i}" aria-labelledby="t${i}">x<b>y</b>z</a>`).join("");
    const plain = Array.from({ length: 28_800 }, (_, i) => `<a href="https://p.invalid/${i}">x<b>y</b>z</a>`).join("");
    const scan = scanControls(doc(targets + labelled + plain));
    expect(integrityCounters.targetReads).toBe(1_172);
    // the 28 controls that name the unread targets are cut; every other control is read at the floor of 4
    expect(scan.unread).toBe(28);
  }, 180_000);
});
