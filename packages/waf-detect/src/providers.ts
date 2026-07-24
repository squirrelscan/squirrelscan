import type { WafProvider } from "./types";

/** Header-based WAF signatures */
export const HEADER_PATTERNS: {
  provider: WafProvider;
  headers: { name: string; pattern?: RegExp }[];
  confidence: "high" | "medium";
}[] = [
  {
    provider: "cloudflare",
    headers: [
      { name: "cf-ray" },
      { name: "server", pattern: /cloudflare/i },
      { name: "cf-cache-status" },
    ],
    confidence: "high",
  },
  {
    provider: "akamai",
    headers: [
      { name: "server", pattern: /akamaighost/i },
      { name: "x-akamai-transformed" },
      { name: "x-akamai-request-id" },
    ],
    confidence: "high",
  },
  {
    provider: "aws-waf",
    headers: [{ name: "x-amzn-requestid" }, { name: "x-amz-apigw-id" }, { name: "x-amz-cf-id" }],
    confidence: "medium",
  },
  {
    provider: "sucuri",
    headers: [{ name: "x-sucuri-id" }, { name: "x-sucuri-cache" }],
    confidence: "high",
  },
  {
    provider: "imperva",
    headers: [{ name: "x-cdn", pattern: /incapsula/i }, { name: "x-iinfo" }],
    confidence: "high",
  },
  {
    provider: "datadome",
    headers: [{ name: "x-datadome" }, { name: "x-dd-b" }],
    confidence: "high",
  },
  {
    provider: "perimeterx",
    headers: [{ name: "x-px-pp" }, { name: "x-px-gt" }],
    confidence: "high",
  },
];

/** Content-based WAF signatures (challenge/block pages) */
export const CONTENT_PATTERNS: {
  provider: WafProvider;
  patterns: RegExp[];
  confidence: "high" | "medium";
}[] = [
  {
    provider: "cloudflare",
    patterns: [
      /checking your browser/i,
      /cloudflare ray id/i,
      /cf-browser-verification/i,
      /__cf_chl_/,
      /challenge-platform/i,
    ],
    confidence: "high",
  },
  {
    provider: "akamai",
    patterns: [
      /access denied.*akamai/i,
      /reference\s*#\s*[\d.]+/i,
      // Akamai deny/challenge pages entity-encode the reference line in the
      // raw HTML ("Reference&#32;&#35;18&#46;..."), so the plain-# pattern
      // above never sees it (#802).
      /reference&#32;&#35;\s*\d/i,
    ],
    confidence: "medium",
  },
  {
    provider: "sucuri",
    patterns: [/sucuri website firewall/i, /access denied - sucuri/i],
    confidence: "high",
  },
  {
    provider: "imperva",
    patterns: [/incapsula incident id/i, /powered by incapsula/i, /imperva/i],
    confidence: "high",
  },
  {
    provider: "datadome",
    patterns: [/datadome/i, /dd\.js/],
    confidence: "medium",
  },
  {
    provider: "perimeterx",
    patterns: [/px-captcha/i, /perimeterx/i, /_pxCaptcha/],
    confidence: "high",
  },
  {
    provider: "kasada",
    patterns: [/ips\.js/i, /cd\.js/, /kasada/i],
    confidence: "medium",
  },
];

/** Challenge interstitial patterns for WAF challenge page detection */
export const CHALLENGE_INTERSTITIAL_PATTERNS = [
  /checking your browser/i,
  /cf-browser-verification/i,
  /__cf_chl_/i,
  /challenge-platform/i,
  /just a moment/i,
  /incapsula incident id/i,
  /access denied[^<]{0,120}(reference\s*#|incident id)/i,
  // Akamai's real deny page tag-breaks the heading (<H1>Access Denied</H1>)
  // and entity-encodes the reference ("Reference&#32;&#35;18&#46;..."), so the
  // combined pattern above misses it; &#32;&#35; is Akamai-specific enough to
  // stand alone (#802).
  /reference&#32;&#35;\s*\d/i,
  /_pxCaptcha/i,
  /px-captcha/i,
];

export const WAF_CHALLENGE_STATUS_CODES = new Set([401, 403, 429, 503]);

/**
 * Fingerprints for provider bot-challenge interstitials served at HTTP 200 (#513).
 * DataDome/Kasada answer with 200 and no generic interstitial string, so
 * CHALLENGE_INTERSTITIAL_PATTERNS misses them. Both tiers only count on a tiny-text
 * body (see CHALLENGE_INTERSTITIAL_MAX_TEXT). `strongMarkers` are challenge-only hosts,
 * trusted at any status. `weakMarkers` also load on a protected site's normal pages
 * (e.g. a sparse SPA shell that embeds the WAF SDK), so they additionally require a
 * WAF challenge status — otherwise a real 200 page would be dropped as blocked.
 */
export const CHALLENGE_200_SIGNATURES: {
  provider: WafProvider;
  strongMarkers: RegExp[];
  weakMarkers: RegExp[];
}[] = [
  {
    provider: "datadome",
    // captcha-delivery.com is DataDome's captcha host — injected only on the block/challenge interstitial
    strongMarkers: [/captcha-delivery\.com/i],
    weakMarkers: [],
  },
  {
    provider: "kasada",
    // Kasada has no challenge-only host (ips.js loads on every page); its interstitial is a tiny KPSDK-only body
    strongMarkers: [],
    weakMarkers: [/window\.KPSDK/i, /KPSDK\.configure/i, /x-kpsdk-ct/i, /\/ips\.js\b/i],
  },
];

/** A 200 challenge interstitial carries almost no visible text (heading + captcha), unlike real content. */
export const CHALLENGE_INTERSTITIAL_MAX_TEXT = 600;

/** Human-readable WAF provider names */
const WAF_PROVIDER_NAMES: Record<WafProvider, string> = {
  cloudflare: "Cloudflare",
  akamai: "Akamai",
  "aws-waf": "AWS WAF",
  sucuri: "Sucuri",
  imperva: "Imperva/Incapsula",
  datadome: "DataDome",
  perimeterx: "PerimeterX",
  kasada: "Kasada",
  unknown: "Unknown WAF",
};

export function getWafProviderName(provider: WafProvider): string {
  return WAF_PROVIDER_NAMES[provider];
}

/**
 * Tech-icon slug per provider (served from squirrelscan.com/tech-icons/<slug>.png).
 * Slugs match the tech-detect fingerprint icons so WAF-detected technologies
 * render the same logo as fingerprint-detected ones. perimeterx maps to the
 * HUMAN Security logo (acquired/rebranded).
 */
const WAF_PROVIDER_ICONS: Partial<Record<WafProvider, string>> = {
  cloudflare: "cloudflare",
  akamai: "akamai",
  "aws-waf": "aws",
  sucuri: "sucuri-firewall",
  imperva: "imperva-incapsula",
  datadome: "datadome",
  perimeterx: "humansecurity",
  kasada: "kasada",
};

/** Icon slug for a provider; undefined for `unknown` (no logo to show). */
export function getWafProviderIcon(provider: WafProvider): string | undefined {
  return WAF_PROVIDER_ICONS[provider];
}
