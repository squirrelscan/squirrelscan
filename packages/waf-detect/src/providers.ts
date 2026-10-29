import type { WafBlockProvider, WafProvider } from "./types";

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
      // Set only on a response Cloudflare answered with a challenge.
      { name: "cf-mitigated", pattern: /^challenge$/i },
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
    // The action AWS WAF took (challenge, captcha). Not `x-amz-cf-id` (that is
    // CloudFront, which most AWS sites use without WAF) nor `x-amzn-requestid`
    // / `x-amz-apigw-id` (API Gateway and Lambda): AWS infrastructure is not
    // the WAF (#750).
    headers: [{ name: "x-amzn-waf-action", pattern: /^(?:challenge|captcha)$/i }],
    confidence: "high",
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
    // `x-px-blocked: 1` is on the block page itself, never on a served page.
    headers: [{ name: "x-px-pp" }, { name: "x-px-gt" }, { name: "x-px-blocked" }],
    confidence: "high",
  },
  {
    provider: "kasada",
    // The challenge flow's response headers (client token, challenge data).
    headers: [{ name: "x-kpsdk-ct" }, { name: "x-kpsdk-cd" }, { name: "x-kpsdk-r" }],
    confidence: "high",
  },
];

/**
 * Cookie NAMES each provider sets (`set-cookie`), read without the value: the
 * value is a session or a token, and nothing here needs it (#750). A vendor's
 * cookie names it as surely as its headers do, so cookies ATTRIBUTE a
 * response. They never prove a block: these products set them on every
 * response of a site they protect, a real 403 included, so `isLikelyWafBlock`
 * ignores them. Medium confidence for the same reason.
 */
export const COOKIE_PATTERNS: {
  provider: WafProvider;
  names: RegExp[];
  confidence: "high" | "medium";
}[] = [
  {
    provider: "cloudflare",
    names: [/^__cf_bm$/, /^cf_clearance$/, /^__cflb$/, /^_cfuvid$/],
    confidence: "medium",
  },
  { provider: "datadome", names: [/^datadome$/i], confidence: "medium" },
  // `_px3`, `_pxvid`, `_pxhd`, `_px2`, `_pxde`: the `_px` prefix is HUMAN's.
  { provider: "perimeterx", names: [/^_px(?:\d|vid|hd|de|ff_)/], confidence: "medium" },
  { provider: "kasada", names: [/^KP_UIDz(?:-ssn)?$/], confidence: "medium" },
  // Bot Manager's sensor and session cookies, not Akamai's CDN.
  { provider: "akamai", names: [/^_abck$/, /^ak_bmsc$/, /^bm_sz$/, /^bm_sv$/], confidence: "medium" },
  {
    provider: "imperva",
    names: [/^incap_ses_/, /^visid_incap_/, /^nlbi_/, /^reese84$/],
    confidence: "medium",
  },
  { provider: "aws-waf", names: [/^aws-waf-token$/], confidence: "medium" },
];

/**
 * Which provider a response is attributed to when several signal at once,
 * most specific first. Bot-management vendors sit behind a CDN, so a CDN's
 * headers appear on nearly every response they block: DataDome on Cloudflare
 * is a DataDome block (#750). Cloudflare is last because it is the commonest
 * CDN in front of everything else.
 */
export const PROVIDER_PRECEDENCE: readonly WafProvider[] = [
  "datadome",
  "perimeterx",
  "kasada",
  "aws-waf",
  "imperva",
  "sucuri",
  "akamai",
  "cloudflare",
  "unknown",
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
export const AKAMAI_REFERENCE_ID = /reference\s*#\s*\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i;

/** Imperva's block-page line with its id: `Incapsula incident ID: 1234000280151781213-1234`. */
export const IMPERVA_INCIDENT_LINE = /incapsula incident id\s*(?::|&#58;)?\s*(?:<[^>]*>\s*)*\d/i;

/** A dash as block pages write it: hyphen, en dash, or either as an entity. */
export const DASH = "(?:-|\\u2013|&#8211;|&ndash;)";

/**
 * Content-based WAF signatures: markup, script hosts and reference formats the
 * provider's own infrastructure emits. Never the provider's name or a phrase a
 * page could print while talking about it: a blog post that mentions Imperva is
 * not behind Imperva (#667).
 *
 * Each entry names the view it is read in (#693, see views.ts): a script or
 * resource signature in `markup`, tags and inline scripts only, so a tutorial
 * that prints the tag is not attributed; block-page wording in `text`, page
 * text without code, so a support page quoting an incident line in a code
 * block is not either. Wording is text by nature: block pages print it in a
 * `<p>`, and CloudFront's in a `<pre>`.
 */
export const CONTENT_PATTERNS: {
  provider: WafProvider;
  view: "markup" | "text";
  patterns: RegExp[];
  confidence: "high" | "medium";
}[] = [
  {
    provider: "cloudflare",
    view: "text",
    patterns: [
      // The legacy "I'm Under Attack" interstitial's line, in full.
      /checking your browser before accessing/i,
      // Error pages print the ray id after the label; the label alone is prose.
      /cloudflare ray id:?\s*(?:<[^>]*>\s*)*[0-9a-f]{6,}\b/i,
    ],
    confidence: "high",
  },
  {
    provider: "cloudflare",
    view: "markup",
    patterns: [
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
    view: "text",
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
    view: "text",
    // The block page's title and heading, in full.
    patterns: [
      new RegExp(`sucuri website ?firewall\\s*${DASH}\\s*(?:cloudproxy\\s*${DASH}\\s*)?access denied`, "i"),
      new RegExp(`access denied\\s*${DASH}\\s*sucuri website ?firewall`, "i"),
    ],
    confidence: "high",
  },
  {
    provider: "imperva",
    view: "text",
    // The block page's incident line carries its id.
    patterns: [IMPERVA_INCIDENT_LINE],
    confidence: "high",
  },
  {
    provider: "imperva",
    view: "markup",
    // Imperva serves its own scripts and block iframe from /_Incapsula_Resource.
    patterns: [/\/_Incapsula_Resource\b/i],
    confidence: "high",
  },
  {
    provider: "datadome",
    view: "markup",
    // The tag's host, a script from the captcha host, and the key the tag is
    // configured with. Hosts are matched where a script loads them (`src=`).
    patterns: [
      /js\.datadome\.co\b/i,
      /src\s*=\s*["']?(?:https?:)?\/\/[\w.-]*captcha-delivery\.com/i,
      /\bddjskey\b/,
    ],
    confidence: "medium",
  },
  {
    provider: "perimeterx",
    view: "markup",
    patterns: [
      /px-captcha/i,
      /_pxCaptcha/,
      /\b_pxAppId\b/,
      /src\s*=\s*["']?(?:https?:)?\/\/client\.perimeterx\.net/i,
    ],
    confidence: "high",
  },
  {
    provider: "aws-waf",
    view: "markup",
    // The challenge script AWS WAF injects, loaded from its token host. Matched
    // where a script loads it (`src=`), like DataDome's captcha host, so the
    // scan starts only at a src attribute and stays linear.
    patterns: [
      /src\s*=\s*["']?(?:https?:)?\/\/[\w.-]*\.token\.awswaf\.com\//i,
      /\bAwsWafIntegration\b/,
    ],
    confidence: "high",
  },
  {
    provider: "aws-waf",
    view: "text",
    // CloudFront's own error page for a request AWS WAF blocked: a Block action
    // answers a plain 403 with no WAF header, and this page is all it carries.
    // Medium: CloudFront prints the same page for a geo restriction. An S3
    // AccessDenied (a real missing object) is XML and never matches.
    patterns: [/request blocked\.[\s\S]{0,600}?generated by cloudfront \(cloudfront\)/i],
    confidence: "medium",
  },
  {
    provider: "kasada",
    view: "markup",
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
export const CHALLENGE_MARKUP_SIGNATURES: {
  view: "markup" | "text";
  pattern: RegExp;
}[] = [
  { view: "markup", pattern: /cf-browser-verification/i },
  { view: "markup", pattern: /__cf_chl_/i },
  { view: "markup", pattern: /_cf_chl_opt/ },
  { view: "markup", pattern: CLOUDFLARE_CHALLENGE_SCRIPT },
  { view: "text", pattern: IMPERVA_INCIDENT_LINE },
  // Akamai's real deny page tag-breaks the heading (<H1>Access Denied</H1>)
  // and entity-encodes the reference ("Reference&#32;&#35;18&#46;..."), so the
  // combined text pattern below misses it; &#32;&#35; is Akamai-specific enough
  // to stand alone (#802). The plain reference id needs the denial before it: a
  // troubleshooting page can quote one. The gap between them stays bounded: each
  // "access denied" in the 10 KB sample costs at most a 2 KB scan.
  { view: "text", pattern: /reference&#32;&#35;\s*\d/i },
  { view: "text", pattern: new RegExp(`access denied[\\s\\S]{0,2000}?${AKAMAI_REFERENCE_ID.source}`, "i") },
  // HUMAN's captcha mount point is classify.ts's rule, which also needs a refusal
  // status and its app id: a bare `px-captcha` is a widget a real page can embed.
];

/** The challenge markup patterns alone; each is read in its view (#693). */
export const CHALLENGE_MARKUP_PATTERNS = CHALLENGE_MARKUP_SIGNATURES.map(({ pattern }) => pattern);

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
 * The statuses a perimeter provider answers a challenge or block with, beyond
 * `WAF_CHALLENGE_STATUS_CODES`: AWS WAF's Challenge is a 202 and its CAPTCHA a
 * 405 (AWS WAF developer guide), and Akamai, F5, DataDome and Imperva serve
 * their deny or challenge pages at 200.
 */
export const WAF_BLOCK_STATUS_CODES = new Set([200, 202, 401, 403, 405, 406, 429, 503]);

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
    // Not followed by more host: `captcha-delivery.com.attacker.example` is not DataDome.
    // Matched where a tag loads it, and not followed by more host.
    strongMarkers: [
      /(?:src|href|action)\s*=\s*["']?(?:https?:)?\/\/(?:[a-z0-9-]{1,63}\.){0,3}captcha-delivery\.com(?![\w-]|\.[\w-])/i,
    ],
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
const WAF_PROVIDER_NAMES: Record<WafBlockProvider, string> = {
  cloudflare: "Cloudflare",
  akamai: "Akamai",
  "aws-waf": "AWS WAF",
  sucuri: "Sucuri",
  imperva: "Imperva/Incapsula",
  datadome: "DataDome",
  perimeterx: "PerimeterX",
  kasada: "Kasada",
  f5: "F5",
  vercel: "Vercel",
  wordfence: "Wordfence",
  radware: "Radware",
  unknown: "Unknown WAF",
};

export function getWafProviderName(provider: WafBlockProvider): string {
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
