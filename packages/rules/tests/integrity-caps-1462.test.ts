// #1462: the integrity rules' caps decide `controlsUnread` by counts, not by wall-clock: for each fixture the number of controls the
// cap cuts is exact. A cap changed, or a charge removed, changes a number here. Synthetic pages, parsed once each.

import { beforeEach, describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { integrityCounters, scanControls } from "../src/integrity/controls";

const url = "https://example.com/";
const O = "https://o.invalid/x";
const OFF = "https://credential-fixture.invalid/signin";
const doc = (body: string) => parsePage(`<!doctype html><html><head><title>Fixture</title></head><body><main>${body}</main></body></html>`, url).document!;
const unread = (body: string): number => scanControls(doc(body)).unread;
beforeEach(() => {
  integrityCounters.targetReads = 0;
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
