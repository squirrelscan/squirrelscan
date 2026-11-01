import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
import { brandImpersonationRule } from "../src/integrity/brand-impersonation";
import { WINDOW_CUE, cuePattern } from "../src/integrity/controls";
import { AUTH_CUE_PHRASES, AUTH_LABEL, AUTH_LABEL_PHRASES, PROVIDER_BUTTON, PROVIDER_VERBS } from "../src/integrity/cues";
import { BRAND_SPECS } from "../src/integrity/brand-specs";
import { isCover, overlayGeometry, overlayGeometryFor, splitDeclarations, styleUnder, type Reading } from "../src/integrity/overlay-style";
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

const frameOf = (html: string): { doc: NonNullable<RuleContext["parsed"]["document"]>; frame: Element } => {
  const doc = context(html).parsed.document!;
  return { doc, frame: doc.querySelector("iframe")! };
};
/** Whether one reading of the CSS says the frame is a cover. */
const coversUnder = (reading: Reading, style: string, sheet = ""): boolean => {
  const { doc, frame } = frameOf(`${sheet}<iframe id="google-auth" srcdoc="" style="${style.replaceAll('"', "&quot;")}"></iframe>`);
  return isCover(overlayGeometryFor(doc, frame, reading));
};
const BASE = "position:fixed;top:0;left:0;z-index:99999";
const GEOM = `${BASE};width:100vw;height:100vh`;

test("declarations are read by three readings and a frame is a cover when any of them says so (#1496)", () => {
  const frame = (style: string) => `<iframe id="google-auth" srcdoc="" style="${style.replaceAll('"', "&quot;")}"></iframe>`;
  const hiding = [
    `content:"/*"; ${GEOM}`,
    `content:'/*'; ${GEOM}`,
    `background:url(data:image/png;base64,AAA); ${GEOM}`,
    `font-family:"a;b"; ${GEOM}`,
    `--x:{;}; ${GEOM}`,
    `--x:[;]; ${GEOM}`,
    `content:"\\""; ${GEOM}`,
    `content:"\\"/*"; ${GEOM}`,
    `${BASE}; width:/*;*/100vw; height:100vh`,
    `${BASE}; width:100vw/**/; height:100vh`,
    `a\\/*b:c; ${GEOM}`,
    // the declaration list a browser would not read past, and the ones it would
    `a:(]; ${GEOM}`,
    `a:[}; ${GEOM}`,
    `a:{); ${GEOM}`,
    `a:( ; ${GEOM}`,
    `a:calc((1); ${GEOM}`,
    `a:url( ; ${GEOM}`,
    `${BASE}; width:100vw; /* height:100vh`,
    `${BASE}; height:100vh; content:"x; width:100vw`,
    `a:u\\72 l(/*); ${GEOM}`,
    `a:URL(/*); ${GEOM}`,
    `a:\\55 RL(/*); ${GEOM}`,
    `a:\\;url(/*); ${GEOM}`,
    `content:"x&#13;;${GEOM}`,
    `content:"x&#12;;${GEOM}`,
    `content:"x&#13;&#10;;${GEOM}`,
  ];
  for (const style of hiding) expect(detectFakeAuthOverlay(context(frame(style))), style.slice(0, 50)).not.toBeNull();
  // junk after the geometry changes nothing
  for (const open of ["a:(]", "a:[}", "a:{)", "a:( ", "a:url( "]) {
    expect(detectFakeAuthOverlay(context(frame(`${GEOM}; ${open}`))), open).not.toBeNull();
  }
  // a closer with nothing open is an ordinary token; balanced blocks do not swallow
  for (const ok of ["a:)", "a:]", "a:}", "}", ")", "a:(b;c)", "a:[;]", "a:{;}", "a:calc((1))", "a:url( ; )", "a:xurl(/*c*/)"]) {
    expect(detectFakeAuthOverlay(context(frame(`${BASE}; ${ok}; width:100vw; height:100vh`))), ok).not.toBeNull();
  }
});

test("the tokens reading is the browser's: strings, url(), blocks, escapes and newlines (#1496)", () => {
  // each of these is ONE declaration to a browser, so the tokens reading does not see the geometry behind it
  for (const swallowed of ["a:(]", "a:[}", "a:{)", "a:( ", "a:calc((1)", "a:url( ", 'content:"x;', "a:\\;url(/*"]) {
    expect(coversUnder("tokens", `${swallowed}; ${GEOM}`), swallowed).toBe(false);
    expect(coversUnder("naive", `${swallowed}; ${GEOM}`) || coversUnder("plain", `${swallowed}; ${GEOM}`), swallowed).toBe(true);
  }
  // and these it does see: a string, url() or block that ends, an escaped url, any newline ending a string
  for (const read of [
    `content:"/*"; ${GEOM}`,
    `background:url(data:image/png;base64,AAA); ${GEOM}`,
    `--x:{;}; ${GEOM}`,
    `a:u\\72 l(/*); ${GEOM}`,
    `a:URL(/*); ${GEOM}`,
    `a:\\55 RL(/*); ${GEOM}`,
    `content:"x&#13;;${GEOM}`,
    `content:"x&#12;;${GEOM}`,
    `content:"x&#13;&#10;;${GEOM}`,
    `content:"x&#10;;${GEOM}`,
  ]) {
    expect(coversUnder("tokens", read), read.slice(0, 40)).toBe(true);
  }
  expect(splitDeclarations("a:(]; width:100vw")).toEqual(["a:(]; width:100vw"]);
  expect(splitDeclarations("a:URL(/*); b:1")).toEqual(["a:URL(/*)", " b:1"]);
  expect(splitDeclarations("a:u\\72 l(/*); b:1")).toEqual(["a:u\\72 l(/*)", " b:1"]);
  expect(splitDeclarations("a:\\;url(/*); b:1")).toHaveLength(1);
  expect(splitDeclarations("a:url(x\\)y;z); b:1")).toEqual(["a:url(x\\)y;z)", " b:1"]);
  expect(splitDeclarations('a:"x\r;b:1')).toEqual(["a:\"x", "b:1"].map((t, i) => (i === 0 ? t + "\n" : t)));
  expect(splitDeclarations("a:b/* c */;d:e")).toEqual(["a:b ", "d:e"]);
});

test("a style rule is cut at its own closing brace, past strings, comments and blocks, and the union keeps the old cut (#1496)", () => {
  const rule = (body: string) => `<style>#google-auth{${body}}</style>`;
  const frame = '<iframe id="google-auth" srcdoc=""></iframe>';
  for (const body of [`content:"}"; ${GEOM}`, `/* } */${GEOM}`, `--x:{}; ${GEOM}`, `a:url(});${GEOM}`, `content:'}'; ${GEOM}`]) {
    expect(coversUnder("tokens", "", rule(body)), body.slice(0, 30)).toBe(true);
    expect(detectFakeAuthOverlay(context(frame, "")), "no sheet").toBeNull();
    expect(detectFakeAuthOverlay(context(`${rule(body)}${frame}`)), body.slice(0, 30)).not.toBeNull();
  }
  // the old cut at the first `}` is kept as a reading: what it saw is still seen
  expect(detectFakeAuthOverlay(context(`${rule(`${GEOM}; a:{`)}${frame}`))).not.toBeNull();
});

test("the union reading is a superset of the plain split on random mixes (#1496)", () => {
  const pieces = ['"', "'", "/*", "*/", ";", "(", ")", "[", "]", "{", "}", "\\", "&#13;", "&#10;", "url(", "URL(", "a", ":", " ", GEOM, "width:100vw", "height:100vh", BASE];
  let seed = 424242;
  const next = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let plainOnly = 0;
  for (let i = 0; i < 20_000; i++) {
    let style = "";
    for (let j = 0; j < 2 + Math.floor(next() * 14); j++) style += pieces[Math.floor(next() * pieces.length)];
    const { doc, frame } = frameOf(`<iframe id="google-auth" srcdoc="" style="${style.replaceAll('"', "&quot;")}"></iframe>`);
    const union = isCover(overlayGeometry(doc, frame));
    const plain = isCover(overlayGeometryFor(doc, frame, "plain"));
    if (plain) expect(union, style).toBe(true);
    if (plain && !isCover(overlayGeometryFor(doc, frame, "tokens"))) plainOnly++;
  }
  // the generator does produce lists only the old reading caught, so the property is not vacuous
  expect(plainOnly).toBeGreaterThan(0);
});

/**
 * A recursive reading of CSS Syntax 3 consume-a-list-of-declarations, written differently from the stack in the source:
 * the text is first cut into tokens (strings, comments, identifiers with escapes, unquoted url tokens, single characters),
 * then consumed recursively block by block.
 */
function referenceSplit(raw: string): string[] {
  const text = raw.replace(/\r\n?|\f/g, "\n");
  const n = text.length;
  type Token = { kind: "text" | "comment" | "char"; raw: string };
  const identChar = (c: string): boolean => /[\w-]/.test(c) || c >= "\u0080";
  const decodeIdent = (ident: string): string =>
    ident.replace(/\\(?:([0-9a-f]{1,6})[ \t\n]?|([^\n]))/gi, (_m, hex?: string, ch?: string) => (ch !== undefined ? ch : String.fromCodePoint(Number.parseInt(hex!, 16) || 0xfffd)));
  const tokens: Token[] = [];
  let pos = 0;
  const escapeLen = (at: number): number => {
    let j = at + 1;
    if (j >= n) return n - at;
    if (/[0-9a-f]/i.test(text[j]!)) {
      let digits = 1;
      while (digits < 6 && j + 1 < n && /[0-9a-f]/i.test(text[j + 1]!)) {
        j++;
        digits++;
      }
      if (j + 1 < n && /[ \t\n]/.test(text[j + 1]!)) j++;
    }
    return j + 1 - at;
  };
  while (pos < n) {
    const c = text[pos]!;
    if (c === "\\" && text[pos + 1] === "\n") {
      tokens.push({ kind: "char", raw: c });
      pos++;
    } else if (c === "\\" || identChar(c)) {
      const from = pos;
      while (pos < n && ((text[pos] === "\\" && text[pos + 1] !== "\n") || identChar(text[pos]!))) pos += text[pos] === "\\" ? escapeLen(pos) : 1;
      const ident = text.slice(from, pos);
      tokens.push({ kind: "text", raw: ident });
      if (text[pos] === "(" && decodeIdent(ident).toLowerCase() === "url" && !/^[ \t\n]*["']/.test(text.slice(pos + 1))) {
        const start = pos++;
        while (pos < n && text[pos] !== ")") pos += text[pos] === "\\" ? escapeLen(pos) : 1;
        pos = Math.min(pos + 1, n);
        tokens.push({ kind: "text", raw: text.slice(start, pos) });
      }
    } else if (c === '"' || c === "'") {
      const from = pos++;
      while (pos < n && text[pos] !== c && text[pos] !== "\n") pos += text[pos] === "\\" ? escapeLen(pos) : 1;
      if (pos < n && text[pos] === c) pos++;
      tokens.push({ kind: "text", raw: text.slice(from, Math.min(pos, n)) });
    } else if (c === "/" && text[pos + 1] === "*") {
      const end = text.indexOf("*/", pos + 2);
      pos = end === -1 ? n : end + 2;
      tokens.push({ kind: "comment", raw: " " });
    } else {
      tokens.push({ kind: "char", raw: c });
      pos++;
    }
  }
  const decls: string[] = [];
  let buf = "";
  let at = 0;
  const consume = (closer: string | null): void => {
    while (at < tokens.length) {
      const t = tokens[at++]!;
      if (t.kind !== "char") {
        buf += t.raw;
        continue;
      }
      if (t.raw === "(" || t.raw === "[" || t.raw === "{") {
        buf += t.raw;
        consume(t.raw === "(" ? ")" : t.raw === "[" ? "]" : "}");
      } else if (closer !== null && t.raw === closer) {
        buf += t.raw;
        return;
      } else if (t.raw === ";" && closer === null) {
        decls.push(buf);
        buf = "";
      } else buf += t.raw;
    }
  };
  consume(null);
  decls.push(buf);
  return decls;
}

test("the tokenizer gives the same declarations as the reference on random delimiter mixes", () => {
  const pieces = ['"', "'", "/*", "*/", ";", "(", ")", "[", "]", "{", "}", "\\", "\n", "\r", "\f", "url(", "url", "URL(", "u\\72 l(", "\\55 rl(", "a", ":", " ", "x/", "*", "\\31 ", "-"];
  let seed = 987654321;
  const next = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 20_000; i++) {
    let text = "";
    for (let j = 0; j < 2 + Math.floor(next() * 28); j++) text += pieces[Math.floor(next() * pieces.length)];
    expect(splitDeclarations(text), JSON.stringify(text)).toEqual(referenceSplit(text));
  }
});

test("lengths the evaluator must not over-read, and the spellings it must (#1496)", () => {
  // `vw` is not a height unit, a trailing letter is not a unit, a leading-dot number is a number
  expect(detectFakeAuthOverlay(context(cover("100vw", "100vw")))).toBeNull();
  expect(detectFakeAuthOverlay(context(cover("100vh", "100vh")))).toBeNull();
  // a unit with trailing text still reads as the unit (main read it with `includes`): `100%x` fills
  expect(detectFakeAuthOverlay(context(cover("100vwx", "100vh")))).not.toBeNull();
  expect(detectFakeAuthOverlay(context(cover("100%x", "100vhx")))).not.toBeNull();
  expect(detectFakeAuthOverlay(context(cover("x100%", "100%")))).not.toBeNull();
  // 100 is the threshold, not 100.0001 and not 99.99
  expect(detectFakeAuthOverlay(context(cover("100vw", "100vh")))).not.toBeNull();
  expect(detectFakeAuthOverlay(context(cover("100.0001vw", "100vh")))).not.toBeNull();
  expect(detectFakeAuthOverlay(context(cover("99.99vw", "100vh")))).toBeNull();
  expect(detectFakeAuthOverlay(context(cover("99vw", "100vh")))).toBeNull();
  // the leading-dot form is a number: .5vw is half a percent, .5vw + 99.5vw is 100
  expect(detectFakeAuthOverlay(context(cover(".5vw", "100vh")))).toBeNull();
  expect(detectFakeAuthOverlay(context(cover("calc(.5vw + 99.5vw)", "100vh")))).not.toBeNull();
  expect(detectFakeAuthOverlay(context(cover(".1e3vw", "100vh")))).not.toBeNull();
  expect(detectFakeAuthOverlay(context(cover("calc(0px - -100vw)", "100vh")))).not.toBeNull();
  // documented limits: fixed lengths are not subtracted, a product fills, vmin/vmax and container units fill on both axes
  for (const [w, h] of [["calc(50vw + 50vw - 400px)", "100vh"], ["calc(1vw * 40)", "100vh"], ["100cqw", "100cqh"], ["100vmin", "100vmin"]]) {
    expect(detectFakeAuthOverlay(context(cover(w!, h!))), `${w} x ${h}`).not.toBeNull();
  }
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

// ── round 6: the old reading is a floor, backslash-newline, at-rule preludes ────────────────────────────────

test("a backslash before a newline is not an escape outside a string, and a string continues over it", () => {
  const style = `b:\\\n${"url(/*);"}\\70 osition:fixed;top:0;left:0;z-index:99999;width:100vw;height:100vh;c:*/`;
  // the rest is hidden from every reading that treats `\<LF>` as an escape; the tokens reading must not
  expect(coversUnder("tokens", style.replace("\\70 osition", "position"))).toBe(true);
  expect(splitDeclarations("b:\\\nurl(/*); c:1")).toEqual(["b:\\\nurl(/*)", " c:1"]);
  expect(splitDeclarations('b:"x\\\n;y"; c:1')).toEqual(['b:"x\\\n;y"', " c:1"]);
  expect(detectFakeAuthOverlay(context(`<iframe id="google-auth" srcdoc="" style="${style.replace("\\70 osition", "position")}"></iframe>`))).not.toBeNull();
});

test("the CSS whitespace before a quote in url( is a space, tab or newline only", () => {
  // NBSP, U+2028 and a BOM are not CSS whitespace: `url(<NBSP>"` is an unquoted url token ending at the `)`
  for (const odd of ["\u00a0", "\u2028", "\ufeff"]) {
    expect(splitDeclarations(`a:url(${odd}"/*); b:1`), JSON.stringify(odd)).toEqual([`a:url(${odd}"/*)`, " b:1"]);
  }
  expect(splitDeclarations('a:url( "/*)"); b:1')).toEqual(['a:url( "/*)")', " b:1"]);
});

test("geometry written inside a comment is read by the plain reading only: the old reading stays a floor", () => {
  const style = `/*;${GEOM};*/`;
  expect(coversUnder("plain", style)).toBe(true);
  expect(coversUnder("tokens", style)).toBe(false);
  expect(coversUnder("naive", style)).toBe(false);
  expect(detectFakeAuthOverlay(context(`<iframe id="google-auth" srcdoc="" style="${style}"></iframe>`))).not.toBeNull();
});

test("preludes and at-rules are cut past strings and brackets, so the rule after them is read", () => {
  const rule = `#google-auth{${GEOM}}`;
  for (const before of [
    '@media print{.x{content:"{"}}',
    '@import "a;b";',
    "@import url(a;b);",
    '@charset "a;b";',
    "@font-face{font-family:x;src:url(a;b)}",
    "garbage;",
    "/* c */",
    '.x{content:"}"}',
  ]) {
    expect(coversUnder("tokens", "", `<style>${before}${rule}</style>`), before).toBe(true);
  }
  expect(coversUnder("tokens", "", `<style>#google-auth,[a="{"]{${GEOM}}</style>`)).toBe(true);
  expect(coversUnder("tokens", "", `<style>#google-auth,[a="}"]{${GEOM}}</style>`)).toBe(true);
  // rules inside an at-rule are not applied, as before
  expect(coversUnder("tokens", "", `<style>@media print{${rule}}</style>`)).toBe(false);
});

/** The old rules, as main read them: plain split, the first `}`, and `includes` for the fill. */
function mainCover(doc: NonNullable<RuleContext["parsed"]["document"]>, frame: Element): boolean {
  const style = styleUnder(doc, frame, "plain");
  const zero = (side: string): boolean => /^0(?:px|%|em|rem|vh|vw)?$/.test(style.get(side) ?? "");
  const width = style.get("width") ?? "";
  const height = style.get("height") ?? "";
  const auto = (v: string): boolean => v === "" || v === "auto";
  const stretched = zero("top") && zero("right") && zero("bottom") && zero("left") && auto(width) && auto(height);
  const z = Number.parseInt(style.get("z-index") ?? "0", 10);
  const fills = ((width.includes("100%") || width.includes("100vw")) && (height.includes("100%") || height.includes("100vh"))) || stretched;
  const position = style.get("position");
  return (position === "fixed" || position === "absolute") && Number.isFinite(z) && z >= 1000 && fills && (zero("top") || zero("left"));
}

test("the union is a superset of the old reading on random attribute and stylesheet mixes", () => {
  const mixes = Number(process.env.OVERLAY_MIXES ?? 30_000);
  const pieces = ['"', "'", "/*", "*/", ";", "(", ")", "[", "]", "{", "}", "\\", "\\\n", "&#13;", "&#10;", "&#12;", "\u0000", "\u2028", "\ufeff", "\u00a0", "\ud800", "url(", "URL(", "@media{", "@import ", "a", ":", " ", GEOM, "width:100vw", "height:100vh", "width:100%x", "height:100%", BASE, "!important", "position:fixed", "z-index:99999", "top:0", "left:0", "x100%", "\\70 osition"];
  let seed = 20241101;
  const next = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const mix = (): string => {
    let t = "";
    for (let j = 0; j < 2 + Math.floor(next() * 16); j++) t += pieces[Math.floor(next() * pieces.length)];
    return t;
  };
  let oldOnly = 0;
  for (let i = 0; i < mixes; i++) {
    const sheet = i % 6 === 0;
    const text = mix();
    const html = sheet
      ? `<style>#google-auth{${text.replaceAll("</", "<\\/")}}</style><iframe id="google-auth" srcdoc=""></iframe>`
      : `<iframe id="google-auth" srcdoc="" style="${text.replaceAll('"', "&quot;")}"></iframe>`;
    const { doc, frame } = frameOf(html);
    const old = mainCover(doc, frame);
    const union = isCover(overlayGeometry(doc, frame));
    if (old && !union) throw new Error(`main flags, the union does not: ${JSON.stringify(text)}`);
    if (old && !isCover(overlayGeometryFor(doc, frame, "tokens"))) oldOnly++;
  }
  expect(oldOnly).toBeGreaterThan(0);
}, 600_000);
