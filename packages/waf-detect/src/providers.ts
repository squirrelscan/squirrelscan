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
    // `x-cdn` was `Incapsula`; Imperva now sends its own name there (#604).
    headers: [{ name: "x-cdn", pattern: /incapsula|imperva/i }, { name: "x-iinfo" }],
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

/**
 * The path of the script a Cloudflare challenge page loads to run the
 * challenge (`/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1`).
 * Only a challenge loads it. Every page with JavaScript Detections or Bot Fight
 * Mode also loads a script from `/cdn-cgi/challenge-platform/`
 * (`scripts/jsd/main.js`), so the bare directory says the site is on
 * Cloudflare, not that the page is a challenge (#666).
 */
export const CLOUDFLARE_CHALLENGE_SCRIPT = /\/cdn-cgi\/challenge-platform\/(?:h\/[\w-]+\/)?orchestrate\//i;

/** Akamai's deny-page reference id, such as `Reference #18.9d367a83.1614887475.2b3c78d`. */
const AKAMAI_REFERENCE_ID = /reference\s*#\s*\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i;

/** Imperva's block-page line with its id: `Incapsula incident ID: 1234000280151781213-1234`. */
const IMPERVA_INCIDENT_LINE = /incapsula incident id\s*(?::|&#58;)?\s*(?:<[^>]*>\s*)*\d/i;

/** A dash as block pages write it: hyphen, en dash, or either as an entity. */
const DASH = "(?:-|\\u2013|&#8211;|&ndash;)";

/**
 * Content-based WAF signatures: markup, script hosts and reference formats the
 * provider's own infrastructure emits. Never the provider's name or a phrase a
 * page could print while talking about it: a blog post that mentions Imperva is
 * not behind Imperva (#667).
 */
export const CONTENT_PATTERNS: {
  provider: WafProvider;
  patterns: RegExp[];
  confidence: "high" | "medium";
}[] = [
  {
    provider: "cloudflare",
    patterns: [
      // The legacy "I'm Under Attack" interstitial's line, in full.
      /checking your browser before accessing/i,
      // Error pages print the ray id after the label; the label alone is prose.
      /cloudflare ray id:?\s*(?:<[^>]*>\s*)*[0-9a-f]{6,}\b/i,
      /cf-browser-verification/i,
      /__cf_chl_/,
      /_cf_chl_opt/,
      // Attribution only: JSD pages load from here too, so this says the site
      // is on Cloudflare, never that the page is a challenge (that is
      // CLOUDFLARE_CHALLENGE_SCRIPT, in CHALLENGE_MARKUP_PATTERNS).
      /\/cdn-cgi\/challenge-platform\//i,
    ],
    confidence: "high",
  },
  {
    provider: "akamai",
    patterns: [
      AKAMAI_REFERENCE_ID,
      // Akamai deny/challenge pages entity-encode the reference line in the
      // raw HTML ("Reference&#32;&#35;18&#46;..."), so the plain-# pattern
      // above never sees it (#802).
      /reference&#32;&#35;\s*\d/i,
      // Newer deny pages link the reference to Akamai's error host.
      /errors(?:\.|&#46;)edgesuite(?:\.|&#46;)net/i,
    ],
    confidence: "medium",
  },
  {
    provider: "sucuri",
    // The block page's title and heading, in full.
    patterns: [
      new RegExp(`sucuri website ?firewall\\s*${DASH}\\s*(?:cloudproxy\\s*${DASH}\\s*)?access denied`, "i"),
      new RegExp(`access denied\\s*${DASH}\\s*sucuri website ?firewall`, "i"),
    ],
    confidence: "high",
  },
  {
    provider: "imperva",
    // The block page's incident line carries its id, and Imperva serves its
    // own scripts and block iframe from /_Incapsula_Resource.
    patterns: [IMPERVA_INCIDENT_LINE, /\/_Incapsula_Resource\b/i],
    confidence: "high",
  },
  {
    provider: "datadome",
    // The tag's host, the captcha host, and the key the tag is configured with.
    patterns: [/js\.datadome\.co\b/i, /captcha-delivery\.com\b/i, /\bddjskey\b/],
    confidence: "medium",
  },
  {
    provider: "perimeterx",
    patterns: [/px-captcha/i, /_pxCaptcha/, /\b_pxAppId\b/, /client\.perimeterx\.net\b/i],
    confidence: "high",
  },
  {
    provider: "kasada",
    // KPSDK is Kasada's client object; its script is ips.js under two UUIDs.
    patterns: [
      /\bwindow\.KPSDK\b/,
      /\bKPSDK\.configure\b/,
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/ips\.js\b/i,
    ],
    confidence: "medium",
  },
];

/**
 * Markup only a challenge or block page carries. With a challenge status or a
 * WAF's own headers or markup it marks the page as a challenge, even at 200.
 */
export const CHALLENGE_MARKUP_PATTERNS = [
  /cf-browser-verification/i,
  /__cf_chl_/i,
  /_cf_chl_opt/,
  CLOUDFLARE_CHALLENGE_SCRIPT,
  IMPERVA_INCIDENT_LINE,
  // Akamai's real deny page tag-breaks the heading (<H1>Access Denied</H1>)
  // and entity-encodes the reference ("Reference&#32;&#35;18&#46;..."), so the
  // combined text pattern below misses it; &#32;&#35; is Akamai-specific enough
  // to stand alone (#802). The plain reference id needs the denial before it: a
  // troubleshooting page can quote one. The gap between them stays bounded: each
  // "access denied" in the 10 KB sample costs at most a 2 KB scan.
  /reference&#32;&#35;\s*\d/i,
  new RegExp(`access denied[\\s\\S]{0,2000}?${AKAMAI_REFERENCE_ID.source}`, "i"),
  /_pxCaptcha/i,
  /px-captcha/i,
];

/**
 * What a challenge page says, which an ordinary page can say too ("just a
 * moment", in a recipe). It marks a challenge only together with a challenge
 * status: a 200 page on a protected site that says it is still content (#666).
 */
export const CHALLENGE_TEXT_PATTERNS = [
  /checking your browser/i,
  /just a moment/i,
  /access denied[^<]{0,120}(reference\s*#|incident id)/i,
];

export const WAF_CHALLENGE_STATUS_CODES = new Set([401, 403, 429, 503]);

/**
 * Fingerprints for provider bot-challenge interstitials served at HTTP 200 (#513).
 * DataDome/Kasada answer with 200 and no generic interstitial string, so
 * CHALLENGE_MARKUP_PATTERNS and CHALLENGE_TEXT_PATTERNS miss them. Both tiers only count on a tiny-text
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
