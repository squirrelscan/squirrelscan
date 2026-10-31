import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
import { integrityLimits } from "../src/integrity/controls";
import { RuleRunner } from "../src/runner";

// #784: the integrity rules against hostile pages at the REAL default rule budget (2 s), through the rule
// runner. A slow scan is abandoned ("Not checked") and the real control or overlay goes unseen, so each
// case asserts both that the rule finished (the budget is the time bound: a run past it is reported as skipped) and
// that it found what a clean page of the same shape would.

const url = "https://example.com/";
const OFF = "https://credential-fixture.invalid/signin";
const REAL = `<a href="${OFF}">Sign in with Google</a>`;
const OVERLAY = '<iframe id="google-auth" srcdoc="" style="position:fixed;inset:0;z-index:9999"></iframe>';
const RULES = ["integrity/brand-impersonation", "integrity/fake-auth-overlay"];

type Check = { name?: string; status?: string; details?: Record<string, unknown> };

async function run(body: string, head = ""): Promise<{ ms: number; checks: Check[] }> {
  const html = `<!doctype html><html><head><title>Fixture</title>${head}</head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
  const parsed = parsePage(html, url);
  const runner = new RuleRunner({ config: { rule_options: {}, rules: { enable: RULES } } as never });
  const started = performance.now();
  const result = await runner.runPageRules({ url, html, statusCode: 200, loadTime: 0, headers: {}, parsed } as never);
  return { ms: performance.now() - started, checks: (result.checks ?? []) as Check[] };
}
const finished = (checks: Check[]): boolean => !checks.some((c) => /-error$|timeout/.test(c.name ?? "") || c.status === "skipped");
const fired = (checks: Check[], name: string): boolean =>
  checks.some((c) => c.name === name && c.status !== "skipped" && c.details?.scanTruncated !== true);

test("5 MB of plain links (333,000 controls) before the real control: both rules finish and find it", async () => {
  const { checks } = await run(`${'<a href="/">x</a>'.repeat(300_000)}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 120_000);

test("100 KB of templates nested in templates: no deep clone, both rules finish, a later control is found", async () => {
  const nested = "<template>".repeat(10_000);
  const { checks } = await run(`${nested}${"</template>".repeat(10_000)}<template>${REAL}</template>${OVERLAY}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
  expect(fired(checks, "fake-auth-overlay")).toBe(true);
}, 120_000);

test("400 aria-labelledby references to one 500 KB target are read once and bounded", async () => {
  const target = `<div id="big">${"<span>word </span>".repeat(30_000)}</div>`;
  const links = '<a href="https://p.invalid/" aria-labelledby="big big big big">x</a>'.repeat(400);
  const { checks } = await run(`${target}${links}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 120_000);

test("1,000 auth-named iframes with 500 shared classes and a unique one each: the overlay is still found", async () => {
  const shared = Array.from({ length: 500 }, (_, i) => `c${i}`);
  const css = shared.map((c) => `.${c}{border:0}`.repeat(200)).join("");
  const frames = Array.from({ length: 1_000 }, (_, i) => `<iframe class="auth ${shared.join(" ")} u${i}" srcdoc=""></iframe>`).join("");
  const { checks } = await run(`${frames}${OVERLAY}`, `<style>${css}</style>`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "fake-auth-overlay")).toBe(true);
}, 120_000);

test("a phrase squashed of its spaces needs its word boundaries: look-alike words do not read as a sign-in with Google", async () => {
  for (const label of ["Redesign in with Google Workspace", "Catalogin with Google", "Login with GoogleMail"]) {
    const { checks } = await run(`<p>Welcome</p><a href="${OFF}">${label}</a>`);
    expect(fired(checks, "brand-impersonation")).toBe(false);
  }
  const split = await run(`<a href="${OFF}">Sign<br>in with Goo<i>gle</i></a>`);
  expect(fired(split.checks, "brand-impersonation")).toBe(true);
});

// ── pruning must not be a silent bypass (round 3): found, or reported ───────────

const noted = (checks: Check[]): boolean => checks.some((c) => c.details?.scanTruncated === true);
const foundOrNoted = (checks: Check[], name: string): boolean => fired(checks, name) || noted(checks);

test("a tab or newline inside an own-site looking destination is the off-site URL it resolves to", async () => {
  for (const href of ["/&#9;/credential-fixture.invalid/signin", "/&#10;/credential-fixture.invalid/signin", "&#9;//credential-fixture.invalid/signin"]) {
    const link = await run(`<a href="${href}">Sign in with Google</a>`);
    expect(fired(link.checks, "brand-impersonation")).toBe(true);
    const button = await run(`<form><button formaction="${href}">Sign in with Google</button></form>`);
    expect(fired(button.checks, "brand-impersonation")).toBe(true);
    const form = await run(`<form action="${href}"><button>Sign in with Google</button></form>`);
    expect(fired(form.checks, "brand-impersonation")).toBe(true);
  }
}, 120_000);

test("5,001 empty templates do not use up the template bound; 5,001 real ones are reported when they do", async () => {
  const empty = await run(`${"<template></template>".repeat(5_001)}<template>${REAL}</template>`);
  expect(fired(empty.checks, "brand-impersonation")).toBe(true);
  const full = await run(`${"<template><b>x</b></template>".repeat(5_001)}<template>${REAL}</template>`);
  expect(foundOrNoted(full.checks, "brand-impersonation")).toBe(true);
  // The note names templates, not controls, as what was left unread: 5,000 are read, so one more than that is one cut.
  const one = await run(`${"<template><b>x</b></template>".repeat(5_000)}<template>${REAL}</template>`);
  const note = one.checks.find((c) => c.details?.scanTruncated === true) as { message?: string; details?: Record<string, unknown> } | undefined;
  expect(note?.details?.templatesUnread).toBe(1);
  expect(note?.details?.controlsUnread).toBeUndefined();
  expect(note?.message).toBe(
    "1 <template> element was past the template limit and not read (scan work limit); no brand impersonation was found in what was read",
  );
  const several = await run(`${"<template><b>x</b></template>".repeat(5_002)}<template>${REAL}</template>`);
  const many = several.checks.find((c) => c.details?.scanTruncated === true) as { message?: string; details?: Record<string, unknown> } | undefined;
  expect(many?.details?.templatesUnread).toBe(3);
  expect(many?.message).toContain("3 <template> elements were past the template limit and not read");
}, 120_000);

test("an overlay whose geometry is on a ninth class, or after 1,000 padding classes, is found", async () => {
  const decoys = Array.from({ length: 8 }, (_, i) => `.d${i}{z-index:1}`).join("");
  const css = `${decoys}.cover{position:fixed;inset:0;z-index:9999}`;
  const ninth = await run('<iframe class="auth d0 d1 d2 d3 d4 d5 d6 d7 cover" srcdoc=""></iframe>', `<style>${css}</style>`);
  expect(fired(ninth.checks, "fake-auth-overlay")).toBe(true);
  const padding = Array.from({ length: 1_000 }, (_, i) => `p${i}`).join(" ");
  const padded = await run(`<iframe class="${padding} auth cover" srcdoc=""></iframe>`, `<style>${css}</style>`);
  expect(fired(padded.checks, "fake-auth-overlay")).toBe(true);
}, 120_000);

test("201 later iframe rules do not push the real overlay rule out; geometric ones that do are reported", async () => {
  const cover = ".cover{position:fixed;inset:0;z-index:9999}";
  const frame = '<iframe class="auth cover" srcdoc=""></iframe>';
  const harmless = await run(frame, `<style>${cover}${"iframe{border:0}".repeat(201)}</style>`);
  expect(fired(harmless.checks, "fake-auth-overlay")).toBe(true);
  const geometric = await run(frame, `<style>${cover}${"iframe{width:1px}".repeat(201)}</style>`);
  expect(foundOrNoted(geometric.checks, "fake-auth-overlay")).toBe(true);
}, 120_000);

test("a phrase split by markup with words around it is still the phrase", async () => {
  for (const label of ["Sign<br>in with Goo<i>gle</i> to continue", "Acme: Sign<br>in with Goo<i>gle</i>", "Sign<br>in with Goo<i>gle</i> to your Acme dashboard"]) {
    const { checks } = await run(`<a href="${OFF}">${label}</a>`);
    expect(fired(checks, "brand-impersonation")).toBe(true);
  }
}, 120_000);

test("padding an attribute label or listing a fifth aria-labelledby target is found or reported", async () => {
  const spaces = await run(`<a href="${OFF}" aria-label="${" ".repeat(400)}Sign in with Google">x</a>`);
  expect(fired(spaces.checks, "brand-impersonation")).toBe(true);
  const zero = await run(`<a href="${OFF}" aria-label="${"​".repeat(400)}Sign in with Google">x</a>`);
  expect(fired(zero.checks, "brand-impersonation")).toBe(true);
  const fifth = await run(`<span id="a">a</span><span id="b">b</span><span id="c">c</span><span id="d">d</span><span id="e">Sign in with Google</span><a href="${OFF}" aria-labelledby="a b c d e">x</a>`);
  expect(foundOrNoted(fifth.checks, "brand-impersonation")).toBe(true);
}, 120_000);

test("1,600 controls naming one 500 KB aria-labelledby target finish and find the real control", async () => {
  const target = `<div id="big">${"<span>word </span>".repeat(30_000)}</div>`;
  const links = '<a href="https://p.invalid/" aria-labelledby="big big big big">x</a>'.repeat(1_600);
  const { checks } = await run(`${target}${links}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 120_000);

test("30,000 cross-host decoys with children before the real control: the fair share finds it", async () => {
  const decoy = `<a href="https://p.invalid/x">${"<i></i>".repeat(20)}</a>`;
  const { checks } = await run(`${decoy.repeat(30_000)}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);

// Characterisation: this passes on main too; it pins the default-budget behaviour on nested anchors.
test("20,000 unclosed anchors nest in each other; both rules finish at the default budget and the innermost real control is found", async () => {
  const { checks } = await run(`${'<a href="https://p.invalid/x">x'.repeat(20_000)}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);

// ── long attribute labels: work is bounded per page, not per control (#1424) ─────────────────────────────────

const label16k = (i: number): string => Array.from({ length: 1_600 }, (_, j) => `sign in ${i}x${j}`).join(" ").slice(0, 16_000);
const padded = (before: number): string => `${"a".repeat(before)} Sign in with Google ${"b".repeat(50)}`;

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

test("300 controls with 16 KB U+FDFA labels finish at the default budget (runner level)", async () => {
  const hostile = Array.from({ length: 300 }, (_, i) => `<a href="https://p.invalid/${i}" aria-label="${"\ufdfa".repeat(16_000)}">x</a>`).join("");
  const { checks } = await run(`${hostile}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);

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
