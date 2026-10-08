// Vendor hosts a page needs at runtime but its HTML never names (the beacon a
// tag posts to, the iframe a widget opens). Data, not logic: vendor hosts drift,
// so every entry carries the date it was last checked against the vendor's own
// CSP guidance, and a test fails when an entry has no date.
//
// Vendors are detected from the URLs the page names, compared by parsed hostname
// and path, never by a regular expression over a host string.
//
// Sources: Google tag platform CSP guide (developers.google.com/tag-platform/
// security/guides/csp), PostHog "Content Security Policy and ingestion domains",
// Stripe "Security at Stripe" CSP guidance, Cloudflare Turnstile CSP reference.

import type { CspFetchKind } from "./csp-source-match";

export type VendorCategory = "analytics" | "ads" | "payments" | "captcha" | "form" | "booking";

/** What a page shows: every URL it names (comments removed) and its code text. */
export interface PageSignals {
  urls: URL[];
  code: string;
}

/** A URL a vendor's tag loads: exact host, optional path prefix and query value. */
export interface UrlSignal {
  host: string;
  pathPrefix?: string;
  param?: { name: string; pattern: RegExp };
}

/** Facts derived from the page that gate a need, see {@link deriveFlags}. */
export type VendorFlag =
  | "ads-link"
  | "gtm-noscript"
  | "posthog-us"
  | "posthog-eu"
  | "posthog-us-assets"
  | "posthog-eu-assets";

export interface VendorNeed {
  directive: CspFetchKind;
  /** Concrete hostnames; a policy allowing `*.example.com` satisfies `a.example.com`. */
  hosts: string[];
  /** Only needed when the page shows this fact (for example an Ads link). */
  when?: VendorFlag;
}

export interface CspVendor {
  id: string;
  name: string;
  category: VendorCategory;
  /** ISO date this entry was last checked against the vendor's documentation. */
  lastVerified: string;
  /** The vendor is in use when any URL signal or any code pattern matches. */
  detect: { urls?: UrlSignal[]; code?: RegExp[] };
  /** Suppresses the whole vendor, for example a first-party proxy the code names. */
  unless?: (signals: PageSignals) => boolean;
  needs: VendorNeed[];
}

export function urlMatches(url: URL, signal: UrlSignal): boolean {
  if (url.hostname.toLowerCase() !== signal.host) return false;
  if (signal.pathPrefix && !url.pathname.startsWith(signal.pathPrefix)) return false;
  if (signal.param) {
    const value = url.searchParams.get(signal.param.name);
    if (value === null || !signal.param.pattern.test(value)) return false;
  }
  return true;
}

const hasHost = (signals: PageSignals, hosts: readonly string[], pathPrefix?: string) =>
  signals.urls.some(
    (u) => hosts.includes(u.hostname.toLowerCase()) && (!pathPrefix || u.pathname.startsWith(pathPrefix)),
  );

export function deriveFlags(signals: PageSignals): Set<VendorFlag> {
  const flags = new Set<VendorFlag>();
  if (
    /AW-\d{6,}/.test(signals.code) ||
    hasHost(signals, ["www.googleadservices.com", "googleads.g.doubleclick.net"])
  ) {
    flags.add("ads-link");
  }
  if (hasHost(signals, ["www.googletagmanager.com"], "/ns.html")) flags.add("gtm-noscript");
  if (hasHost(signals, ["us.i.posthog.com", "us-assets.i.posthog.com"])) flags.add("posthog-us");
  if (hasHost(signals, ["eu.i.posthog.com", "eu-assets.i.posthog.com"])) flags.add("posthog-eu");
  if (hasHost(signals, ["us-assets.i.posthog.com"])) flags.add("posthog-us-assets");
  if (hasHost(signals, ["eu-assets.i.posthog.com"])) flags.add("posthog-eu-assets");
  return flags;
}

/** PostHog pointed at a first-party reverse proxy has no vendor host to allow. */
function posthogProxied({ code }: PageSignals): boolean {
  const apiHost = /api_host\s*:\s*['"]([^'"]*)['"]/.exec(code)?.[1];
  if (!apiHost) return false;
  try {
    const host = new URL(apiHost).hostname.toLowerCase();
    return host !== "posthog.com" && !host.endsWith(".posthog.com");
  } catch {
    return true;
  }
}

const GOOGLE_TAG = "www.googletagmanager.com";
const RECAPTCHA_PATH = "/recaptcha/";

export const CSP_VENDORS: readonly CspVendor[] = [
  {
    id: "ga4",
    name: "Google Analytics 4",
    category: "analytics",
    lastVerified: "2026-10-08",
    detect: {
      urls: [{ host: GOOGLE_TAG, pathPrefix: "/gtag/js", param: { name: "id", pattern: /^G-[A-Z0-9]{6,}$/i } }],
      code: [/gtag\(\s*['"]config['"]\s*,\s*['"]G-[A-Z0-9]{6,}['"]/i],
    },
    needs: [
      { directive: "connect", hosts: ["www.google-analytics.com", "analytics.google.com"] },
      // An Ads-linked property also reports through the Ads and Signals endpoints.
      { directive: "connect", hosts: ["www.google.com", "stats.g.doubleclick.net"], when: "ads-link" },
    ],
  },
  {
    id: "google-ads",
    name: "Google Ads",
    category: "ads",
    lastVerified: "2026-10-08",
    detect: {
      urls: [
        { host: GOOGLE_TAG, pathPrefix: "/gtag/js", param: { name: "id", pattern: /^AW-\d{6,}$/i } },
        { host: "www.googleadservices.com", pathPrefix: "/pagead/conversion" },
      ],
      code: [/gtag\(\s*['"]config['"]\s*,\s*['"]AW-\d{6,}['"]/i],
    },
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
    detect: {
      urls: [
        { host: GOOGLE_TAG, pathPrefix: "/gtm.js", param: { name: "id", pattern: /^GTM-[A-Z0-9]+$/i } },
        { host: GOOGLE_TAG, pathPrefix: "/ns.html", param: { name: "id", pattern: /^GTM-/i } },
      ],
    },
    needs: [
      { directive: "script", hosts: [GOOGLE_TAG] },
      { directive: "frame", hosts: [GOOGLE_TAG], when: "gtm-noscript" },
    ],
  },
  {
    id: "posthog",
    name: "PostHog",
    category: "analytics",
    lastVerified: "2026-10-08",
    detect: {
      urls: [
        { host: "us.i.posthog.com" },
        { host: "eu.i.posthog.com" },
        { host: "us-assets.i.posthog.com" },
        { host: "eu-assets.i.posthog.com" },
      ],
      code: [/posthog\.init\(\s*['"]phc_/i],
    },
    unless: posthogProxied,
    needs: [
      { directive: "script", hosts: ["us-assets.i.posthog.com"], when: "posthog-us-assets" },
      { directive: "script", hosts: ["eu-assets.i.posthog.com"], when: "posthog-eu-assets" },
      { directive: "connect", hosts: ["us.i.posthog.com"], when: "posthog-us" },
      { directive: "connect", hosts: ["eu.i.posthog.com"], when: "posthog-eu" },
    ],
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "payments",
    lastVerified: "2026-10-08",
    detect: { urls: [{ host: "js.stripe.com", pathPrefix: "/" }] },
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
    detect: { urls: [{ host: "challenges.cloudflare.com", pathPrefix: "/turnstile/" }] },
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
    detect: {
      urls: [
        { host: "www.google.com", pathPrefix: `${RECAPTCHA_PATH}api.js` },
        { host: "www.google.com", pathPrefix: `${RECAPTCHA_PATH}enterprise.js` },
      ],
    },
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
    detect: {
      urls: [
        { host: "www.recaptcha.net", pathPrefix: `${RECAPTCHA_PATH}api.js` },
        { host: "www.recaptcha.net", pathPrefix: `${RECAPTCHA_PATH}enterprise.js` },
      ],
    },
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
