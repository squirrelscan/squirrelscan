// legal/cookie-consent + social/share-buttons: the single-pass element scan and
// the un-lowercased share patterns must answer exactly as the multi-selector
// and lowercase-copy versions did (pub#270). The reference below IS the old
// logic, kept verbatim, so the two are compared on the same parsed document.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { cookieConsentRule } from "../src/legal/cookie-consent";
import { shareButtonsRule } from "../src/social/share-buttons";
import type { ParsedPage, RuleContext } from "../src/types";

function ctxOf(html: string, url = "https://example.com/"): RuleContext {
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    siteMetadata: undefined,
    options: {},
  };
}

// --- reference: the pre-#270 container + interactive logic (no CMP resources
// appear in these fixtures, so hasCmpResource is false for both sides) --------
const OLD_CMP_SELECTORS = [
  "#onetrust-banner-sdk", "#onetrust-consent-sdk", "#ot-sdk-container", "#CybotCookiebotDialog",
  "#usercentrics-root", "#usercentrics-cmp-ui", "#cookiescript_injected", "#cookie-law-info-bar",
  ".cli-bar-container", "#iubenda-cs-banner", ".iubenda-cs-banner", "#didomi-host",
  "#osano-cm-window", ".osano-cm-window", "#termly-code-snippet-support", "#axeptio_overlay",
  "#qc-cmp2-container", ".qc-cmp2-container", ".cmplz-cookiebanner", "#BorlabsCookieBox", ".cc-window",
];
const WIDGET_TOKENS = [
  "cookie-banner", "cookiebanner", "cookie_banner", "cookie-consent", "cookieconsent",
  "cookie_consent", "cookie-notice", "cookie_notice", "cookie-law", "cookielaw", "cookie-bar",
  "cookie-popup", "cookie-disclaimer", "consent-banner", "consent-manager", "gdpr-banner", "gdpr-consent",
];
const ACTION_RE =
  /\b(accept|reject|allow|decline|deny|agree|disagree|got it|manage|preferences|consent|akzeptieren|zustimmen|einverstanden|ablehnen|accepter|refuser|accepto|aceptar|rechazar|accetta|accetto|aceitar|akkoord|godkänn|godta|tillad|zaakceptuj)\b/i;

function referenceDetects(doc: any): boolean {
  if (OLD_CMP_SELECTORS.some((s) => doc.querySelector(s) !== null)) return true;
  const regions = new Set<any>();
  for (const sel of [
    "[id*='cookie' i]", "[class*='cookie' i]", "[id*='consent' i]", "[class*='consent' i]",
    "[role='dialog']", "[role='alertdialog']", "[aria-modal='true']",
  ]) {
    for (const el of doc.querySelectorAll(sel)) regions.add(el);
  }
  for (const region of regions) {
    const hay = `${region.getAttribute("id") || ""} ${region.getAttribute("class") || ""}`.toLowerCase();
    if (WIDGET_TOKENS.some((t) => hay.includes(t))) return true;
    const about = hay.includes("cookie") || (region.textContent || "").toLowerCase().includes("cookie");
    if (!about) continue;
    for (const c of region.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']")) {
      const label = `${c.textContent || ""} ${c.getAttribute("value") || ""} ${c.getAttribute("aria-label") || ""}`;
      if (ACTION_RE.test(label)) return true;
    }
  }
  return false;
}

function detects(html: string): boolean {
  return cookieConsentRule.run(ctxOf(html)).checks[0]?.status === "pass";
}

// seeded PRNG so a failure reproduces
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const IDS = [
  "", "main", "onetrust-banner-sdk", "OneTrust-Banner-SDK", "CybotCookiebotDialog", "cybotcookiebotdialog",
  "didomi-host", "didomi-host2", "x didomi-host", "cookie-banner", "CookieConsent", "my-consent", "COOKIE",
  "consent-x", "qc-cmp2-container", "BorlabsCookieBox", "cookieK", "coÅkie",
];
const CLASSES = [
  "", "a b", "cc-window", "cc-window-x", "x cc-window y", "CC-WINDOW", "cc-window\tfoo", "foo cc-window",
  "foo\ncc-window\n", "osano-cm-window", "cmplz-cookiebanner", "cookie-notice", "CookieNotice", "ConsentBox",
  "cli-bar-container", "iubenda-cs-banner x", "nav cookie", "plain",
];
const ROLES = ["", "dialog", "Dialog", "alertdialog", "button", "region"];
const MODALS = ["", "true", "TRUE", "false"];
const TEXTS = ["Accept all", "We use cookies", "hello", "Reject", "Weiter", "cookies: Allow"];

function randomPage(rand: () => number): string {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const n = 1 + Math.floor(rand() * 8);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const attrs: string[] = [];
    const id = rand() < 0.5 ? pick(IDS) : "";
    const cls = rand() < 0.5 ? pick(CLASSES) : "";
    const role = rand() < 0.3 ? pick(ROLES) : "";
    const modal = rand() < 0.2 ? pick(MODALS) : "";
    if (id) attrs.push(`id="${id}"`);
    if (cls) attrs.push(`class="${cls}"`);
    if (role) attrs.push(`role="${role}"`);
    if (modal) attrs.push(`aria-modal="${modal}"`);
    const inner =
      rand() < 0.6
        ? `<p>${pick(TEXTS)}</p><button>${pick(TEXTS)}</button>`
        : `<span>${pick(TEXTS)}</span>`;
    out.push(`<div ${attrs.join(" ")}>${inner}</div>`);
  }
  return `<html><body>${out.join("")}</body></html>`;
}

describe("legal/cookie-consent single-pass scan matches the selector version (pub#270)", () => {
  test("2000 randomised pages answer identically", () => {
    const rand = rng(270);
    let passes = 0;
    for (let i = 0; i < 2000; i++) {
      const html = randomPage(rand);
      const expected = referenceDetects(ctxOf(html).parsed.document);
      const actual = detects(html);
      if (actual !== expected) throw new Error(`diverged on page ${i}: ${html}`);
      if (expected) passes++;
    }
    // the corpus must exercise both answers, or the loop proves nothing
    expect(passes).toBeGreaterThan(200);
    expect(passes).toBeLessThan(1800);
  });

  test("a CMP container is found on any element, anywhere", () => {
    expect(detects(`<html><body><section><p><i class="x cc-window"></i></p></section></body></html>`)).toBe(true);
    expect(detects(`<html><body><div id="didomi-host"></div></body></html>`)).toBe(true);
    expect(detects(`<html><body><div id="DIDOMI-HOST"></div></body></html>`)).toBe(false);
  });
});

describe("social/share-buttons answers like the lowercase-copy version (pub#270)", () => {
  const PATTERNS = [
    /share.*facebook|facebook.*share/i,
    /share.*twitter|twitter.*share/i,
    /share.*linkedin|linkedin.*share/i,
    /addthis|addtoany|shareaholic|sumo-share/i,
  ];
  const oldAnswer = (html: string) => {
    const lower = html.toLowerCase();
    return PATTERNS.some((p) => p.test(lower));
  };
  // the rule reads patterns from page.html and links from the parsed document,
  // so parse once and vary only page.html (a parse per call would take minutes)
  const base = ctxOf("<html><body><p>x</p></body></html>", "https://example.com/x");
  const newAnswer = (html: string) =>
    shareButtonsRule.run({ ...base, page: { ...base.page, html } }).checks[0]?.status === "pass";

  test("every BMP character, spliced into each pattern's letters, answers identically", () => {
    const seeds = ["share facebook", "facebook share", "share twitter", "share linkedin", "addthis", "sumo-share", "shareaholic", "addtoany"];
    for (let cp = 0; cp < 0x10000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCharCode(cp);
      for (const seed of seeds) {
        for (let at = 0; at < seed.length; at += 3) {
          const text = seed.slice(0, at) + ch + seed.slice(at + 1); // replace one letter
          if (newAnswer(text) !== oldAnswer(text)) {
            throw new Error(`diverged on U+${cp.toString(16)} in "${text}"`);
          }
        }
      }
    }
  }, 60_000);

  test("Kelvin sign still matches as before; plain case folding unchanged", () => {
    expect(newAnswer("share facebooK")).toBe(true);
    expect(newAnswer("SHARE FACEBOOK")).toBe(true);
    expect(newAnswer("share faceb00k")).toBe(false);
  });
});
