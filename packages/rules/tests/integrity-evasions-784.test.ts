import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
import { brandImpersonationRule } from "../src/integrity/brand-impersonation";
import { detectBrandImpersonation, detectFakeAuthOverlay, detectPageSignals } from "../src/integrity/signals";
import type { RuleContext } from "../src/types";

// #784: the brand and overlay detectors against the evasions the issue lists, and the false positives.

const url = "https://example.com/";
const OFF = "https://credential-fixture.invalid/signin";

function context(body: string, head = ""): RuleContext {
  const html = `<!doctype html><html><head><title>Fixture</title>${head}</head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
  const parsed = parsePage(html, url);
  return { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} };
}
const brand = (body: string, head = ""): string | null => detectBrandImpersonation(context(body, head))?.brand ?? null;

test("a button, an input and a label held only in an attribute are controls too", () => {
  const cases = [
    `<form action="${OFF}" method="post"><button type="submit">Sign in with Google</button></form>`,
    `<form action="${OFF}" method="post"><input type="submit" value="Sign in with Google"></form>`,
    `<form method="post"><button formaction="${OFF}">Continue with Google</button></form>`,
    `<a href="${OFF}" aria-label="Sign in with Google"><svg width="20" height="20"></svg></a>`,
    `<a href="${OFF}" title="Continue with Google"><svg width="20" height="20"></svg></a>`,
    `<a href="${OFF}"><img src="/g.png" alt="Sign in with Google"></a>`,
  ];
  for (const html of cases) expect(brand(html), html).toBe("Google");
});

test("Continue with Google and Log in with Google are Google's wording, and a Microsoft pair", () => {
  expect(brand(`<a href="${OFF}">Continue with Google</a>`)).toBe("Google");
  expect(brand(`<a href="${OFF}">Log in with Google</a>`)).toBe("Google");
  expect(brand(`<a href="${OFF}">Continue with Microsoft</a>`)).toBe("Microsoft");
});

test("the same controls aimed at the brand or at the site itself are not impersonation", () => {
  expect(brand(`<a href="https://accounts.google.com/o/oauth2/auth" aria-label="Sign in with Google"></a>`)).toBeNull();
  expect(brand(`<form action="/auth/google" method="post"><button>Continue with Google</button></form>`)).toBeNull();
  expect(brand(`<form action="https://app.example.com/login" method="post"><input type="submit" value="Sign in with Google"></form>`)).toBeNull();
  // A button with no form and no formaction has no destination to judge.
  expect(brand(`<button type="button">Sign in with Google</button>`)).toBeNull();
});

test("a label in Cyrillic look-alikes or fullwidth letters is matched after normalisation", () => {
  // "Sign in with Google" with Cyrillic ѕ і і о о and Greek ο mixed in.
  expect(brand(`<a href="${OFF}">Ѕign іn wіth Gоοgle</a>`)).toBe("Google");
  expect(brand(`<a href="${OFF}">Ｓｉｇｎ ｉｎ ｗｉｔｈ Ｇｏｏｇｌｅ</a>`)).toBe("Google");
  expect(brand(`<a href="${OFF}" aria-label="Ｓign in with Gооgle"></a>`)).toBe("Google");
});

test("a broker's authorize endpoint is not impersonation for Google or Microsoft; the three Microsoft hosts are legitimate", () => {
  for (const host of [
    "https://tenant.auth0.com/authorize?client_id=x",
    "https://tenant.okta.com/oauth2/v1/authorize?client_id=x",
    "https://tenant.okta.com/oauth2/default/v1/authorize?client_id=x",
    "https://tenant.oktapreview.com/oauth2/v1/authorize",
    "https://tenant.auth.eu-west-1.amazoncognito.com/oauth2/authorize?client_id=x",
    "https://project.supabase.co/auth/v1/authorize?provider=google",
    "https://project.firebaseapp.com/__/auth/handler",
  ]) {
    expect(brand(`<a href="${host}">Sign in with Google</a>`), host).toBeNull();
  }
  for (const host of ["https://login.windows.net/common/oauth2/authorize", "https://login.microsoftonline.us/common/oauth2/v2.0/authorize", "https://tenant.b2clogin.com/tenant.onmicrosoft.com/oauth2/v2.0/authorize"]) {
    expect(brand(`<a href="${host}">Sign in with Microsoft</a>`), host).toBeNull();
  }
  // A look-alike that merely contains a broker name is still off-brand.
  expect(brand(`<a href="https://auth0.com.credential-fixture.invalid/authorize">Sign in with Google</a>`)).toBe("Google");
});

test("a broker host alone proves nothing: other paths, other brands and open-registration tenants are still flagged", () => {
  for (const host of [
    "https://evil.supabase.co/functions/v1/collect",
    "https://evil.auth0.com/login",
    "https://evil.okta.com/login/login.htm",
    "https://evil.firebaseapp.com/index.html",
    "https://evil.amazoncognito.com/login",
  ]) {
    expect(brand(`<a href="${host}">Sign in with Google</a>`), host).toBe("Google");
  }
  // A brand a broker does not federate is never spared by one.
  expect(brand(`<a href="https://evil.supabase.co/auth/v1/authorize">Sign in with Calendly</a>`)).toBe("Calendly");
});

test("hidden text spliced into the label does not hide it; a <template> is read", () => {
  expect(brand(`<a href="${OFF}">Sign in with <span style="display:none">x</span>Google</a>`)).toBe("Google");
  expect(brand(`<a href="${OFF}">Sign<span style="display:none">x</span> in with Google</a>`)).toBe("Google");
  expect(brand(`<template><a href="${OFF}">Sign in with Google</a></template>`)).toBe("Google");
});

const frame = (attrs: string) => `<iframe id="google-auth" srcdoc="" ${attrs}></iframe>`;

test("overlay geometry from !important, inset and a class is detected", () => {
  const cases = [
    [frame('style="position:fixed !important;top:0;left:0;width:100vw;height:100vh;z-index:9999"'), ""],
    [frame('style="position:fixed;inset:0;z-index:9999"'), ""],
    [frame('style="position:fixed;inset:0px;width:100%;height:100%;z-index:9999"'), ""],
    [frame('class="cover"'), "<style>.cover{position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999}</style>"],
    [frame('class="a b"'), "<style>iframe.b { position: fixed; inset: 0; z-index: 2147483647 }</style>"],
    [frame('style="position:fixed;top:0;left:0;width:100%;height:100%"'), "<style>#google-auth{z-index:5000!important}</style>"],
  ] as const;
  for (const [html, head] of cases) {
    expect(detectFakeAuthOverlay(context(html, head)), html + head)?.not.toBeNull();
  }
});

test("a fixed iframe that is not a viewport cover, or whose rule is for another element, is not an overlay", () => {
  const nots = [
    [frame('style="position:fixed;bottom:0;right:0;width:300px;height:200px;z-index:9999"'), ""],
    [frame('class="cover"'), "<style>.other{position:fixed;inset:0;z-index:9999}</style>"],
    [frame('class="cover"'), "<style>@media print{.cover{position:fixed;inset:0;z-index:9999}}</style>"],
    [frame('style="position:fixed;inset:0;z-index:10"'), ""],
  ] as const;
  for (const [html, head] of nots) expect(detectFakeAuthOverlay(context(html, head)), html + head).toBeNull();
});

test("two evasions together still escalate the way plain ones do", () => {
  const ctx = context(`${frame('style="position:fixed;inset:0;z-index:9999"')}<a href="${OFF}" aria-label="Sign in with Google"></a>`);
  expect([...detectPageSignals(ctx)].sort()).toEqual(["brand-impersonation", "fake-auth-overlay"]);
});

test("the brand detector is linear in the number of nested anchors (n, 2n, 4n)", () => {
  const timed = (n: number): number => {
    const ctx = context('<a href="https://x.invalid/">x'.repeat(n));
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      detectBrandImpersonation(ctx);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  const t1 = Math.max(timed(1_000), 3);
  const t2 = timed(2_000);
  const t4 = timed(4_000);
  // Linear: 4n costs about 4x n. Quadratic: 16x.
  expect(t2).toBeLessThan(t1 * 6 + 20);
  expect(t4).toBeLessThan(t1 * 9 + 40);
}, 60_000);

test("inset:0 with a size of its own is not a viewport cover; with no size it is", () => {
  const sized = frame('style="position:fixed;inset:0;width:300px;height:200px;z-index:9999"');
  expect(detectFakeAuthOverlay(context(sized))).toBeNull();
  const margins = frame('style="position:fixed;top:0;right:0;bottom:0;left:0;width:300px;z-index:9999"');
  expect(detectFakeAuthOverlay(context(margins))).toBeNull();
  expect(detectFakeAuthOverlay(context(frame('style="position:fixed;inset:0;z-index:9999"')))).not.toBeNull();
});

test("markup spliced into a label does not hide it: script, style, noscript, a break, an inline element", () => {
  const cases = [
    `Sign<script>0</script> in with Google`,
    `Sign<style>a{}</style> in with Google`,
    `Sign<noscript>x</noscript> in with Google`,
    `Sign<br>in with Goo<i>gle</i>`,
    `S<b>i</b>gn <span>in</span> w<u>ith</u> Go<b>o</b>gle`,
  ];
  for (const label of cases) expect(brand(`<a href="${OFF}">${label}</a>`), label).toBe("Google");
});

test("text hidden by font size, opacity, aria-hidden or a class does not hide the label either", () => {
  const cases: Array<[string, string]> = [
    [`Sign<span style="font-size:0">x</span> in with Google`, ""],
    [`Sign<span style="opacity:0">x</span> in with Google`, ""],
    [`Sign<span aria-hidden="true">x</span> in with Google`, ""],
    [`Sign<span class="gone">x</span> in with Google`, "<style>.gone{display:none}</style>"],
    [`Sign<span style="visibility:hidden">x</span> in with Google`, ""],
  ];
  for (const [label, head] of cases) expect(brand(`<a href="${OFF}">${label}</a>`, head), label).toBe("Google");
});

test("a control nested deeper than the old climb limits is still found: a button far inside its form, a logo far inside its link, form=", () => {
  const deep = (inner: string, levels: number) => `${"<div>".repeat(levels)}${inner}${"</div>".repeat(levels)}`;
  expect(brand(`<form action="${OFF}" method="post">${deep("<button>Sign in with Google</button>", 30)}</form>`)).toBe("Google");
  expect(brand(`<a href="${OFF}">${deep('<img alt="Sign in with Google" src="/g.png">', 30)}</a>`)).toBe("Google");
  expect(brand(`<form id="f1" action="${OFF}" method="post"></form><button form="f1">Continue with Google</button>`)).toBe("Google");
  expect(brand(`<span id="lbl">Sign in with Google</span><a href="${OFF}" aria-labelledby="lbl"><svg></svg></a>`)).toBe("Google");
});

test("controls in the 25th template, in a template inside a template, and after 500 logos are read", () => {
  const filler = Array.from({ length: 24 }, () => "<template><p>x</p></template>").join("");
  expect(brand(`${filler}<template><a href="${OFF}">Sign in with Google</a></template>`)).toBe("Google");
  expect(brand(`<template><template><a href="${OFF}">Sign in with Google</a></template></template>`)).toBe("Google");
  const logos = Array.from({ length: 500 }, (_, i) => `<img alt="logo ${i}" src="/l.png">`).join("");
  expect(brand(`${logos}<a href="${OFF}"><img alt="Sign in with Google" src="/g.png"></a>`)).toBe("Google");
});

// ── long attribute labels are read in overlapping windows (#1424) ───────────

const PHRASE = "Sign in with Google";
/** The control for each attribute that can carry a label, with `label` as its value. */
const ATTRIBUTE_CONTROLS: Array<[string, (label: string) => string]> = [
  ["aria-label", (label) => `<a href="${OFF}" aria-label="${label}"><svg></svg></a>`],
  ["title", (label) => `<a href="${OFF}" title="${label}"><svg></svg></a>`],
  ["value", (label) => `<form action="${OFF}"><input type="submit" value="${label}"></form>`],
  ["logo alt", (label) => `<a href="${OFF}"><img src="/g.png" alt="${label}"></a>`],
];
/** A label with the phrase after `before` real characters and followed by `after` more. */
const padded = (before: number, after: number): string => `${"a".repeat(before)} ${PHRASE} ${"b".repeat(after)}`;

test.each(ATTRIBUTE_CONTROLS)("%s: the phrase with real padding on both sides is read at every offset", (_attribute, control) => {
  // 0..420 sampled densely around the old head/tail seams (131..280) and the window boundaries (multiples of 100).
  const offsets = [0, 1, 50, 99, 100, 101, 130, 131, 149, 150, 151, 200, 250, 279, 280, 281, 299, 300, 301, 350, 399, 400, 420];
  for (const before of offsets) {
    expect(brand(control(padded(before, 400))), `${before} characters before`).toBe("Google");
    expect(brand(control(padded(400, before))), `${before} characters after`).toBe("Google");
  }
});

test.each(ATTRIBUTE_CONTROLS)("%s: a phrase spanning a window boundary is read, and so is one deep in a long label", (_attribute, control) => {
  // The phrase starts at 290 (inside the first window's end) and at 5,000 (the 50th window).
  for (const before of [285, 290, 295, 1_000, 5_000, 15_900]) {
    expect(brand(control(padded(before, 100))), `${before}`).toBe("Google");
  }
});

test("a long label made of many words is read through, wherever the phrase falls among them", () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
  for (const at of [3, 40, 41, 90, 140, 250, 399]) {
    const label = [...words.slice(0, at), PHRASE, ...words.slice(at)].join(" ");
    expect(brand(`<a href="${OFF}" aria-label="${label}"><svg></svg></a>`), `after ${at} words`).toBe("Google");
  }
});

test("a label that merely contains the pieces of a phrase across a window seam is not that phrase", () => {
  // "Redesign in with Google" must not become "sign in with Google" because a window starts inside "Redesign".
  for (const before of [95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 195, 196, 197, 198, 199, 200, 201, 202, 203]) {
    const label = `${"a".repeat(before)} Redesign in with Google Workspace ${"b".repeat(200)}`;
    expect(brand(`<a href="${OFF}" aria-label="${label}"><svg></svg></a>`), `${before}`).toBeNull();
  }
});

test("an ordinary long title or alt does not raise the unread note", async () => {
  const sentence = "Our award winning team of designers and developers builds fast, accessible websites for clients. ";
  for (const label of [sentence.repeat(7), sentence.repeat(60)]) {
    for (const [, control] of ATTRIBUTE_CONTROLS) {
      const result = await brandImpersonationRule.run(context(control(label)));
      expect(result.checks).toEqual([]);
    }
  }
});

test("only an attribute past the 16,000 character bound is reported unread, and the phrase before it is still found", async () => {
  const unread = await brandImpersonationRule.run(context(`<a href="${OFF}" aria-label="${"a".repeat(17_000)}"><svg></svg></a>`));
  expect(unread.checks[0]?.status).toBe("info");
  expect(unread.checks[0]?.details).toMatchObject({ scanTruncated: true, controlsUnread: 1 });
  expect(brand(`<a href="${OFF}" aria-label="${padded(300, 17_000)}"><svg></svg></a>`)).toBe("Google");
  // A label whose NORMALISED text is past the bound (one character expands to many) is reported too.
  const expanding = await brandImpersonationRule.run(context(`<a href="${OFF}" aria-label="${"\ufdfa".repeat(2_000)}"><svg></svg></a>`));
  expect(expanding.checks[0]?.details).toMatchObject({ scanTruncated: true });
});
