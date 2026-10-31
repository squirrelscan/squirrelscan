import { expect, setDefaultTimeout, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
import { detectBrandImpersonation, detectFakeAuthOverlay, integrityScanNotes } from "../src/integrity/signals";
import { fakeAuthOverlayRule } from "../src/integrity/fake-auth-overlay";
import { RuleRunner } from "../src/runner";
import type { RuleContext } from "../src/types";

// Parsing megabytes of hostile markup is the slow part, not the detectors.
setDefaultTimeout(60_000);

// #784 hardening: the detectors against hostile pages. Time bounds are generous (seconds for megabytes of
// input where the work is milliseconds) so they fail on a quadratic scan, not on a slow runner.

const url = "https://example.com/";
const OFF = "https://credential-fixture.invalid/signin";
const OVERLAY = '<iframe id="google-auth" srcdoc="" style="position:fixed;inset:0;z-index:9999"></iframe>';

function context(body: string, head = ""): RuleContext {
  const html = `<!doctype html><html><head><title>Fixture</title>${head}</head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
  const parsed = parsePage(html, url);
  return { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} };
}
const time = (run: () => unknown): number => {
  const started = performance.now();
  run();
  return performance.now() - started;
};
const brand = (ctx: RuleContext) => detectBrandImpersonation(ctx)?.brand ?? null;

// ── the overlay scan stays linear in hostile CSS and markup ─────────────────

const CSS_CASES: Array<[string, string]> = [
  ["unterminated comment openers", "/*/*/*/*".repeat(500_000)],
  ["a run with no braces", "a".repeat(4_000_000)],
  ["selector openers", "a{".repeat(2_000_000)],
  ["nested unclosed at-rules", "@media x{".repeat(400_000)],
  ["closing braces", "}".repeat(4_000_000)],
  ["semicolons and colons", "a:b;".repeat(1_000_000)],
  ["long selector, no body", `${".x".repeat(1_000_000)}{`],
  ["!important soup", `.cover{x:${"! ".repeat(500_000)}}`],
];

for (const [name, junk] of CSS_CASES) {
  test(`CSS soup (${name}, ${(junk.length / 1e6).toFixed(1)} MB) is scanned in linear time and the overlay is still found`, () => {
    const ctx = context(OVERLAY, `<style>${junk}</style>`);
    const elapsed = time(() => {
      expect(detectFakeAuthOverlay(ctx)).not.toBeNull();
    });
    expect(elapsed).toBeLessThan(3_000);
  }, 30_000);
}

test("an inline style attribute of a megabyte of whitespace and bangs costs milliseconds", () => {
  const style = `position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;x:${" ".repeat(500_000)}!${" !".repeat(200_000)}`;
  const ctx = context(`<iframe id="google-auth" srcdoc="" style="${style}"></iframe>`);
  expect(time(() => detectFakeAuthOverlay(ctx))).toBeLessThan(3_000);
});

test("thousands of iframes with the same class and a big rule set are linear", () => {
  const rules = Array.from({ length: 4_000 }, (_, i) => `.f${i % 50}{border:0}`).join("");
  const frames = Array.from({ length: 3_000 }, (_, i) => `<iframe class="f${i % 50}" srcdoc=""></iframe>`).join("");
  const ctx = context(`${frames}${OVERLAY}`, `<style>${rules}</style>`);
  const elapsed = time(() => {
    expect(detectFakeAuthOverlay(ctx)).not.toBeNull();
  });
  expect(elapsed).toBeLessThan(5_000);
});

test("repeated anchor openers and attribute soup do not make the brand detector quadratic", () => {
  const build = (n: number) => context(`<a href="https://x.invalid/" title="${"y".repeat(50)}">`.repeat(n));
  const small = build(2_500);
  const big = build(10_000);
  brand(build(500)); // warm
  const t1 = Math.max(time(() => brand(small)), 5);
  const t2 = time(() => brand(big));
  // 4x the anchors: linear is about 4x, quadratic about 16x.
  expect(t2).toBeLessThan(t1 * 10 + 100);
});

// ── a cap on work must not be a cap on position ─────────────────────────────

test("the real sign-in control after 6,000 padding controls is still found", () => {
  const padding = Array.from({ length: 6_000 }, (_, i) => `<a href="/p/${i}">item ${i}</a>`).join("");
  expect(brand(context(`${padding}<a href="${OFF}">Sign in with Google</a>`))).toBe("Google");
});

test("padding that burns the full-read budget with long off-site labels does not hide a later control", () => {
  const long = "word ".repeat(1_000);
  const padding = Array.from({ length: 400 }, (_, i) => `<a href="https://other${i}.invalid/">${long}</a>`).join("");
  const ctx = context(`${padding}<a href="${OFF}">Sign in with Google</a>`);
  expect(brand(ctx)).toBe("Google");
});

test("a later control with the cue only in an attribute is found past a wall of text controls", () => {
  const padding = Array.from({ length: 8_000 }, (_, i) => `<a href="https://pad${i % 40}.invalid/x">link number ${i} with a label</a>`).join("");
  expect(brand(context(`${padding}<a href="${OFF}" aria-label="Continue with Google"><svg></svg></a>`))).toBe("Google");
});

test("the overlay rule is not pushed out by CSS or iframes placed before it", () => {
  const junk = ".other{color:red}".repeat(150_000); // 2.5 MB of rules for other elements
  expect(detectFakeAuthOverlay(context(OVERLAY, `<style>${junk}</style>`))).not.toBeNull();
  const benign = '<iframe title="x" srcdoc=""></iframe>'.repeat(4_000);
  expect(detectFakeAuthOverlay(context(`${benign}${OVERLAY}`))).not.toBeNull();
  const cls = '<iframe class="cover" id="google-auth" srcdoc=""></iframe>';
  const rule = ".cover{position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999}";
  expect(detectFakeAuthOverlay(context(cls, `<style>${junk}${rule}</style>`))).not.toBeNull();
});

test("CSS beyond the amount read is reported, not silently passed", () => {
  const junk = "x{y:z}".repeat(1_000_000); // 6 MB
  const ctx = context('<iframe class="cover" id="google-auth" srcdoc=""></iframe>', `<style>${junk}.cover{position:fixed;inset:0;z-index:99999}</style>`);
  expect(integrityScanNotes(ctx).cssTruncated).toBe(true);
});

// ── look-alike letters ──────────────────────────────────────────────────────

test("look-alike forms of the cue are matched: small capitals, accents, Armenian, mathematical letters", () => {
  const labels = [
    "ꜱɪɢɴ ɪɴ ᴡɪᴛʜ ɢᴏᴏɢʟᴇ",
    "Sïgn ïn wïth Gööglé",
    "Sign in with Gօօgle",
    "𝐒𝐢𝐠𝐧 𝐢𝐧 𝐰𝐢𝐭𝐡 𝐆𝐨𝐨𝐠𝐥𝐞",
    "Sign​ in⁠ with­ Goo‍gle",
  ];
  for (const label of labels) expect(brand(context(`<a href="${OFF}">${label}</a>`)), label).toBe("Google");
});

// ── what the report may carry ───────────────────────────────────────────────

test("the overlay reason carries no userinfo, query token or fragment of the iframe's source, and a sanitised id", () => {
  // Built from parts so the secret scanner does not flag the fixture.
  const userinfo = ["user", "pw"].join(":");
  const src = `https://${userinfo}@host.invalid/login?token=SECRETVALUE#frag`;
  const ctx = context(`<iframe id="google-auth&#27;[31m" src="${src}" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999"></iframe>`);
  const check = fakeAuthOverlayRule.run(ctx).checks[0];
  const text = JSON.stringify(check);
  for (const secret of ["SECRETVALUE", "pw", "frag", "user:", "\u001b"]) expect(text, secret).not.toContain(secret);
  expect(check?.value).toContain("https://host.invalid/login");
});

// ── through the rule runner, with its time budget, the way an audit runs them ─

const RUNNER_RULES = ["integrity/brand-impersonation", "integrity/fake-auth-overlay"];

async function runRules(body: string, head = "", budgetMs?: number) {
  const ctx = context(body, head);
  const runner = new RuleRunner({
    config: { rule_options: {}, rules: { enable: RUNNER_RULES } } as never,
    ...(budgetMs !== undefined ? { ruleTimeBudgetMs: budgetMs } : {}),
  });
  const started = performance.now();
  const result = await runner.runPageRules({ url, html: ctx.page.html, statusCode: 200, loadTime: 0, headers: {}, parsed: ctx.parsed } as never);
  return { ms: performance.now() - started, checks: (result.checks ?? []) as Array<{ name?: string; status?: string; message?: string; details?: Record<string, unknown> }> };
}
/** A finding (alone it is `info`, with a second signal `fail`), not the truncation note. */
const fired = (checks: Array<{ name?: string; status?: string; details?: Record<string, unknown> }>, name: string) =>
  checks.some((c) => c.name === name && c.status !== "skipped" && c.details?.scanTruncated !== true);
const errored = (checks: Array<{ name?: string; status?: string }>) => checks.some((c) => /-error$|timeout/.test(c.name ?? "") || c.status === "skipped");

test("RuleRunner: 120 KB of combining marks in the page text and in a label cost milliseconds, and the real control is found", async () => {
  const marks = ("\u0300".repeat(40_000) + "\u0316".repeat(40_000) + "\u0334".repeat(40_000));
  const { ms, checks } = await runRules(`<p>x${marks}</p><a href="${OFF}">Sign in with Google${marks}</a>`);
  expect(ms).toBeLessThan(2_000);
  expect(errored(checks)).toBe(false);
  expect(fired(checks, "brand-impersonation")).toBe(true);
});

test("RuleRunner: 5,000 `iframe{}` rules and thousands of iframes stay linear and the overlay is found", async () => {
  const rules = "iframe{border:0}".repeat(5_000);
  const frames = '<iframe srcdoc=""></iframe>'.repeat(20_000);
  const { ms, checks } = await runRules(`${frames}${OVERLAY}`, `<style>${rules}</style>`);
  expect(ms).toBeLessThan(2_000);
  expect(errored(checks)).toBe(false);
  expect(fired(checks, "fake-auth-overlay")).toBe(true);
});

test("RuleRunner: 1.5 MB of node-heavy decoy buttons before the real control do not hide it", async () => {
  const heavy = `<button>${"<i></i>".repeat(2_000)}</button>`.repeat(25);
  const light = `<button>${"<i></i>".repeat(40)}</button>`.repeat(4_000);
  const { ms, checks } = await runRules(`${heavy}${light}<a href="${OFF}">Sign in with Google</a>`, "", 30_000);
  expect(ms).toBeLessThan(15_000);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 120_000);

test("RuleRunner: 3.5 MB of plain role=button decoys before the real control do not hide it", async () => {
  const decoys = '<b role="button">x</b>'.repeat(160_000);
  const { checks } = await runRules(`${decoys}<a href="${OFF}">Sign in with Google</a>`, "", 30_000);
  expect(fired(checks, "brand-impersonation")).toBe(true);
}, 120_000);

test("RuleRunner: a real control whose label is padded past the visit cap is reported as unread, not passed silently", async () => {
  const padded = `<a href="${OFF}">${"<i></i>".repeat(5_000)}Sign in with Google</a>`;
  const { checks } = await runRules(padded, "", 30_000);
  // Either the long read reached the text and fired, or the scan says it could not read the control.
  const brandCheck = checks.find((c) => c.name === "brand-impersonation");
  expect(brandCheck).toBeDefined();
  if (brandCheck?.status === "info" && brandCheck.details?.scanTruncated) {
    expect(Number(brandCheck.details.controlsUnread)).toBeGreaterThan(0);
  }
  // Beyond the long read's limits the note must appear.
  const wall = `<a href="${OFF}">${"<i></i>".repeat(20_000)}Sign in with Google</a>`;
  const out = await runRules(wall, "", 30_000);
  const note = out.checks.find((c) => c.name === "brand-impersonation");
  expect(note?.details?.scanTruncated).toBe(true);
}, 120_000);

test("RuleRunner: CSS longer than the amount read is reported on the overlay rule when nothing fired", async () => {
  const junk = "x{y:z}".repeat(1_000_000);
  const { checks } = await runRules('<iframe class="cover" id="google-auth" srcdoc=""></iframe>', `<style>${junk}.cover{position:fixed;inset:0;z-index:99999}</style>`, 30_000);
  const note = checks.find((c) => c.name === "fake-auth-overlay");
  expect(note?.status).toBe("info");
  expect(note?.details?.cssTruncated).toBe(true);
}, 120_000);

// ── total work, at 1, 2 and 5 MB, through the rule runner ───────────────────

const REAL = `<a href="${OFF}">Sign in with Google</a>`;
const FLOODS: Array<[string, number, (n: number) => string]> = [
  ["leaf role=button", 22, (n) => '<b role="button">x</b>'.repeat(n)],
  ["buttons in forms", 31, (n) => "<form><button>x</button></form>".repeat(n)],
  ["controls with 256 empty children", 1800, (n) => `<a href="https://p.invalid/x">${"<i></i>".repeat(256)}</a>`.repeat(n)],
  ["role=button nested in role=button", 18, (n) => '<b role="button">'.repeat(n) + "x"],
  ["controls under 200 wrappers", 20, (n) => `${"<div>".repeat(200)}${"<button>x</button>".repeat(n)}`],
  ["button form= references", 30, (n) => `${'<button form="f1">x</button>'.repeat(n)}<form id="f1" action="/a"></form>`],
  ["a template per control", 55, (n) => '<template><a href="https://p.invalid/">x</a></template>'.repeat(n)],
  ["aria-labelledby per control, a template each", 110, (n) => '<template><span id="s">x</span></template><a href="https://p.invalid/" aria-labelledby="s">y</a>'.repeat(n)],
  ["nested forms with form= and a template each", 90, (n) => '<form id="g"><template><form><button form="g">x</button></form></template></form>'.repeat(n)],
];

for (const [name, bytesPer, build] of FLOODS) {
  test(`total work is linear: ${name}, 0.5 MB and 1 MB before the real control (found, and doubling costs well under 6x)`, async () => {
    const at = (mb: number) => runRules(`${build(Math.floor((mb * 1e6) / bytesPer))}${REAL}`, "", 600_000);
    const one = await at(0.5);
    const two = await at(1);
    for (const run of [one, two]) {
      expect(fired(run.checks, "brand-impersonation")).toBe(true);
      expect(run.ms).toBeLessThan(15_000);
    }
    expect(two.ms).toBeLessThan(one.ms * 6 + 300);
  }, 180_000);
}

for (const [name, bytesPer, build] of FLOODS.filter(([n]) => /nested in|forms in|buttons in forms|template per/.test(n))) {
  test(`2 MB of ${name} before the real control is found in bounded time`, async () => {
    const run = await runRules(`${build(Math.floor(2e6 / bytesPer))}${REAL}`, "", 600_000);
    expect(fired(run.checks, "brand-impersonation")).toBe(true);
    expect(run.ms).toBeLessThan(30_000);
  }, 180_000);
}
