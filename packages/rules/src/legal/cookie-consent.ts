// legal/cookie-consent - Cookie consent mechanism check
//
// Context-aware: gated OFF for personal sites / portfolios (a static personal
// page with no commerce or data collection rarely needs a consent banner — the
// check is pure noise there). When it does run and a GDPR audience is detected,
// a missing consent mechanism is escalated from informational to a warning.

import type { Document, Element } from "linkedom";

import { SITE_TYPES, type SiteType } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { isGdprJurisdiction } from "./jurisdiction";

// Vendor tokens matched ONLY against structural attributes (script src/id,
// element id/class) — never against page prose — so a blog post that merely
// mentions gdpr/cookies no longer registers as a consent mechanism (#1141).
const CMP_TOKENS = [
  "cookiebot",
  "cybotcookiebot",
  "onetrust",
  "optanon",
  "cookielaw",
  "cookieyes",
  "cookie-law-info",
  "usercentrics",
  "iubenda",
  "didomi",
  "osano",
  "quantcast",
  "qc-cmp",
  "termly",
  "trustarc",
  "truste",
  "axeptio",
  "cookieconsent",
  "cookie-consent",
  "cookie_consent",
  "cookiescript",
  "cookie-script",
  "complianz",
  "cmplz",
  "consentmanager",
  "borlabs",
  "klaro",
  "tarteaucitron",
  "sourcepoint",
  "civic-cookie",
  "cookiehub",
  "cookie-notice",
  "cookie-banner",
  "cookie_banner",
  "cookiebanner",
  "consent-banner",
];

// CMP loader script/stylesheet URLs (host + path fragments the vendors ship).
const CMP_RESOURCE_PATTERNS: RegExp[] = [
  /cookiebot/i,
  /cookielaw|onetrust|optanon/i,
  /usercentrics/i,
  /cookieyes/i,
  /iubenda/i,
  /didomi/i,
  /osano/i,
  /quantcast|quantcount|qc-cmp/i,
  /termly/i,
  /trustarc|truste/i,
  /axeptio/i,
  /cookieconsent/i,
  /cookie-?script/i,
  /complianz|cmplz/i,
  /consentmanager/i,
  /borlabs/i,
  /klaro/i,
  /tarteaucitron/i,
  /sourcepoint|sp-prod|cmp\.sp/i,
  /cookiehub/i,
  // Shopify ships a first-party consent banner (shopifycloud/privacy-banner) —
  // a huge store cohort whose banner has no third-party CMP loader.
  /shopifycloud\/(privacy-banner|consent-tracking)|privacy-banner\/storefront/i,
];

// Known CMP banner/dialog containers (present in the DOM once the widget mounts).
const CMP_SELECTORS = [
  "#onetrust-banner-sdk",
  "#onetrust-consent-sdk",
  "#ot-sdk-container",
  "#CybotCookiebotDialog",
  "#usercentrics-root",
  "#usercentrics-cmp-ui",
  "#cookiescript_injected",
  "#cookie-law-info-bar",
  ".cli-bar-container",
  "#iubenda-cs-banner",
  ".iubenda-cs-banner",
  "#didomi-host",
  "#osano-cm-window",
  ".osano-cm-window",
  "#termly-code-snippet-support",
  "#axeptio_overlay",
  "#qc-cmp2-container",
  ".qc-cmp2-container",
  ".cmplz-cookiebanner",
  "#BorlabsCookieBox",
  ".cc-window",
];

// Unambiguous cookie-consent widget id/class fragments. A container keyed with
// one of these IS a consent mechanism on its own — this catches server-rendered
// localized banners whose button text we cannot enumerate.
const CONSENT_WIDGET_TOKENS = [
  "cookie-banner",
  "cookiebanner",
  "cookie_banner",
  "cookie-consent",
  "cookieconsent",
  "cookie_consent",
  "cookie-notice",
  "cookie_notice",
  "cookie-law",
  "cookielaw",
  "cookie-bar",
  "cookie-popup",
  "cookie-disclaimer",
  "consent-banner",
  "consent-manager",
  "gdpr-banner",
  "gdpr-consent",
];

// Accept/reject/manage semantics that corroborate an interactive consent widget.
// Includes the major EU languages so localized banners are not missed.
const CONSENT_ACTION_RE =
  /\b(accept|reject|allow|decline|deny|agree|disagree|got it|manage|preferences|consent|akzeptieren|zustimmen|einverstanden|ablehnen|accepter|refuser|accepto|aceptar|rechazar|accetta|accetto|aceitar|akkoord|godkänn|godta|tillad|zaakceptuj)\b/i;

function attrHay(el: Element): string {
  return `${el.getAttribute("id") || ""} ${el.getAttribute("class") || ""}`.toLowerCase();
}

// A CMP loader script/stylesheet, or a vendor bootstrap attribute.
function hasCmpResource(doc: Document): boolean {
  for (const s of doc.querySelectorAll("script")) {
    const src = s.getAttribute("src") || "";
    if (src && CMP_RESOURCE_PATTERNS.some((p) => p.test(src))) return true;
    const id = (s.getAttribute("id") || "").toLowerCase();
    if (id && CMP_TOKENS.some((t) => id.includes(t))) return true;
    // Vendor bootstrap data-attributes on the loader tag.
    if (
      s.hasAttribute("data-domain-script") || // OneTrust
      s.hasAttribute("data-cbid") || // Cookiebot
      s.hasAttribute("data-usercentrics") // Usercentrics
    ) {
      return true;
    }
  }
  // Only resource-loading links count — a rel=canonical/author link that happens
  // to point at a CMP vendor's site is not a consent mechanism.
  const RESOURCE_RELS = new Set(["stylesheet", "preload", "prefetch", "modulepreload"]);
  for (const l of doc.querySelectorAll("link[href][rel]")) {
    const rels = (l.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    if (!rels.some((r) => RESOURCE_RELS.has(r))) continue;
    const href = l.getAttribute("href") || "";
    if (href && CMP_RESOURCE_PATTERNS.some((p) => p.test(href))) return true;
  }
  return false;
}

// A known CMP banner container mounted in the DOM.
function hasCmpContainer(doc: Document): boolean {
  return CMP_SELECTORS.some((sel) => {
    try {
      return doc.querySelector(sel) !== null;
    } catch {
      return false;
    }
  });
}

// A self-hosted banner: an element keyed as cookie/consent (or a dialog about
// cookies) that also carries an accept/reject-style control. Requiring the
// control is what keeps prose about cookies from passing.
function hasInteractiveConsent(doc: Document): boolean {
  // Substring attribute selectors are case-insensitive (`i` flag) so class/id
  // values like `CookieConsent` are still discovered — attrHay() lowercases only
  // after selection, so a case-sensitive selector would never surface them.
  const selectors = [
    "[id*='cookie' i]",
    "[class*='cookie' i]",
    "[id*='consent' i]",
    "[class*='consent' i]",
    "[role='dialog']",
    "[role='alertdialog']",
    "[aria-modal='true']",
  ];
  const regions = new Set<Element>();
  for (const sel of selectors) {
    try {
      for (const el of doc.querySelectorAll(sel)) regions.add(el as Element);
    } catch {
      // Skip selectors the parser rejects.
    }
  }

  for (const region of regions) {
    const hay = attrHay(region);
    // An unambiguous cookie-consent widget container is sufficient on its own.
    if (CONSENT_WIDGET_TOKENS.some((t) => hay.includes(t))) return true;

    // Otherwise the region must be about cookies (a bare `consent`-keyed widget
    // or generic dialog without cookie context does not qualify — #1141 (b)) AND
    // carry an accept/reject control.
    const aboutCookies =
      hay.includes("cookie") || (region.textContent || "").toLowerCase().includes("cookie");
    if (!aboutCookies) continue;

    for (const control of region.querySelectorAll(
      "button, a, input[type='button'], input[type='submit'], [role='button']",
    )) {
      const label = `${control.textContent || ""} ${
        control.getAttribute("value") || ""
      } ${control.getAttribute("aria-label") || ""}`;
      if (CONSENT_ACTION_RE.test(label)) return true;
    }
  }
  return false;
}

function hasConsentMechanism(doc: Document): boolean {
  return hasCmpResource(doc) || hasCmpContainer(doc) || hasInteractiveConsent(doc);
}

// Every site type EXCEPT the low-value ones (a personal page / portfolio with no
// commerce or analytics rarely sets cookies that require consent). Declaring the
// positive list (vs. an exclusion set) keeps the `appliesWhen` contract simple:
// the rule applies only when the resolved type is one of these.
const SITE_TYPES_NEEDING_CONSENT: SiteType[] = SITE_TYPES.filter(
  (t): t is SiteType => t !== "personal" && t !== "portfolio",
);

export const cookieConsentRule: Rule = {
  meta: {
    id: "legal/cookie-consent",
    name: "Cookie Consent",
    description: "Checks for cookie consent mechanism",
    solution:
      "Cookie consent is required under GDPR and ePrivacy regulations for EU users. Implement a consent banner that: allows users to accept/reject non-essential cookies, doesn't pre-check optional cookies, stores consent preferences, and blocks tracking cookies until consent. Use tools like CookieYes, OneTrust, or Cookiebot.",
    category: "legal",
    scope: "page",
    severity: "info",
    weight: 4,
    // Personal sites / portfolios collect little data and rarely need a banner —
    // skip with a visible reason. Any other site type (and offline / no-metadata
    // / low-confidence) runs the check as today.
    appliesWhen: { siteTypes: SITE_TYPES_NEEDING_CONSENT },
    // A soft-404 error page legitimately has no consent banner — skip rather
    // than warn "no consent mechanism" on a broken URL (the #1174 false positive).
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Structural signals only — CMP loader script/stylesheet, a known CMP banner
    // container, or a cookie/consent-keyed widget with an accept/reject control.
    // Never a raw-HTML text scan, which flagged prose about cookies (#1141).
    if (hasConsentMechanism(doc)) {
      checks.push({
        name: "cookie-consent",
        status: "pass",
        message: "Cookie consent mechanism detected",
      });
    } else {
      // Escalate to a warning when the audience is GDPR-bound — consent is a hard
      // requirement there, not a nicety. Otherwise stay informational.
      const gdpr = isGdprJurisdiction(ctx.siteMetadata);
      checks.push({
        name: "cookie-consent",
        status: gdpr ? "warn" : "info",
        message: gdpr
          ? "No cookie consent mechanism detected — required for your EU/UK (GDPR) audience"
          : "No cookie consent mechanism detected",
        value: "Required for GDPR compliance if using cookies",
      });
    }

    return { checks };
  },
};
