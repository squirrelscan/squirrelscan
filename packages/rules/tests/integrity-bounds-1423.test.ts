// #1423: the integrity rules' remaining bounds give a signal or are read: a style attribute past 8 KB, a CSS rule past 4,000
// characters (body) or 300 (selector), and a `<base href>` that moves where relative links resolve.

import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { detectBrandImpersonation, detectFakeAuthOverlay } from "../src/integrity/signals";
import type { RuleContext } from "../src/types";
import { OFF, run } from "./integrity-budget-fixture";

const url = "https://example.com/";
function context(body: string, head = ""): RuleContext {
  const html = `<!doctype html><html><head><title>Fixture</title>${head}</head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
  const parsed = parsePage(html, url);
  return { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} };
}
const brand = (body: string, head = ""): string | null => detectBrandImpersonation(context(body, head))?.brand ?? null;
const details = (checks: Array<{ name?: string; details?: Record<string, unknown> }>, name: string) => checks.find((c) => c.name === name)?.details;

const GEOM = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999";

// ── a style attribute past 8,192 characters ─────────────────────────────────────────────────────────────────────────────

test("a hidden decoy after more than 8,192 characters of style attribute is still read as hidden", () => {
  const filler = "a:b;".repeat(2_500); // 10,000 characters
  const link = (style: string) => `<a href="${OFF}">Sign in with <span style="${style}">x</span>Google</a>`;
  expect(brand(link(`${filler}display:none`))).toBe("Google");
  expect(brand(link(`${filler}visibility:hidden`))).toBe("Google");
  expect(brand(link(`${filler}font-size:0`))).toBe("Google");
  expect(brand(link(`${filler}opacity:0`))).toBe("Google");
  // a visible decoy at that offset stays visible: the phrase is broken for the reader, and for the rule
  expect(brand(link(`${filler}color:red`))).toBeNull();
});

test("a style attribute past 1 MB reports the control as not read in full, and the read stays fast on hostile styles", async () => {
  const huge = `${"a:b;".repeat(280_000)}display:none`;
  const started = performance.now();
  const { checks } = await run(`<a href="${OFF}" aria-label="Sign in">Sign in with <span style="${huge}">x</span>Google</a>`);
  expect(details(checks, "brand-impersonation")).toMatchObject({ scanTruncated: true, controlsUnread: 1 });
  // semicolons followed by long runs of spaces, and a megabyte of separators: linear
  for (const style of [`;${" ".repeat(900_000)}display:none`, ";".repeat(900_000), `${"; ".repeat(400_000)}display:none`]) {
    await run(`<a href="${OFF}">Sign in with <span style="${style}">x</span>Google</a>`);
  }
  expect(performance.now() - started).toBeLessThan(15_000);
}, 60_000);

test("one huge style attribute inside many nested controls is judged once", async () => {
  const huge = `${"a:b;".repeat(200_000)}display:none`;
  const nested = `${'<div role="button" aria-label="Sign in">'.repeat(300)}<span style="${huge}">x</span>${"</div>".repeat(300)}`;
  const started = performance.now();
  await run(`<a href="${OFF}">${nested}</a>`);
  expect(performance.now() - started).toBeLessThan(10_000);
}, 60_000);

// ── a CSS rule past 4,000 characters (body) or 300 (selector) ─────────────────────────────────────────────────────────

const overlayFrame = '<iframe id="google-auth" class="cover" srcdoc=""></iframe>';

test("a rule with a padded body (4,100 characters) is read for the overlay geometry", () => {
  const pad = `--p:${"a".repeat(4_100)};`;
  const head = `<style>.cover{${pad}${GEOM}}</style>`;
  expect(detectFakeAuthOverlay(context(overlayFrame, head))).not.toBeNull();
  const id = `<style>#google-auth{${pad}${GEOM}}</style>`;
  expect(detectFakeAuthOverlay(context(overlayFrame, id))).not.toBeNull();
});

test("a selector of 300 to 2,048 characters is read", () => {
  const selector = `iframe${".cover".repeat(200)}`; // 1,206 characters
  expect(detectFakeAuthOverlay(context(overlayFrame, `<style>${selector}{${GEOM}}</style>`))).not.toBeNull();
});

test("a rule past the bounds that could match an iframe on the page makes the CSS truncated, a rule for something else does not", async () => {
  const bigBody = `--p:${"a".repeat(300_000)};`;
  const bigSelector = `iframe${".cover".repeat(500)}`; // 3,006 characters
  for (const head of [`<style>.cover{${bigBody}${GEOM}}</style>`, `<style>#google-auth{${bigBody}${GEOM}}</style>`, `<style>${bigSelector}{${GEOM}}</style>`]) {
    const { checks } = await run(overlayFrame, head);
    expect(details(checks, "fake-auth-overlay")?.cssTruncated, head.slice(0, 40)).toBe(true);
  }
  // an oversized rule for another element is not a signal
  const other = await run(overlayFrame, `<style>.other{${bigBody}${GEOM}}</style>`);
  expect(details(other.checks, "fake-auth-overlay")?.cssTruncated).toBeUndefined();
  // a rule in range is read and gives no signal
  const small = await run(overlayFrame, `<style>.cover{${GEOM}}</style>`);
  expect(details(small.checks, "fake-auth-overlay")?.cssTruncated).toBeUndefined();
}, 60_000);

// ── <base href> ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("a link resolved against a <base href> on another host is judged by that host", () => {
  const base = '<base href="https://evil.example/">';
  expect(brand('<a href="/signin">Sign in with Google</a>', base)).toBe("Google");
  expect(brand('<a href="signin">Sign in with Google</a>', base)).toBe("Google");
  expect(brand('<a href="../x/login" aria-label="Sign in with Google"><svg></svg></a>', base)).toBe("Google");
  expect(brand('<form action="/login" method="post"><button>Continue with Google</button></form>', base)).toBe("Google");
  expect(brand('<form method="post"><button formaction="/go">Sign in with Google</button></form>', base)).toBe("Google");
  // without the base, or with one that stays on the site, the same links are the site's own
  expect(brand('<a href="/signin">Sign in with Google</a>')).toBeNull();
  for (const own of ['<base href="/app/">', '<base href="https://example.com/app/">', '<base href="https://www.example.com/">', "<base target=_blank>", '<base href="data:text/html,x">', '<base href="javascript:void(0)">']) {
    expect([own, brand('<a href="/signin">Sign in with Google</a>', own)]).toEqual([own, null]);
  }
});

test("the first <base href> is the one a browser uses; an empty form action goes to the page, not to the base", () => {
  const link = '<a href="/signin">Sign in with Google</a>';
  expect(brand(link, '<base href="https://evil.example/"><base href="https://example.com/">')).toBe("Google");
  expect(brand(link, '<base href="https://example.com/"><base href="https://evil.example/">')).toBeNull();
  expect(brand('<form method="post"><button>Sign in with Google</button></form>', '<base href="https://evil.example/">')).toBeNull();
});

test("a relative iframe src resolves against the base too", () => {
  const frame = `<iframe src="/frame" style="${GEOM}"></iframe>`;
  const auth = '<form><input type="password"></form>';
  const base = '<base href="https://evil.example/">';
  expect(detectFakeAuthOverlay(context(`${auth}${frame}`, base))).not.toBeNull();
  expect(detectFakeAuthOverlay(context(`${auth}${frame}`))).toBeNull();
});

test("a plainly local link with no cue attribute is read when a <base href> moves the site", async () => {
  // with the base the label is the only cue and the link is not the site's own: found; without it the link is skipped unread
  const link = '<a href="/signin">Sign in with Google</a>';
  const moved = await run(link, '<base href="https://evil.example/">');
  expect(moved.checks.some((c) => c.name === "brand-impersonation" && c.details?.brand === "Google")).toBe(true);
  const own = await run(link);
  expect(own.checks.some((c) => c.name === "brand-impersonation" && c.details?.brand === "Google")).toBe(false);
}, 60_000);
