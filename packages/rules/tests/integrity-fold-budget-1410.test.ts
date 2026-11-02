// #1410: the digit fold of a label is bounded: a label is folded to at most 16,000 characters and the page's fold budget
// (2,000,000 characters, `attributeLimits.fold`), and a control whose label was not folded in full is counted unread.
// The rules are not abandoned on a page of digit-heavy text. Synthetic pages.

import { afterEach, describe, expect, test } from "bun:test";
import { cpus, loadavg } from "node:os";
import { parsePage } from "@squirrelscan/parser";

import { attributeLimits, scanControls } from "../src/integrity/controls";
import { RuleRunner } from "../src/runner";

const url = "https://example.com/";
const OFF = "https://credential-fixture.invalid/signin";
const O = "https://o.invalid/x";
const MIB = 1_048_576;
const page = (body: string) => `<!doctype html><html><head><title>Fixture</title></head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
const doc = (body: string) => parsePage(page(body), url).document!;
const defaults = { ...attributeLimits };
afterEach(() => Object.assign(attributeLimits, defaults));
const UNIT = "1a1b1c1d "; // a token with four 1s: the worst case for a fold that tried every spelling

describe("the fold is bounded by length and by the page's budget", () => {
  test("the default fold budget is pinned", () => {
    expect(defaults.fold).toBe(2_000_000);
  });

  test("a label past 16,000 characters is folded to 16,000 and the control is counted unread; at 16,000 it is not", () => {
    const label = (n: number) => `<a href="${OFF}">${UNIT.repeat(Math.ceil(n / UNIT.length)).slice(0, n)}</a>`;
    expect(scanControls(doc(label(16_001))).unread).toBe(1);
    expect(scanControls(doc(label(16_000))).unread).toBe(0);
    // a long label with no digit that could be a letter needs no fold and is not counted
    expect(scanControls(doc(`<a href="${OFF}">${"lorem ".repeat(10_000)}</a>`)).unread).toBe(0);
  });

  test("a swapped-digit cue past the 16,000th character of a label is not folded (and the control is counted); inside it is", () => {
    const pad = "x".repeat(16_000 - 1);
    const cue = " S1gn 1n w1th G00g1e";
    const found = (label: string) => scanControls(doc(`<a href="${OFF}">${label}</a>`)).controls.some((c) => c.labels.some((l) => l.includes("sign in with google")));
    expect(found(`${pad}${cue}`)).toBe(false);
    expect(scanControls(doc(`<a href="${OFF}">${pad}${cue}</a>`)).unread).toBe(1);
    expect(found(`lorem ${cue}`)).toBe(true);
  });

  test("past the page's fold budget the label is read as written and the control is counted", () => {
    const links = Array.from({ length: 300 }, (_, i) => `<a href="https://p.invalid/${i}">${UNIT.repeat(100)}</a>`).join(""); // 900 characters each
    attributeLimits.fold = 9_000; // each label has 300 characters of its own and 600 for the pool: fifteen fit
    const scan = scanControls(doc(links));
    expect(scan.unread).toBe(285);
    attributeLimits.fold = defaults.fold;
    expect(scanControls(doc(links)).unread).toBe(0);
  });

  test("an attribute is charged to the same budget: past it the attribute is read as written and the control is counted", () => {
    const links = Array.from({ length: 50 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${UNIT.repeat(40)}">x</a>`).join(""); // 360 characters each: 60 past the control's own 300
    attributeLimits.fold = 300; // five attributes
    expect(scanControls(doc(links)).unread).toBe(45);
  });
});

// ── the rules at the default budget ───────────────────────────────────────────────────────────────────────────────────────

type Check = { name?: string; status?: string; details?: Record<string, unknown> };
async function run(html: string): Promise<Check[]> {
  const parsed = parsePage(html, url);
  const runner = new RuleRunner({ config: { rule_options: {}, rules: { enable: ["integrity/brand-impersonation", "integrity/fake-auth-overlay"] } } as never });
  const result = await runner.runPageRules({ url, html, statusCode: 200, loadTime: 0, headers: {}, parsed } as never);
  return (result.checks ?? []) as Check[];
}
const abandoned = (checks: Check[]): number => checks.filter((c) => c.status === "skipped" || /-error$|timeout/.test(c.name ?? "")).length;
const quiet = loadavg()[0]! < cpus().length / 2;

describe("digit-heavy text does not abandon the rules at the default budget", () => {
  // each shape at a quarter of the size (always) and at full size (skipped on a busy machine, since the budget is wall-clock)
  const SHAPES: Array<[string, (k: number) => string]> = [
    ["one 10 MiB text node of 4-ones tokens in a sign-in link", (k) => page(`<a href="${OFF}">${UNIT.repeat(Math.ceil((10 * MIB * k) / UNIT.length))}Sign in with Google</a>`)],
    ["2,000 links of 56 KB of 4-ones tokens each (112 MB at full size is not built: 40 links)", (k) => page(Array.from({ length: Math.round(40 * k) }, (_, i) => `<a href="${O}/${i}">${UNIT.repeat(6_200)}</a>`).join("") + `<a href="${OFF}">Sign in with Google</a>`)],
    ["10,000 links of 4-ones tokens", (k) => page(Array.from({ length: Math.round(10_000 * k) }, (_, i) => `<a href="${O}/${i}">${UNIT.repeat(40)}</a>`).join("") + `<a href="${OFF}">Sign in with Google</a>`)],
  ];
  for (const [label, build] of SHAPES) {
    test(`${label}, a quarter of the size: not abandoned, and the controls not folded are counted`, async () => {
      const checks = await run(build(0.25));
      expect([label, abandoned(checks)]).toEqual([label, 0]);
      const brand = checks.find((c) => c.name === "brand-impersonation");
      expect([label, brand?.details?.brand === "Google" || Number(brand?.details?.controlsUnread ?? 0) > 0]).toEqual([label, true]);
    }, 120_000);
    test(`${label}: not abandoned at the default 2 s budget${quiet ? "" : " (skipped: the machine is busy)"}`, async () => {
      if (!quiet) return;
      const checks = await run(build(1));
      expect([label, abandoned(checks)]).toEqual([label, 0]);
    }, 180_000);
  }
});

// ── a control's own allowance: the pool being spent never hides a short swapped-digit cue ───────────────────────────────────────

describe("a short swapped-digit cue folds when the page's pool is spent", () => {
  const CUE = "S1gn 1n w1th G00g1e";
  const filler = (attr: string) => `<a href="${O}" ${attr}="${UNIT.repeat(1_778).slice(0, 16_000)}">x</a>`; // 16,000 characters
  const read = (body: string) => scanControls(doc(body)).controls.some((c) => c.labels.some((l) => l.includes("sign in with google")));
  const SWAPPED_TEXT = `<a href="${OFF}">${CUE}</a>`;
  const SWAPPED_ATTR = `<a href="${OFF}" aria-label="${CUE}"><svg></svg></a>`;

  test("200 attribute fillers (3.2 million characters, over the 2 million pool), then the cue in a text and in an attribute, before or after", () => {
    for (const attr of ["aria-label", "title"]) {
      const fillers = Array.from({ length: 200 }, () => filler(attr)).join("");
      expect([attr, "text after", read(fillers + SWAPPED_TEXT)]).toEqual([attr, "text after", true]);
      expect([attr, "attribute after", read(fillers + SWAPPED_ATTR)]).toEqual([attr, "attribute after", true]);
      expect([attr, "text before", read(SWAPPED_TEXT + fillers)]).toEqual([attr, "text before", true]);
      expect([attr, "attribute before", read(SWAPPED_ATTR + fillers)]).toEqual([attr, "attribute before", true]);
    }
  }, 120_000);

  test("with the pool at zero the short cue still folds, and a cue past the control's own 300 characters does not and is counted", () => {
    attributeLimits.fold = 0;
    expect(read(SWAPPED_TEXT)).toBe(true);
    expect(read(SWAPPED_ATTR)).toBe(true);
    const late = (cue: string) => `${"lorem ".repeat(60)}${cue}`; // 360 characters before the cue
    const lateText = `<a href="${OFF}">${late(CUE)}</a>`;
    const lateAttr = `<a href="${OFF}" aria-label="${late(CUE)}"><svg></svg></a>`;
    expect(read(lateText)).toBe(false);
    expect(read(lateAttr)).toBe(false);
    expect(scanControls(doc(lateText)).unread).toBe(1);
    expect(scanControls(doc(lateAttr)).unread).toBe(1);
    // a longer label with the cue inside its first 300 characters: the head folds (the cue is found) and the control is counted
    const longer = `${CUE} ${"lorem ".repeat(60)}`;
    expect(read(`<a href="${OFF}">${longer}</a>`)).toBe(true);
    expect(read(`<a href="${OFF}" aria-label="${longer}"><svg></svg></a>`)).toBe(true);
    expect(scanControls(doc(`<a href="${OFF}">${longer}</a>`)).unread).toBe(1);
  });

  test("the label as written is kept whatever the pool: the plain cue is found with the pool at zero, in a text and in an attribute", () => {
    attributeLimits.fold = 0;
    const digits = "1a1b1c1d ".repeat(50);
    expect(read(`<a href="${OFF}">${digits} Sign in with Google</a>`)).toBe(true);
    expect(read(`<a href="${OFF}" aria-label="${digits} Sign in with Google"><svg></svg></a>`)).toBe(true);
  });

  test("an exact fit: a text and an attribute of 400 characters need 100 from the pool; 100 folds the cue at 350, 99 does not", () => {
    const body = (cue: string) => `${"lorem ".repeat(55)}${cue} ${"z".repeat(400 - 330 - cue.length - 1)}`;
    const text = `<a href="${OFF}">${body("S1gn 1n w1th G00g1e")}</a>`;
    expect(body("S1gn 1n w1th G00g1e").length).toBe(400);
    attributeLimits.fold = 100;
    expect(read(text)).toBe(true);
    expect(scanControls(doc(text)).unread).toBe(0);
    attributeLimits.fold = 99;
    expect(read(text)).toBe(false);
    expect(scanControls(doc(text)).unread).toBe(1);
    const attr = `<a href="${OFF}" aria-label="${body("S1gn 1n w1th G00g1e")}"><svg></svg></a>`;
    attributeLimits.fold = 100;
    expect(read(attr)).toBe(true);
    attributeLimits.fold = 99;
    expect(read(attr)).toBe(false);
  });

  test("a control's allowance is shared by its attributes: the second attribute gets what the first left", () => {
    attributeLimits.fold = 0;
    const first = "1a1b1c1d ".repeat(22); // 198 characters
    const second = `${"lorem ".repeat(25)}${CUE}`; // the cue starts at 150, 100 characters into the 102 left
    const html = `<a href="${OFF}" aria-label="${first}" title="${second}"><svg></svg></a>`;
    expect(read(html)).toBe(false);
    expect(scanControls(doc(html)).unread).toBe(1);
    // alone, the second attribute has the whole allowance
    expect(read(`<a href="${OFF}" title="${second}"><svg></svg></a>`)).toBe(true);
  });

  test("a control's second text reading keeps the plain cue when the allowance and the pool are spent", () => {
    attributeLimits.fold = 0;
    const digits = "1a1b1c1d ".repeat(34); // 306 characters, folded to the allowance of 300 in the first reading
    // the visible-only reading is the only one where Sign in with Google is not split by the hidden word
    const html = `<a href="${OFF}">${digits}Sign in <span style="display:none">x</span>with Google</a>`;
    expect(read(html)).toBe(true);
  });
});
