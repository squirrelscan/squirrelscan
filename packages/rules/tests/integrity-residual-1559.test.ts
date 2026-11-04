// #1559: follow-ups of the #1538 review. A control with more than 4,096 attributes is read by a bounded second pass; an
// `aria-labelledby` padded with spaces is read or counted; `obfuscated-script` says when a link was cut; the target budget
// boundary, a cached target after the budget is spent and the counters' default are pinned.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { integrityCounters, readControlAttributes, scanControls, shortlist } from "../src/integrity/controls";
import { obfuscatedScriptRule } from "../src/integrity/obfuscated-script";
import type { RuleContext } from "../src/types";

const url = "https://example.com/";
const O = "https://o.invalid/x";
const OFF = "https://credential-fixture.invalid/signin";
const doc = (body: string, head = "") => parsePage(`<!doctype html><html><head><title>Fixture</title>${head}</head><body><main>${body}</main></body></html>`, url).document!;

/** An element that only has attributes, so a control can carry a million of them without a DOM that size. */
const fakeElement = (names: string[], values: Record<string, string> = {}): Element =>
  ({ tagName: "A", attributes: names.map((name) => ({ name, value: values[name] ?? "" })) }) as unknown as Element;
const padding = (count: number): string[] => Array.from({ length: count }, (_, i) => `a${i}`);

describe("integrityCounters is off by default (the test hook costs nothing in production)", () => {
  test("it is disabled when the module is loaded, and a scan counts nothing", () => {
    expect(integrityCounters.enabled).toBe(false);
    const before = integrityCounters.targetReads;
    scanControls(doc(`<span id="t">x</span><a href="${O}" aria-labelledby="t">x</a>`));
    expect(integrityCounters.targetReads).toBe(before);
  });
});

describe("a control with more than 4,096 attributes (second pass)", () => {
  const tail = { href: OFF, "aria-label": "Sign in with Google", title: "T", "aria-labelledby": "t", alt: "A", value: "V" };

  test("the href and the cue attributes past the 4,096th are read", () => {
    const read = readControlAttributes(fakeElement([...padding(5_000), ...Object.keys(tail)], tail));
    expect(read.href).toBe(OFF);
    expect(read.ariaLabel).toBe("Sign in with Google");
    expect(read.title).toBe("T");
    expect(read.labelledby).toBe("t");
    expect(read.cue).toBe(true);
    expect(read.overlong).toBe(false);
    expect(read.scanned).toBe(5_006);
  });

  test("the second pass is charged to the page's budget: it reads at most the room it is given, and the rest is overlong", () => {
    const element = fakeElement([...padding(5_000), "href"], { href: OFF });
    expect(readControlAttributes(element, 100).href).toBeNull();
    expect(readControlAttributes(element, 100).overlong).toBe(true);
    expect(readControlAttributes(element, 100).scanned).toBe(4_096 + 100);
    // room for exactly the rest: read, and not overlong
    const exact = readControlAttributes(element, 5_001 - 4_096);
    expect(exact.href).toBe(OFF);
    expect(exact.overlong).toBe(false);
    // no room at all: the first pass only
    const none = readControlAttributes(element, 0);
    expect(none.scanned).toBe(4_096);
    expect(none.overlong).toBe(true);
    // a million attributes with a small room cost the room, not the million
    expect(readControlAttributes(fakeElement(padding(1_000_000)), 500).scanned).toBe(4_596);
  }, 30_000);

  test("a name in the first 4,096 wins over the same name past it", () => {
    const read = readControlAttributes(fakeElement(["href", ...padding(5_000), "href"], { href: OFF }));
    expect(read.href).toBe(OFF);
  });

  test("a link padded with 5,000 valueless attributes in front of its href is a candidate, not unread", () => {
    const names = padding(5_000).join(" ");
    const scan = scanControls(doc(`<a ${names} href="${OFF}" aria-label="Sign in with Google">x</a>`));
    expect(scan.unread).toBe(0);
    expect(scan.controls.some((c) => c.labels.some((l) => /sign in with google/i.test(l)))).toBe(true);
  }, 30_000);

  test("shortlist: the second pass takes its room from the page's budget, and a link whose href is still past it is counted", () => {
    const link = fakeElement([...padding(5_000), "href"], { href: OFF });
    const run = (left: number) => {
      const budget = { left };
      return { ...shortlist([link], () => null, () => false, true, budget), budget };
    };
    // 5,001 attributes and 1 for the control: a budget of 5,002 reads all of them and spends it all
    const full = run(5_002);
    expect(full.chosen.length).toBe(1);
    expect(full.cut).toBe(0);
    expect(full.budget.left).toBe(0);
    // a budget of 4,200 has room for 103 more attributes: the href is past them, the link is counted and the budget is spent, not overdrawn
    const part = run(4_200);
    expect(part.chosen.length).toBe(0);
    expect(part.cut).toBe(1);
    expect(part.budget.left).toBe(0);
  });
});

describe("aria-labelledby padded with spaces (16,000-character slice)", () => {
  const spaces = (n: number): string => " ".repeat(n);
  const target = '<span id="t">Sign in with Google</span>';

  test("more than 16,000 leading spaces before the id: the id is read", () => {
    const scan = scanControls(doc(`${target}<a href="${OFF}" aria-labelledby="${spaces(20_000)}t">x</a>`));
    expect(scan.unread).toBe(0);
    expect(scan.controls.some((c) => c.labels.some((l) => /sign in with google/i.test(l)))).toBe(true);
  });

  test("an id past the 16,000-character slice of the ids is counted unread, and a trailing run of spaces is not", () => {
    expect(scanControls(doc(`${target}<a href="${OFF}" aria-labelledby="t${spaces(20_000)}t">x</a>`)).unread).toBe(1);
    expect(scanControls(doc(`${target}<a href="${OFF}" aria-labelledby="t${spaces(20_000)}">x</a>`)).unread).toBe(0);
    // a value that is only spaces names nothing
    expect(scanControls(doc(`${target}<a href="${OFF}" aria-labelledby="${spaces(20_000)}">x</a>`)).unread).toBe(0);
  });
});

describe("the target budget (3/4 of TOTAL_VISITS: 300,000, checked before each read)", () => {
  beforeEach(() => {
    integrityCounters.enabled = true;
    integrityCounters.targetReads = 0;
  });
  afterEach(() => {
    integrityCounters.enabled = false;
  });

  /** A target of exactly 250 visits (125 `<b>x</b>`: an element and its text each). */
  const target = (id: string): string => `<div id="${id}">${"<b>x</b>".repeat(125)}</div>`;
  const naming = (ids: string[]): string => {
    const links: string[] = [];
    for (let i = 0; i < ids.length; i += 4) links.push(`<a href="${O}" aria-labelledby="${ids.slice(i, i + 4).join(" ")}">x</a>`);
    return links.join("");
  };
  const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `t${i}`);

  test("exactly 300,000 visits spent (1,200 targets of 250): the next target is not read (`>=`, not `>`)", () => {
    const names = ids(1_201);
    const scan = scanControls(doc(names.map(target).join("") + naming(names)));
    expect(integrityCounters.targetReads).toBe(1_200);
    // the control that names only the 1,201st target is counted cut
    expect(scan.unread).toBe(1);
  }, 120_000);

  test("one visit short of the bound (a target of 249 visits last): the next target is read, and overshoots", () => {
    const names = ids(1_201);
    const odd = (id: string): string => `<div id="${id}">${"<b>x</b>".repeat(124)}x</div>`;
    // 1,199 targets of 250 visits = 299,750, then one of 249 = 299,999 < 300,000: the 1,201st is still read
    const bodies = names.map((id, i) => (i === 1_199 ? odd(id) : target(id))).join("");
    scanControls(doc(bodies + naming(names)));
    expect(integrityCounters.targetReads).toBe(1_201);
  }, 120_000);

  test("a target read before the budget was spent is reused after it, not counted cut", () => {
    const names = ids(1_200);
    const first = `<span id="early">Sign in with Google</span><a href="${O}" aria-labelledby="early">x</a>`;
    const scan = scanControls(doc(first + names.map(target).join("") + naming(names) + `<a href="${O}" aria-labelledby="early">y</a>`));
    // `early` (1 visit) and 1,200 targets of 250 spend more than 300,000: the last link still gets `early` from the cache
    expect(integrityCounters.targetReads).toBe(1_201);
    expect(scan.unread).toBe(0);
  }, 120_000);

  test("while an unread target is counted cut on the same page", () => {
    const names = ids(1_201);
    const scan = scanControls(doc(`<span id="early">x</span>` + names.map(target).join("") + naming(names) + `<a href="${O}" aria-labelledby="t1200">y</a>`));
    expect(scan.unread).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe("integrity/obfuscated-script says when a link was cut", () => {
  const payload = (): string => {
    let s = 'var _0x1a2b=function(){return "the code has been tampered!";};eval(atob("';
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let seed = 1337;
    for (let i = 0; i < 8200; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      s += alphabet[(seed >> 16) % alphabet.length];
    }
    return `${s}"));String.fromCharCode(104,105);`;
  };
  const check = (body: string) => {
    const html = `<!doctype html><html><head><title>Page</title><script>${payload()}</script></head><body>${body}</body></html>`;
    const parsed = parsePage(html, url);
    const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
    return (obfuscatedScriptRule.run(ctx) as { checks: Array<{ status: string; message: string; details?: Record<string, unknown> }> }).checks[0]!;
  };

  test("a control with five aria-labelledby ids is counted: the info check carries the note and details", () => {
    const targets = ["a", "b", "c", "d", "e"].map((id) => `<span id="${id}">x</span>`).join("");
    const c = check(`<p>text</p>${targets}<a href="${O}" aria-labelledby="a b c d e">x</a>`);
    expect(c.status).toBe("info");
    expect(c.message).toContain("single signal");
    expect(c.message).toContain("1 sign-in control could not be read in full");
    expect(c.details?.scanTruncated).toBe(true);
    expect(c.details?.controlsUnread).toBe(1);
  });

  test("a page where nothing was cut has no note", () => {
    const c = check("<p>text</p>");
    expect(c.status).toBe("info");
    expect(c.message).not.toContain("scan work limit");
    expect(c.details?.scanTruncated).toBeUndefined();
  });
});
