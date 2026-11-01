import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
import { brandImpersonationRule } from "../src/integrity/brand-impersonation";
import { PLAIN_LOCAL_HREF, WINDOW_CUE, cuePattern, looksOffSite, urlText } from "../src/integrity/controls";
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
    "https://example.auth0.com/authorize?client_id=x&connection=google-oauth2",
    "https://example.okta.com/oauth2/v1/authorize?client_id=x&idp=0oa1b2c3d4",
    "https://example-prod.okta.com/oauth2/default/v1/authorize?client_id=x&idp=0oa1b2c3d4",
    "https://example.oktapreview.com/oauth2/v1/authorize?idp=0oa1b2c3d4",
    "https://example-prod.auth.eu-west-1.amazoncognito.com/oauth2/authorize?client_id=x&identity_provider=Google",
    "https://project.supabase.co/auth/v1/authorize?provider=google",
    "https://project.firebaseapp.com/__/auth/handler?providerId=google.com",
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

// ── logo alts per control are bounded (#1424 follow-up) ──────────────────────────────────────────────────

test("a control wrapping many logos: the first few alts are read in full, the rest only at their start, and past 100 they are counted", async () => {
  const phrase = "Sign in with Google";
  // The phrase is in the 3rd alt, padded past 300 characters: still read (the first four alts are read in full).
  const full = [`${"a".repeat(400)} ${phrase}`].map((alt) => `<img src="/g.png" alt="${alt}">`);
  const early = `<a href="${OFF}"><img src="/a.png" alt="x"><img src="/b.png" alt="y">${full.join("")}</a>`;
  expect(brand(early)).toBe("Google");
  // The same padded alt as the 20th logo is read only for its first 300 characters: not found, but the control is
  // reported as not read in full (it is never a silent miss).
  const filler = Array.from({ length: 19 }, (_, i) => `<img src="/${i}.png" alt="logo ${i}">`).join("");
  expect(brand(`<a href="${OFF}">${filler}${full.join("")}</a>`)).toBeNull();
  const { brandImpersonationRule: rule20 } = await import("../src/integrity/brand-impersonation");
  const cut20 = await rule20.run(context(`<a href="${OFF}">${filler}${full.join("")}</a>`));
  expect(cut20.checks[0]?.details).toMatchObject({ scanTruncated: true, controlsUnread: 1 });
  // From the 5th logo on, 5 to 99 decoys before it make no difference: a long late alt is always reported.
  for (const decoys of [4, 5, 20, 99]) {
    const before = Array.from({ length: decoys }, (_, i) => `<img src="/${i}.png" alt="logo ${i}">`).join("");
    const result = await rule20.run(context(`<a href="${OFF}">${before}${full.join("")}</a>`));
    const reported = result.checks[0]?.details as { controlsUnread?: number } | undefined;
    const found = brand(`<a href="${OFF}">${before}${full.join("")}</a>`) === "Google";
    expect(found || reported?.controlsUnread === 1, `${decoys} decoys`).toBe(true);
  }
  // A 20,000-character alt as the 10th logo is reported too.
  const tenth = `${Array.from({ length: 9 }, (_, i) => `<img src="/${i}.png" alt="logo ${i}">`).join("")}<img src="/big.png" alt="${"a".repeat(20_000)}">`;
  expect((await rule20.run(context(`<a href="${OFF}">${tenth}</a>`))).checks[0]?.details).toMatchObject({ scanTruncated: true, controlsUnread: 1 });
  // An unpadded phrase in the 20th alt is within its first 300 characters: found.
  expect(brand(`<a href="${OFF}">${filler}<img src="/g.png" alt="${phrase}"></a>`)).toBe("Google");
  // 300 logos in one control: the control is reported as not read in full.
  const many = Array.from({ length: 300 }, (_, i) => `<img src="/${i}.png" alt="sign in ${i}">`).join("");
  const { brandImpersonationRule } = await import("../src/integrity/brand-impersonation");
  const result = await brandImpersonationRule.run(context(`<a href="${OFF}">${many}</a>`));
  expect(result.checks[0]?.details).toMatchObject({ scanTruncated: true, controlsUnread: 1 });
});

// ── a broker's authorize endpoint must name the provider (#1494) ─────────────────────────────────────────────

const BROKER_BARE = [
  "https://t1.auth0.com/authorize",
  "https://t1.auth0.com/authorize?client_id=x&redirect_uri=https%3A%2F%2Fapp.example%2Fcb",
  "https://t1.okta.com/oauth2/v1/authorize?client_id=x",
  "https://t1.oktapreview.com/oauth2/default/v1/authorize",
  "https://t1.auth.eu-west-1.amazoncognito.com/oauth2/authorize?client_id=x",
  "https://t1.supabase.co/auth/v1/authorize",
  "https://t1.firebaseapp.com/__/auth/handler",
];
const BROKER_OTHER_PROVIDER = [
  "https://t1.auth0.com/authorize?connection=github",
  "https://t1.auth0.com/authorize?connection=google-oauth2.evil",
  "https://t1.auth0.com/authorize?redirect_uri=connection%3Dgoogle-oauth2",
  "https://t1.auth.eu-west-1.amazoncognito.com/oauth2/authorize?identity_provider=Facebook",
  "https://t1.supabase.co/auth/v1/authorize?provider=github",
  "https://t1.firebaseapp.com/__/auth/handler?providerId=github.com",
  "https://t1.okta.com/oauth2/v1/authorize?idp=",
];

test.each([["Google", "Continue with Google"], ["Google", "Sign in with Google"], ["Microsoft", "Continue with Microsoft"]])(
  "a broker authorize link for %s that does not name the provider is off-brand ('%s')",
  (expected, label) => {
    for (const href of [...BROKER_BARE, ...BROKER_OTHER_PROVIDER]) {
      expect(brand(`<a href="${href}" aria-label="${label}"><svg></svg></a>`), href).toBe(expected);
      expect(brand(`<a href="${href}">${label}</a>`), href).toBe(expected);
    }
  },
);

test("a broker authorize link naming Microsoft is spared for a Microsoft label and not for a Google one", () => {
  const microsoft = [
    "https://example-dev.auth0.com/authorize?connection=windowslive",
    "https://example-qa.auth.eu-west-1.amazoncognito.com/oauth2/authorize?identity_provider=Microsoft",
    "https://t1.supabase.co/auth/v1/authorize?provider=azure",
    "https://t1.firebaseapp.com/__/auth/handler?providerId=microsoft.com",
  ];
  for (const href of microsoft) {
    expect(brand(`<a href="${href}">Continue with Microsoft</a>`), href).toBeNull();
    expect(brand(`<a href="${href}">Continue with Google</a>`), href).toBe("Google");
  }
});

test("the same shape on a plain off-brand host and on the broker without a hint are treated alike", () => {
  expect(brand(`<a href="https://shop-login.example/authorize" aria-label="Continue with Google"><svg></svg></a>`)).toBe("Google");
  expect(brand(`<a href="https://t1.auth0.com/authorize" aria-label="Continue with Google"><svg></svg></a>`)).toBe("Google");
});

test("a hint is not enough on a tenant that is not the site's own: a foreign tenant is off-brand whatever the URL says", () => {
  // The page is on example.com. The links are written by whoever wrote the page, so the provider hint proves nothing.
  const foreign = [
    "https://t1.auth0.com/authorize?connection=google-oauth2",
    "https://t1.auth0.com/authorize?idp=google&connection=google-oauth2",
    "https://t1.auth0.com/authorize?idp=x",
    "https://t1.okta.com/oauth2/v1/authorize?idp=google",
    "https://t1.okta.com/oauth2/v1/authorize?idp=0oa1b2c3d4",
    "https://t1.auth.eu-west-1.amazoncognito.com/oauth2/authorize?identity_provider=Google",
    "https://other-company.auth0.com/authorize?connection=google-oauth2",
    "https://notexample.us.auth0.com.credential-fixture.invalid/authorize?connection=google-oauth2",
  ];
  for (const href of foreign) expect(brand(`<a href="${href}" aria-label="Continue with Google"><svg></svg></a>`), href).toBe("Google");
});

const allow = (href: string, label = "Continue with Google", head = ""): string | null =>
  brand(`<a href="${href}" aria-label="${label}"><svg></svg></a>`, head);

test("a tenant that IS the site's name is spared with no hint at all; the platform endpoints need the provider only", () => {
  for (const href of [
    "https://example.auth0.com/authorize",
    "https://example.auth0.com/authorize?client_id=x&connection=waad",
    "https://example.auth0.com/authorize?connection=Username-Password-Authentication",
    "https://example.eu.auth0.com/authorize?client_id=x",
    "https://example.okta.com/oauth2/v1/authorize?client_id=x",
    "https://example.okta.com/oauth2/default/v1/authorize",
    "https://example.oktapreview.com/oauth2/v1/authorize",
    "https://example.okta-emea.com/oauth2/v1/authorize",
    "https://example.auth.us-east-1.amazoncognito.com/oauth2/authorize?client_id=x",
    "https://example.auth-fips.us-gov-west-1.amazoncognito.com/oauth2/authorize",
    "https://abcdefghijklmnopqrst.supabase.co/auth/v1/authorize?provider=google",
    "https://any-project.firebaseapp.com/__/auth/handler?providerId=google.com",
  ]) {
    expect(allow(href), href).toBeNull();
    expect(allow(href, "Continue with Microsoft") === null, href).toBe(!href.includes("google"));
  }
});

test("name plus an environment suffix needs the provider hint; free-form suffixes and look-alikes are never spared", () => {
  for (const env of ["prod", "production", "dev", "staging", "stage", "test", "qa", "uat", "preview"]) {
    expect(allow(`https://example-${env}.auth0.com/authorize?connection=google-oauth2`), env).toBeNull();
    expect(allow(`https://example-${env}.okta.com/oauth2/v1/authorize?idp=0oa1`), env).toBeNull();
    expect(allow(`https://example-${env}.auth.eu-west-1.amazoncognito.com/oauth2/authorize?identity_provider=Google`), env).toBeNull();
    // environment form without the hint, or with another provider, is not spared
    expect(allow(`https://example-${env}.auth0.com/authorize`), env).toBe("Google");
    expect(allow(`https://example-${env}.auth0.com/authorize?connection=github`), env).toBe("Google");
    expect(allow(`https://example-${env}.okta.com/oauth2/v1/authorize`), env).toBe("Google");
  }
  const attacker = [
    "https://example-login.auth0.com/authorize?connection=google-oauth2",
    "https://example-sso.okta.com/oauth2/v1/authorize?idp=0oa1b2c3d4",
    "https://example-secure.auth0.com/authorize?connection=google-oauth2",
    "https://exampleeu.auth0.com/authorize?connection=google-oauth2",
    "https://example-eu.auth0.com/authorize?connection=google-oauth2",
    "https://examplecorp.auth0.com/authorize?connection=google-oauth2",
    "https://example-support.okta.com/oauth2/v1/authorize?idp=0oa1",
    "https://xexamplex.auth0.com/authorize?connection=google-oauth2",
    "https://login-example.auth0.com/authorize?connection=google-oauth2",
    "https://prod-example.auth0.com/authorize?connection=google-oauth2",
    "https://example-prod-x.auth0.com/authorize?connection=google-oauth2",
    "https://xn--example-9xa.auth0.com/authorize?connection=google-oauth2",
    "https://evil.example.auth0.com/authorize?connection=google-oauth2",
    "https://example.evil.auth0.com/authorize?connection=google-oauth2",
    "https://example.auth0.com.evil.test/authorize?connection=google-oauth2",
    "https://evil.example.okta.com/oauth2/v1/authorize?idp=0oa1",
    "https://example.xx.auth0.com/authorize?connection=google-oauth2",
    "https://example.auth.eu-west-1.evil.amazoncognito.com/oauth2/authorize?identity_provider=Google",
    "https://evil.example.auth.us-east-1.amazoncognito.com/oauth2/authorize?identity_provider=Google",
    "https://example.amazoncognito.com/oauth2/authorize?identity_provider=Google",
  ];
  for (const href of attacker) expect(allow(href), href).toBe("Google");
});

test("a site whose name is shorter than three letters is never spared by a tenant (documented floor)", () => {
  const short = (href: string): string | null => {
    const html = `<!doctype html><html><head><title>x</title></head><body><a href="${href}" aria-label="Continue with Google"><svg></svg></a></body></html>`;
    const parsed = parsePage(html, "https://ab.com/");
    return detectBrandImpersonation({ page: { url: "https://ab.com/", html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} })?.brand ?? null;
  };
  expect(short("https://ab.auth0.com/authorize?connection=google-oauth2")).toBe("Google");
  expect(short("https://abc.auth0.com/authorize?connection=google-oauth2")).toBe("Google");
});

test("the canonical and og:url hosts count as the site for the tenant name; the query of a form action and formaction is read", () => {
  const head = '<link rel="canonical" href="https://acmecorp.org/"><meta property="og:url" content="https://other-brand.net/">';
  expect(allow("https://acmecorp.auth0.com/authorize", "Continue with Google", head)).toBeNull();
  expect(allow("https://other-brand.okta.com/oauth2/v1/authorize", "Continue with Google", head)).toBeNull();
  expect(allow("https://third.auth0.com/authorize", "Continue with Google", head)).toBe("Google");
  const hinted = "https://example-prod.auth0.com/authorize?connection=google-oauth2";
  const bare = "https://example-prod.auth0.com/authorize";
  expect(brand(`<form method="post"><button formaction="${hinted}">Continue with Google</button></form>`)).toBeNull();
  expect(brand(`<form method="post"><button formaction="${bare}">Continue with Google</button></form>`)).toBe("Google");
  expect(brand(`<form action="${hinted}" method="post"><input type="password"><button>Continue with Google</button></form>`)).toBeNull();
  expect(brand(`<form action="${bare}" method="post"><input type="password"><button>Continue with Google</button></form>`)).toBe("Google");
});

test("provider names and hosts of the families: Microsoft names, repeated and padded hints, regional hosts", () => {
  const e = "https://example-prod";
  for (const name of ["windowslive", "azure", "azuread-oauth2", "office365", "microsoftonline", "Microsoft"]) {
    expect(allow(`${e}.auth0.com/authorize?connection=${name}`, "Continue with Microsoft"), name).toBeNull();
    expect(allow(`${e}.auth0.com/authorize?connection=${name}`), name).toBe("Google");
  }
  expect(allow(`${e}.auth0.com/authorize?connection=github&connection=google-oauth2`)).toBeNull();
  expect(allow(`${e}.auth0.com/authorize?connection=%20google-oauth2%20`)).toBeNull();
  expect(allow(`${e}.okta.com/oauth2/v1/authorize?idp=%20`)).toBe("Google");
  expect(allow(`${e}.okta.com/oauth2/v1/authorize?idp=a&idp=`)).toBeNull();
  expect(allow(`${e}.okta.com/oauth2/v1/authorize?idp=`)).toBe("Google");
  // a hint pushed past the read cap is not found: more reporting, never less
  expect(allow(`${e}.auth0.com/authorize?${"a=b&".repeat(3_000)}connection=google-oauth2`)).toBe("Google");
  // another provider's name that merely starts like Google's
  expect(allow(`${e}.auth0.com/authorize?connection=googlefake`)).toBe("Google");
});

test("many links with huge queries do not make the brand check slow", () => {
  const query = `${"a=b&".repeat(250_000)}connection=github`;
  const links = Array.from({ length: 50 }, (_, i) => `<a href="https://shop${i}.example/path?${query}" aria-label="Sign in">x</a>`).join("");
  const links2 = Array.from({ length: 50 }, (_, i) => `<a href="https://example-prod${i}.auth0.com/authorize?${query}" aria-label="Continue with Google"><svg></svg></a>`).join("");
  // parsing the page is not what is timed: only the brand check
  const contexts = [context(links), context(links2)];
  const t = performance.now();
  for (const c of contexts) detectBrandImpersonation(c);
  expect(performance.now() - t).toBeLessThan(1_500);
});

// ── survivors of the #1494 review ────────────────────────────────────────────────────────────────────────────

const brandOn = (pageUrl: string, href: string, label = "Continue with Google"): string | null => {
  const html = `<!doctype html><html><head><title>x</title></head><body><a href="${href}" aria-label="${label}"><svg></svg></a></body></html>`;
  const parsed = parsePage(html, pageUrl);
  return detectBrandImpersonation({ page: { url: pageUrl, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} })?.brand ?? null;
};

test("the environment suffix needs its hyphen and a listed word", () => {
  for (const tenant of ["examplexprod", "example-xprod", "exampleprod", "example--prod", "example-prod-", "example_prod", "example-production2"]) {
    expect(allow(`https://${tenant}.auth0.com/authorize?connection=google-oauth2`), tenant).toBe("Google");
  }
  expect(allow("https://example-prod.auth0.com/authorize?connection=google-oauth2")).toBeNull();
});

test("site names of three to five letters are spared on their exact tenant; two letters never", () => {
  for (const name of ["abc", "abcd", "abcde"]) {
    expect(brandOn(`https://${name}.com/`, `https://${name}.auth0.com/authorize`), name).toBeNull();
    expect(brandOn(`https://${name}.com/`, `https://${name}-prod.okta.com/oauth2/v1/authorize?idp=0oa1`), name).toBeNull();
    expect(brandOn(`https://www.${name}.com/`, `https://${name}-login.auth0.com/authorize?connection=google-oauth2`), name).toBe("Google");
  }
  expect(brandOn("https://ab.com/", "https://ab.auth0.com/authorize")).toBe("Google");
});

test("a hint is read up to 8,192 characters of query and not beyond", () => {
  const stem = "?connection=google-oauth2&p=";
  for (const [length, spared] of [[200, true], [4_000, true], [8_192, true], [8_193, false], [20_000, false]] as const) {
    const query = stem + "a".repeat(length - stem.length);
    expect(query).toHaveLength(length);
    const got = allow(`https://example-prod.auth0.com/authorize${query}`);
    expect(got === null, `${length}`).toBe(spared);
  }
  // an exact tenant needs no hint, so a long query changes nothing there
  expect(allow(`https://example.auth0.com/authorize?${"a=b&".repeat(5_000)}`)).toBeNull();
});

test("deeper Okta and Cognito labels, and a registrable name from a co.uk site", () => {
  for (const href of [
    "https://evil.example.okta.com/oauth2/v1/authorize",
    "https://evil.example.okta.com/oauth2/v1/authorize?idp=0oa1",
    "https://example.okta.com.evil.test/oauth2/v1/authorize?idp=0oa1",
    "https://example.oktapreview.com.evil.test/oauth2/v1/authorize",
    "https://a.example.auth.us-east-1.amazoncognito.com/oauth2/authorize?identity_provider=Google",
  ]) {
    expect(allow(href), href).toBe("Google");
  }
  const uk = "https://www.example.co.uk/";
  expect(brandOn(uk, "https://example.auth0.com/authorize")).toBeNull();
  expect(brandOn(uk, "https://example-staging.okta.com/oauth2/v1/authorize?idp=0oa1")).toBeNull();
  expect(brandOn(uk, "https://co.auth0.com/authorize?connection=google-oauth2")).toBe("Google");
  expect(brandOn(uk, "https://uk.auth0.com/authorize")).toBe("Google");
  expect(brandOn(uk, "https://example-login.auth0.com/authorize?connection=google-oauth2")).toBe("Google");
});

test("the Microsoft provider names are exact; Google names do not spare a Microsoft label", () => {
  const env = "https://example-prod.auth0.com/authorize?connection=";
  for (const name of ["windowslive", "windows-live", "microsoftaccount", "azure-ad", "azuread", "azure", "live", "office365", "microsoftonline", "microsoft", "windowslive-oauth2", "azuread-oauth2"]) {
    expect(allow(`${env}${name}`, "Continue with Microsoft"), name).toBeNull();
    expect(allow(`${env}${name}`, "Continue with Google"), name).toBe("Google");
  }
  for (const name of ["microsoft.evil", "azurefake", "liveness", "windowslivex", "live-evil", "office3650", "google-oauth2"]) {
    expect(allow(`${env}${name}`, "Continue with Microsoft"), name).toBe("Microsoft");
  }
  expect(allow(`${env}google-oauth2`, "Continue with Google")).toBeNull();
  for (const name of ["google", "google-oauth2", "google-apps", "google.com", "google-workspace", "Google"]) {
    expect(allow(`${env}${name}`), name).toBeNull();
  }
  for (const name of ["googlefake", "google-evil", "goog", "google2", "xgoogle"]) {
    expect(allow(`${env}${name}`), name).toBe("Google");
  }
});

test("the query of a form action and a formaction is read for every tenant family", () => {
  const cases: Array<[string, string]> = [
    ["https://example-prod.okta.com/oauth2/v1/authorize?idp=0oa1", "https://example-prod.okta.com/oauth2/v1/authorize"],
    ["https://example-prod.auth.eu-west-1.amazoncognito.com/oauth2/authorize?identity_provider=Google", "https://example-prod.auth.eu-west-1.amazoncognito.com/oauth2/authorize"],
    ["https://example-prod.auth0.com/authorize?connection=google-oauth2", "https://example-prod.auth0.com/authorize"],
  ];
  for (const [hinted, bare] of cases) {
    expect(brand(`<form method="post"><button formaction="${hinted}">Continue with Google</button></form>`), hinted).toBeNull();
    expect(brand(`<form method="post"><button formaction="${bare}">Continue with Google</button></form>`), bare).toBe("Google");
    expect(brand(`<form action="${hinted}" method="post"><input type="password"><button>Continue with Google</button></form>`), hinted).toBeNull();
    expect(brand(`<form action="${bare}" method="post"><input type="password"><button>Continue with Google</button></form>`), bare).toBe("Google");
  }
});

// ── ranking reads the destination as the parser does (#1495) ──────────────────────────────────────────────

test("a backslash, tab-split or space-led protocol-relative destination gets the long read of its label like an https one", () => {
  // The phrase sits past 256 nodes of empty children: only the long read (given to off-site and sign-in controls) reaches it.
  const label = `${"<i></i>".repeat(400)}Sign in with Google`;
  for (const href of ["https://other.example/x", "//other.example/x", "/\\other.example/x", "\\\\other.example/x", "/&#9;/other.example/x", "/&#10;/other.example/x", " //other.example/x", "&#9;//other.example/x"]) {
    expect(brand(`<a href="${href}">${label}</a>`), href).toBe("Google");
  }
});

test("a plain local destination is still not given the long read", () => {
  const label = `${"<i></i>".repeat(400)}Sign in with Google`;
  for (const href of ["/signin-not-auth-looking", "/x", "x/y", "#top"]) {
    expect(brand(`<a href="${href}">${label}</a>`), href).toBeNull();
  }
});

// ── the classification against how a URL parser resolves the same text (#1495) ──────────────────────────────

const BASE = "https://example.com/";
const RESOLVE_PREFIXES = ["", " ", "\t", "\n", "\r", "\u0000", "\u0001", "\u001f", "\u0020", "\t\n ", "\u0000\t "];
const RESOLVE_OPENERS = [
  "//", "\\\\", "/\\", "\\/", "/\t/", "/\n/", "/\r/", "\t//", "\n//", "/ /", "///", "////", "\\\\\\", "/\\/", "\\//",
  "https://", "http://", "HTTPS://", "hTtP://", "https:/\\", "https:\\\\", "https:\\/", "http:\\\\", "http:/\\", "http:", "https:", "ws://", "wss://", "ftp://", "ftp:",
  "/", "/.", "/./", "/..", "/../", "/.//", "/..//", "/./\\", "./", "../", "./\\", "../\\", "x/", "x//", "x/\\", "?", "#", "?//", "#//", "/%2f", "/%5c", "%2f%2f", "%5c%5c", "/%09/", "/%0a/", "/%0d/",
  "javascript:", "data:", "mailto:", "tel:", "blob:", "about:", "file://", "file:",
];
const RESOLVE_BODIES = ["other.example/x", "other.example", "example.com.other.example/x", "other.example:8443/x", "user@other.example/x", "example.com@other.example/x", "x"];

test("a destination a parser sends to another host is never classified as plainly local, and is read", () => {
  let checked = 0;
  let crossOrigin = 0;
  for (const prefix of RESOLVE_PREFIXES) {
    for (const opener of RESOLVE_OPENERS) {
      for (const body of RESOLVE_BODIES) {
        const href = `${prefix}${opener}${body}`;
        let resolved: URL;
        try {
          resolved = new URL(href, BASE);
        } catch {
          continue;
        }
        checked++;
        // Another host, by what `new URL` makes of it: (non-hierarchical schemes have no host and are ignored by the rule).
        if (resolved.hostname === "" || resolved.hostname === "example.com") continue;
        crossOrigin++;
        const text = urlText(href);
        expect(text === "" || PLAIN_LOCAL_HREF.test(text), `plainly local: ${JSON.stringify(href)} -> ${resolved.href}`).toBe(false);
        expect(looksOffSite(href), `not read: ${JSON.stringify(href)} -> ${resolved.href}`).toBe(true);
      }
    }
  }
  // The sweep means something: a large set, most of it cross-origin.
  expect(checked).toBeGreaterThan(3_000);
  expect(crossOrigin).toBeGreaterThan(1_000);
});

test("a plainly local destination resolves to the page's own host", () => {
  for (const prefix of RESOLVE_PREFIXES) {
    for (const opener of RESOLVE_OPENERS) {
      for (const body of RESOLVE_BODIES) {
        const href = `${prefix}${opener}${body}`;
        const text = urlText(href);
        if (!(text === "" || PLAIN_LOCAL_HREF.test(text))) continue;
        let resolved: URL;
        try {
          resolved = new URL(href, BASE);
        } catch {
          continue;
        }
        expect(resolved.hostname, `${JSON.stringify(href)} -> ${resolved.href}`).toBe("example.com");
      }
    }
  }
});

test("a sign-in path is found however it is padded: past 300 characters, after a long query, or in the query", () => {
  const label = `${"<i></i>".repeat(400)}Sign in with Google`;
  // Off-site by host: always read. Local-looking with a sign-in path only past 300 characters: a local link is dropped (it
  // cannot be off-brand), so the case that matters is a cross-host link whose path or query is long.
  for (const href of [`https://other.example/${"a".repeat(400)}/signin`, `https://other.example/a?${"q=1&".repeat(200)}next=/login`, `//other.example/${"b".repeat(5_000)}`]) {
    expect(brand(`<a href="${href}">${label}</a>`), href.slice(0, 40)).toBe("Google");
  }
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
