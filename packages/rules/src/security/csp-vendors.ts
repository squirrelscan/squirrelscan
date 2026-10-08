// Vendor hosts a page needs at runtime but its HTML never names (the beacon a
// tag posts to, the iframe a widget opens). Data, not logic: vendor hosts drift,
// so every entry carries the date it was last checked against the vendor's own
// CSP guidance, and a test fails when an entry has no date.
//
// Sources: Google tag platform CSP guide (developers.google.com/tag-platform/
// security/guides/csp), PostHog "Content Security Policy and ingestion domains",
// Stripe "Security at Stripe" CSP guidance, Cloudflare Turnstile CSP reference.

import type { CspFetchKind } from "./csp-source-match";

export type VendorCategory = "analytics" | "ads" | "payments" | "captcha" | "form" | "booking";

export interface VendorNeed {
  directive: CspFetchKind;
  /** Concrete hostnames; a policy allowing `*.example.com` satisfies `a.example.com`. */
  hosts: string[];
  /** Only needed when the page HTML also matches this (for example an Ads link). */
  when?: RegExp;
}

export interface CspVendor {
  id: string;
  name: string;
  category: VendorCategory;
  /** ISO date this entry was last checked against the vendor's documentation. */
  lastVerified: string;
  /** The vendor is in use when any pattern matches the page HTML. */
  detect: RegExp[];
  /** Suppresses the whole vendor, for example a first-party proxy the HTML names. */
  unless?: RegExp;
  needs: VendorNeed[];
}

const ADS_LINK = /AW-\d{6,}|googleadservices\.com|googleads\.g\.doubleclick\.net/;

export const CSP_VENDORS: readonly CspVendor[] = [
  {
    id: "ga4",
    name: "Google Analytics 4",
    category: "analytics",
    lastVerified: "2026-10-08",
    detect: [/gtag\/js\?id=G-[A-Z0-9]{6,}/i, /gtag\(\s*['"]config['"]\s*,\s*['"]G-[A-Z0-9]{6,}['"]/i],
    needs: [
      { directive: "connect", hosts: ["www.google-analytics.com", "analytics.google.com"] },
      // An Ads-linked property also reports through the Ads and Signals endpoints.
      { directive: "connect", hosts: ["www.google.com", "stats.g.doubleclick.net"], when: ADS_LINK },
    ],
  },
  {
    id: "google-ads",
    name: "Google Ads",
    category: "ads",
    lastVerified: "2026-10-08",
    detect: [/gtag\/js\?id=AW-\d{6,}/i, /gtag\(\s*['"]config['"]\s*,\s*['"]AW-\d{6,}['"]/i, /googleadservices\.com\/pagead\/conversion/i],
    needs: [
      { directive: "script", hosts: ["googleads.g.doubleclick.net", "www.googleadservices.com", "www.google.com"] },
      { directive: "frame", hosts: ["td.doubleclick.net"] },
    ],
  },
  {
    id: "gtm",
    name: "Google Tag Manager",
    category: "analytics",
    lastVerified: "2026-10-08",
    detect: [/googletagmanager\.com\/gtm\.js\?id=GTM-[A-Z0-9]+/i, /googletagmanager\.com\/ns\.html\?id=GTM-/i],
    needs: [
      { directive: "script", hosts: ["www.googletagmanager.com"] },
      { directive: "frame", hosts: ["www.googletagmanager.com"], when: /googletagmanager\.com\/ns\.html/i },
    ],
  },
  {
    id: "posthog",
    name: "PostHog",
    category: "analytics",
    lastVerified: "2026-10-08",
    detect: [/\b(?:us|eu)(?:-assets)?\.i\.posthog\.com/i, /posthog\.init\(\s*['"]phc_/i],
    // A first-party reverse proxy (api_host pointed at the site) has no vendor host to allow.
    unless: /api_host\s*:\s*['"](?!https?:\/\/[a-z0-9.-]*posthog\.com)/i,
    needs: [
      { directive: "script", hosts: ["us-assets.i.posthog.com"], when: /us-assets\.i\.posthog\.com/i },
      { directive: "script", hosts: ["eu-assets.i.posthog.com"], when: /eu-assets\.i\.posthog\.com/i },
      { directive: "connect", hosts: ["us.i.posthog.com"], when: /\bus(?:-assets)?\.i\.posthog\.com/i },
      { directive: "connect", hosts: ["eu.i.posthog.com"], when: /\beu(?:-assets)?\.i\.posthog\.com/i },
    ],
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "payments",
    lastVerified: "2026-10-08",
    detect: [/js\.stripe\.com\/(?:v3|basil|acacia|clover|[a-z]+\/)/i],
    needs: [
      { directive: "script", hosts: ["js.stripe.com"] },
      { directive: "connect", hosts: ["api.stripe.com"] },
      { directive: "frame", hosts: ["js.stripe.com", "hooks.stripe.com"] },
    ],
  },
  {
    id: "turnstile",
    name: "Cloudflare Turnstile",
    category: "captcha",
    lastVerified: "2026-10-08",
    detect: [/challenges\.cloudflare\.com\/turnstile\//i],
    needs: [
      { directive: "script", hosts: ["challenges.cloudflare.com"] },
      { directive: "frame", hosts: ["challenges.cloudflare.com"] },
    ],
  },
  {
    id: "recaptcha",
    name: "Google reCAPTCHA",
    category: "captcha",
    lastVerified: "2026-10-08",
    detect: [/(?:www\.)?google\.com\/recaptcha\/(?:api|enterprise)\.js/i],
    needs: [
      { directive: "script", hosts: ["www.google.com", "www.gstatic.com"] },
      { directive: "frame", hosts: ["www.google.com"] },
    ],
  },
  {
    id: "recaptcha-net",
    name: "Google reCAPTCHA (recaptcha.net)",
    category: "captcha",
    lastVerified: "2026-10-08",
    detect: [/(?:www\.)?recaptcha\.net\/recaptcha\/(?:api|enterprise)\.js/i],
    needs: [
      { directive: "script", hosts: ["www.recaptcha.net", "www.gstatic.com"] },
      { directive: "frame", hosts: ["www.recaptcha.net"] },
    ],
  },
];

/**
 * Hosts a page can load whose vendor is known without detecting the vendor
 * itself. Only the severity of a blocked host reads this: a blocked booking or
 * form widget is an error, an unknown host a warning.
 */
const HOST_CATEGORIES: ReadonlyArray<{ suffix: string; category: VendorCategory }> = [
  { suffix: "google-analytics.com", category: "analytics" },
  { suffix: "analytics.google.com", category: "analytics" },
  { suffix: "googletagmanager.com", category: "analytics" },
  { suffix: "posthog.com", category: "analytics" },
  { suffix: "plausible.io", category: "analytics" },
  { suffix: "segment.com", category: "analytics" },
  { suffix: "doubleclick.net", category: "ads" },
  { suffix: "googleadservices.com", category: "ads" },
  { suffix: "googlesyndication.com", category: "ads" },
  { suffix: "connect.facebook.net", category: "ads" },
  { suffix: "stripe.com", category: "payments" },
  { suffix: "paypal.com", category: "payments" },
  { suffix: "paypalobjects.com", category: "payments" },
  { suffix: "challenges.cloudflare.com", category: "captcha" },
  { suffix: "hcaptcha.com", category: "captcha" },
  { suffix: "recaptcha.net", category: "captcha" },
  { suffix: "calendly.com", category: "booking" },
  { suffix: "acuityscheduling.com", category: "booking" },
  { suffix: "typeform.com", category: "form" },
  { suffix: "hsforms.net", category: "form" },
  { suffix: "hsforms.com", category: "form" },
];

/** The vendor category a blocked host belongs to, when it is one the table knows. */
export function hostCategory(host: string): VendorCategory | undefined {
  const h = host.toLowerCase();
  // google.com and gstatic.com serve maps, fonts and more, so they are absent
  // here: a vendor need attributes them, never the bare host.
  return HOST_CATEGORIES.find((e) => h === e.suffix || h.endsWith(`.${e.suffix}`))?.category;
}
