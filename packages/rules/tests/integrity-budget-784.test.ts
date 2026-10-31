import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
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
  // The note names templates, not controls, as what was left unread.
  const note = full.checks.find((c) => c.details?.scanTruncated === true);
  expect(Number(note?.details?.templatesUnread)).toBeGreaterThan(0);
  expect(String((note as { message?: string } | undefined)?.message)).toContain("template");
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

test("20,000 unclosed anchors nest in each other; both rules finish at the default budget and the innermost real control is found", async () => {
  const { checks } = await run(`${'<a href="https://p.invalid/x">x'.repeat(20_000)}${REAL}`);
  expect(finished(checks)).toBe(true);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 180_000);
