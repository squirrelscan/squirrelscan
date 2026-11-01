import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
import { brandImpersonationRule } from "../src/integrity/brand-impersonation";
import { WINDOW_CUE, cuePattern } from "../src/integrity/controls";
import { AUTH_CUE_PHRASES, AUTH_LABEL, AUTH_LABEL_PHRASES, PROVIDER_BUTTON, PROVIDER_VERBS } from "../src/integrity/cues";
import { BRAND_SPECS } from "../src/integrity/brand-specs";
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

const PADDED_SIGN_IN = `${"a".repeat(400)} Sign in with Google`;

test.each([
  ["aria-label", `<a href="${OFF}" aria-label="${PADDED_SIGN_IN}"><svg></svg></a>`],
  ["title", `<a href="${OFF}" title="${PADDED_SIGN_IN}"><svg></svg></a>`],
  ["value", `<form action="${OFF}"><input type="submit" value="${PADDED_SIGN_IN}"></form>`],
  ["logo alt", `<a href="${OFF}"><img src="/g.png" alt="${PADDED_SIGN_IN}"></a>`],
])("a sign-in phrase past 300 real characters in %s is still read", (_attribute, html) => {
  expect(brand(html)).toBe("Google");
});

test("overlapping attribute windows find a phrase at every offset around their cuts", () => {
  for (let offset = 0; offset <= 420; offset++) {
    const label = `${"a".repeat(offset)} Sign in with Google ${"b".repeat(400)}`;
    expect(brand(`<a href="${OFF}" aria-label="${label}"><svg></svg></a>`), `offset ${offset}`).toBe("Google");
  }
  const expanded = `${"ﬃ".repeat(100)} Sign in with Google ${"b".repeat(400)}`;
  expect(brand(`<a href="${OFF}" aria-label="${expanded}"><svg></svg></a>`), "NFKC expansion at offset 300").toBe("Google");
});

test("a long ordinary title is not unread until the 16,000-character bound", async () => {
  const ordinary = await brandImpersonationRule.run(context(`<a href="${OFF}" title="${"a".repeat(400)}">Elsewhere</a>`));
  expect(ordinary.checks).toHaveLength(0);

  const bounded = await brandImpersonationRule.run(context(`<a href="${OFF}" title="${"a".repeat(16_001)}">Elsewhere</a>`));
  expect(bounded.checks).toHaveLength(1);
  expect(bounded.checks[0]?.details).toMatchObject({ scanTruncated: true, controlsUnread: 1 });
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

// ── long attribute labels: every offset, every attribute, the seams and the cue prefilter (#1424) ─────────────

const PHRASE = "Sign in with Google";
/** The control for each attribute that can carry a label, with `label` as its value. */
const ATTRIBUTE_CONTROLS: Array<[string, (label: string) => string]> = [
  ["aria-label", (label) => `<a href="${OFF}" aria-label="${label}"><svg></svg></a>`],
  ["title", (label) => `<a href="${OFF}" title="${label}"><svg></svg></a>`],
  ["value", (label) => `<form action="${OFF}"><input type="submit" value="${label}"></form>`],
  ["logo alt", (label) => `<a href="${OFF}"><img src="/g.png" alt="${label}"></a>`],
  ["input image alt", (label) => `<form action="${OFF}"><input type="image" src="/g.png" alt="${label}"></form>`],
];

test.each(ATTRIBUTE_CONTROLS)("%s: the phrase is read at every offset 0..460, with padding on both sides", (_attribute, control) => {
  for (let before = 0; before <= 460; before++) {
    expect(brand(control(`${"a".repeat(before)} ${PHRASE} ${"b".repeat(400)}`)), `${before} before`).toBe("Google");
    expect(brand(control(`${"a".repeat(400)} ${PHRASE} ${"b".repeat(before)}`)), `${before} after`).toBe("Google");
  }
});

test.each(ATTRIBUTE_CONTROLS)("%s: a phrase deep in a long label, and a split phrase across a window boundary", (_attribute, control) => {
  for (const before of [285, 290, 295, 1_000, 5_000, 15_900]) {
    expect(brand(control(`${"a".repeat(before)} ${PHRASE} ${"b".repeat(100)}`)), `${before}`).toBe("Google");
  }
});

test("look-alike words are not the phrase at any alignment of the padding", () => {
  // `Redesign in with Google Workspace` and `Login with GoogleMail` are the docs' own non-examples; a window cut
  // through `Redesign` must not read as `sign in with Google`.
  for (let before = 0; before <= 460; before++) {
    for (const words of ["Redesign in with Google Workspace", "Login with GoogleMail", "Plugin with Google"]) {
      const label = `${"a".repeat(before)} ${words} ${"b".repeat(300)}`;
      expect(brand(`<a href="${OFF}" aria-label="${label}"><svg></svg></a>`), `${words} after ${before}`).toBeNull();
    }
  }
});

test("a long label made of many words is read through, wherever the phrase falls among them", () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
  for (const at of [3, 40, 41, 90, 140, 250, 399]) {
    const label = [...words.slice(0, at), PHRASE, ...words.slice(at)].join(" ");
    expect(brand(`<a href="${OFF}" aria-label="${label}"><svg></svg></a>`), `after ${at} words`).toBe("Google");
  }
});

test("the cue prefilter holds every phrase the rules match (drift guard)", () => {
  const phrases = [
    ...BRAND_SPECS.flatMap((spec) => spec.lexicon),
    // The auth cues and the provider buttons of detectBrandImpersonation, with and without the space.
    "sign in", "signin", "log in", "login", "logon", "continue with", "verify",
    ...["continue", "sign in", "signin", "log in", "login", "logon"].flatMap((verb) => ["google", "microsoft"].map((brandName) => `${verb} with ${brandName}`)),
  ];
  for (const phrase of phrases) expect(WINDOW_CUE.test(phrase), phrase).toBe(true);
  // And it does not hold ordinary words that merely contain a cue's letters.
  for (const word of ["designers", "blog", "technology", "logistics is hard", "assignment", "catalog entry"]) {
    expect(WINDOW_CUE.test(word), word).toBe(false);
  }
});

test("the prefilter's auth words come from the exported cue lists, which also build AUTH_LABEL and PROVIDER_BUTTON (#1460)", () => {
  // Every phrase the two patterns are built from passes the prefilter, taken from the same exports.
  for (const phrase of AUTH_LABEL_PHRASES) {
    expect(AUTH_LABEL.test(` ${phrase} `), phrase).toBe(true);
    expect(WINDOW_CUE.test(phrase), phrase).toBe(true);
  }
  for (const verb of PROVIDER_VERBS) {
    for (const spelling of [verb, verb.replace(" ", "")]) {
      expect(PROVIDER_BUTTON.test(`${spelling} with google`), spelling).toBe(true);
      expect(WINDOW_CUE.test(`${spelling} with google`), spelling).toBe(true);
    }
  }
  // A verb added to the lists reaches the prefilter: the pattern is a function of them.
  expect(new RegExp(cuePattern(AUTH_CUE_PHRASES), "u").test("authenticate with google")).toBe(false);
  expect(new RegExp(cuePattern([...AUTH_CUE_PHRASES, "authenticate with"]), "u").test("authenticate with google")).toBe(true);
});

test("one attribute full of repeated sign-in text does not spend the window cap before the brand phrase (#1458)", () => {
  // 7,000 characters of `sign in`, padding, the Google phrase, then more `sign in` text: far more auth-only windows
  // than the per-attribute cap, and the one window that names Google sits in the middle of them.
  const repeated = "sign in ".repeat(875);
  const label = `${repeated}${"a".repeat(3_000)} Sign in with Google ${"a".repeat(300)} ${"sign in ".repeat(250)}`;
  expect(label.length).toBeLessThan(16_000);
  for (const [, control] of ATTRIBUTE_CONTROLS) expect(brand(control(label))).toBe("Google");
});

// ── viewport units (#1496) ───────────────────────────────────────────────────────────────────────────────

const cover = (width: string, height: string, extra = "") =>
  `<iframe id="google-auth" srcdoc="" style="position:fixed;top:0;left:0;width:${width};height:${height};z-index:99999${extra}"></iframe>`;

test("every viewport unit that is the whole viewport makes a fixed frame a cover", () => {
  const widths = ["100%", "100vw", "100dvw", "100svw", "100lvw", "100vmax", "100vmin", "calc(100dvw - 0px)", "calc(100vw + 0px)"];
  const heights = ["100%", "100vh", "100dvh", "100svh", "100lvh", "100vmax", "100vmin", "calc(100dvh - 0px)", "max(100svh, 100%)"];
  for (const width of widths) {
    for (const height of heights) {
      expect(detectFakeAuthOverlay(context(cover(width, height))), `${width} x ${height}`).not.toBeNull();
    }
  }
});

test("a fixed frame that is not the whole viewport is not a cover", () => {
  for (const [width, height] of [["50dvw", "100dvh"], ["100dvw", "50dvh"], ["100px", "100px"], ["300px", "100dvh"], ["100dvh", "100dvw"]]) {
    expect(detectFakeAuthOverlay(context(cover(width!, height!))), `${width} x ${height}`).toBeNull();
  }
});

test("other spellings of the whole viewport are covers too", () => {
  const same = ["100.0%", "100.00vw", "+100vw", "1e2vw", "1E2%", "100.000dvw", "calc(100vw)", "calc(50vw + 50vw)", "calc(100% - 0px)", "max(100vw, 0px)", "min(100vw, 200vw)", "clamp(0px, 100vw, 200vw)", "101vw", "150%", "1100vw", "10000vw", "1e5vw", "1e400vw", "calc(2000vw - 1900vw)", "calc(100vw * 20)", "calc(100vw / 1)", "calc(1vw * 100)", "max(-5vw, 100vw)", "100vi", "100svi", "100cqw", "100cqi", "-webkit-fill-available", "stretch", "-moz-available"];
  for (const width of same) {
    expect(detectFakeAuthOverlay(context(cover(width, "100vh"))), `${width} wide`).not.toBeNull();
  }
  const tall = ["100.0%", "100.00vh", "+100vh", "1e2vh", "calc(50vh + 50vh)", "200vh", "100vb", "100dvb", "100cqh", "100cqb", "-webkit-fill-available", "stretch"];
  for (const height of tall) {
    expect(detectFakeAuthOverlay(context(cover("100vw", height))), `${height} tall`).not.toBeNull();
  }
});

test("lengths that only look like the whole viewport are not covers", () => {
  const not = ["10vw", "100px", "0.100vw", "50%", "-100vw", "5e1vw", "100vh", "var(--w)", "calc(100px + 50vw)"];
  for (const width of not) {
    expect(detectFakeAuthOverlay(context(cover(width, "100vh"))), `${width} wide`).toBeNull();
  }
});

test("padding, comments and escapes do not hide a cover (#1496)", () => {
  const widths = [
    `${" ".repeat(600)}100vw`,
    `${"/**/".repeat(200)}100vw`,
    `/*${"x".repeat(700)}*/100vw`,
    `calc(${"0px + ".repeat(200)}100vw)`,
    `${"1px ".repeat(1_000)}`,
    "1\\30 0vw",
    "10\\30 vw",
    "100v\\w",
    "100\\76 w",
    "\\31 00vw",
    "100\\56 W",
    "100\\000076 w",
  ];
  for (const width of widths) {
    expect(detectFakeAuthOverlay(context(cover(width, "100vh"))), width.slice(0, 40)).not.toBeNull();
  }
  // an escaped property name and a comment that hides the semicolon
  const named = '<iframe id="google-auth" srcdoc="" style="position:fixed;top:0;left:0;wid\\74 h:100vw;height:100vh;z-index:99999"></iframe>';
  expect(detectFakeAuthOverlay(context(named))).not.toBeNull();
  const commented = '<iframe id="google-auth" srcdoc="" style="position:fixed;top:0;left:0;width:/*;*/100vw;height:100vh;z-index:99999"></iframe>';
  expect(detectFakeAuthOverlay(context(commented))).not.toBeNull();
  // escapes that spell something else stay what they spell
  expect(detectFakeAuthOverlay(context(cover("10\\30 px", "100vh")))).toBeNull();
  expect(detectFakeAuthOverlay(context(cover("1\\30 vw", "100vh")))).toBeNull();
});

test("declarations are split the way a browser tokenises them (#1496)", () => {
  const frame = (style: string) => `<iframe id="google-auth" srcdoc="" style="${style.replaceAll('"', "&quot;")}"></iframe>`;
  const base = "position:fixed;top:0;left:0;z-index:99999";
  const hiding = [
    `content:"/*"; ${base}; width:100vw; height:100vh`,
    `content:'/*'; ${base}; width:100vw; height:100vh`,
    `background:url(data:image/png;base64,AAA); ${base}; width:100vw; height:100vh`,
    `font-family:"a;b"; ${base}; width:100vw; height:100vh`,
    `--x:{;}; ${base}; width:100vw; height:100vh`,
    `--x:[;]; ${base}; width:100vw; height:100vh`,
    `content:"\\""; ${base}; width:100vw; height:100vh`,
    `content:"\\"/*"; ${base}; width:100vw; height:100vh`,
    `${base}; width:/*;*/100vw; height:100vh`,
    `${base}; width:100vw/**/; height:100vh`,
    `a\\/*b:c; ${base}; width:100vw; height:100vh`,
  ];
  for (const style of hiding) expect(detectFakeAuthOverlay(context(frame(style))), style.slice(0, 50)).not.toBeNull();
  // an unterminated comment runs to the end, as in a browser: nothing after it is read
  expect(detectFakeAuthOverlay(context(frame(`${base}; width:100vw; /* height:100vh`)))).toBeNull();
  // a semicolon inside a string or url() is not a separator: width stays inside the content value
  expect(detectFakeAuthOverlay(context(frame(`${base}; height:100vh; content:"x; width:100vw"`)))).toBeNull();
  expect(detectFakeAuthOverlay(context(frame(`${base}; height:100vh; background:url(a;width:100vw)`)))).toBeNull();
});

test("the declaration tokenizer agrees with a reference parse on random mixes and stays linear", () => {
  let seed = 1234567;
  const next = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // structured generator with a known answer: well-formed junk (strings, url(), brackets, comments, with `/*`, `;` and
  // `:` inside) in front of a top-level width/height, which must always be read
  const junkText = (): string => {
    const alphabet = ["/*", "*/", ";", ":", "a", " ", "width:100vw", "x"];
    let out = "";
    for (let j = 0; j < 1 + Math.floor(next() * 6); j++) out += alphabet[Math.floor(next() * alphabet.length)];
    return out.replaceAll("*/", "* /");
  };
  const junk: Array<() => string> = [
    () => `content:"${junkText()}"`,
    () => `content:'${junkText()}'`,
    () => `background:url(${junkText().replaceAll(")", "")})`,
    () => `--v:{${junkText().replaceAll("/*", "/ *").replaceAll("}", "")}}`,
    () => `--v:[${junkText().replaceAll("/*", "/ *").replaceAll("]", "")}]`,
    () => `/*${junkText()}*/`,
    () => `content:"\\"${junkText()}"`,
  ];
  for (let i = 0; i < 2_000; i++) {
    const parts: string[] = [];
    for (let j = 0; j < 1 + Math.floor(next() * 4); j++) parts.push(junk[Math.floor(next() * junk.length)]!());
    const html = `<iframe id="google-auth" srcdoc="" style="${`${parts.join(";")};position:fixed;top:0;left:0;z-index:99999;width:100vw;height:100vh`.replaceAll('"', "&quot;")}"></iframe>`;
    expect(detectFakeAuthOverlay(context(html)), html).not.toBeNull();
  }
  for (const hostile of ['"'.repeat(1_000_000), "/*".repeat(500_000), "(;".repeat(500_000), '"\\'.repeat(500_000), "a;".repeat(500_000)]) {
    const html = `<iframe id="google-auth" srcdoc="" style="position:fixed;top:0;left:0;z-index:99999;width:100vw;height:100vh;${hostile.replaceAll('"', "&quot;")}"></iframe>`;
    const t = performance.now();
    detectFakeAuthOverlay(context(html));
    expect(performance.now() - t, hostile.slice(0, 6)).toBeLessThan(2_000);
  }
});

test("inset spelled with logical sides is the same as top/left/bottom/right", () => {
  const frame = (style: string) => `<iframe id="google-auth" srcdoc="" style="position:fixed;${style};z-index:99999"></iframe>`;
  for (const style of ["inset:0", "inset-block:0;inset-inline:0", "inset-block-start:0;inset-block-end:0;inset-inline-start:0;inset-inline-end:0", "top:0;right:0;bottom:0;left:0"]) {
    expect(detectFakeAuthOverlay(context(frame(style))), style).not.toBeNull();
  }
  expect(detectFakeAuthOverlay(context(frame("inset-block:0;inset-inline:40px"))), "inline inset 40px").toBeNull();
});

test("the units work from a stylesheet too", () => {
  const frame = '<iframe id="google-auth" srcdoc=""></iframe>';
  expect(detectFakeAuthOverlay(context(frame, "<style>#google-auth{position:fixed;top:0;left:0;width:100dvw;height:100svh;z-index:99999}</style>"))).not.toBeNull();
});
