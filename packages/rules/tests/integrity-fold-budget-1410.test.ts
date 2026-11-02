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
const UNIT = "1a1b1c1d "; // a token with four 1s: tried sixteen ways

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
    attributeLimits.fold = 9_000; // ten labels
    const scan = scanControls(doc(links));
    expect(scan.unread).toBe(290);
    attributeLimits.fold = defaults.fold;
    expect(scanControls(doc(links)).unread).toBe(0);
  });

  test("an attribute is charged to the same budget: past it the attribute is read as written and the control is counted", () => {
    const links = Array.from({ length: 50 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${UNIT.repeat(20)}">x</a>`).join(""); // 180 characters each
    attributeLimits.fold = 900; // five attributes
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
