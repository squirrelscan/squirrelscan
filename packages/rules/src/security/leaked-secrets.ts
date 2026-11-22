// security/leaked-secrets - Detect leaked API keys and secrets in HTML/JS

import {
  REPORT_LIMITS,
  clampItemString,
  type ScriptContentData,
} from "@squirrelscan/core-contracts";
import { SECRET_KEY_LOOKBEHIND_SIZE } from "@squirrelscan/utils/constants";

import type {
  Rule,
  RuleContext,
  RuleResult,
  CheckItem,
  CheckResult,
  ParsedPage,
} from "../types";

import { shannonEntropy } from "../integrity/signals";
import { sharedRegex } from "../shared-regex";
import { detached } from "../shared/detach";
import { blankedOffsets } from "../shared/inline-script-text";
import {
  buildGramIndex,
  mayContain,
  mayMatch,
  withPrefilter,
  type GramIndex,
} from "../shared/literal-prefilter";
import { serializeChildren } from "../shared/serialized-prefix";
import {
  jwtMatchIsSuspect,
  refineFinding,
  type Confidence,
  type FindingExtra,
} from "./secrets/confidence";
import {
  decodeForLocation,
  decodeHtmlEntities,
  scanBase64Blobs,
  type ReportedLocation,
} from "./secrets/decode";
import { isHtmlBody, sourceMapSources } from "./secrets/sources";
export type { ReportedLocation, SecretLocation } from "./secrets/decode";

// Secret detection patterns with service names
// Sources: secrets-patterns-db, secret-regex-list, gitleaks patterns

// Type for fast patterns (distinctive prefixes, run on all content)
type FastPattern = {
  name: string;
  pattern: RegExp;
  confidence: "high" | "medium";
  /**
   * Lowercase literals, at least one of which every match contains. The
   * prefilter runs the regex only on content that contains one (#357): a
   * page without `ghp_` in it never pays for the GitHub pattern. Provider
   * tokens (`akia`, `sk_live_`, `hooks.slack.com`), never English words —
   * the corpus meta-test fails a pattern whose own positives do not contain
   * one of its keywords, and one that declares none.
   */
  keywords?: string[];
  /**
   * The value is a bare shape the key gave meaning to, not a provider
   * token: skip it when it carries whitespace or has under
   * GENERIC_MIN_ENTROPY bits per character (an i18n label, a placeholder).
   */
  generic?: boolean;
  /**
   * Keys that are designed to ship in client-side code (Stripe pk_*,
   * Google browser keys, OAuth client IDs, Sentry DSNs…). Reported as an
   * informational check, never as a leak — flagging them as errors is a
   * false positive that erodes trust in the security category.
   */
  publicByDesign?: boolean;
  /**
   * The pattern anchors on a credential word that can appear part-way through
   * a longer key (`cache-api-key`, `checksum_secret`). Such a match reads the
   * rest of its own key and drops out if that key says "digest" — see
   * startsInsideDigestKey.
   */
  keyAnchored?: boolean;
  /**
   * The shape is also a word: PayPal's `[Aa][Zz]…{60,}` is `azione-di-…` in
   * an Italian URL slug. Such a match counts only in a value position
   * (`clientId:"…"`, `client-id=…`), never in prose or a path (#357).
   */
  valuePosition?: boolean;
  /**
   * The pattern's only distinctive mark is a separator, not a prefix:
   * `<8-10 digits>:` opens every Telegram bot token and also every third row
   * of a minified decoder table. The characters AFTER that separator are
   * drawn at random in a real token — 35 from a 64-character alphabet never
   * measured below 4.0 bits per character over 500 draws — so a tail under
   * this floor is a table, a digit run or a repeated nibble (#2218).
   */
  minTailEntropy?: number;
  /**
   * The prefix is a convention other vendors copy: `sk_live_` is Stripe's,
   * and it is also what a widget vendor names its own secret keys. A token
   * that runs on past the provider's format (`sk_live_…_acmewidget`) is
   * still reported, under this prefix with the provider left unknown,
   * rather than under the provider's name. See continuedTokenEnd.
   */
  sharedPrefix?: string;
  /**
   * A check the match has to pass in its surroundings before it counts: the
   * shapes that are only a credential when something specific follows or
   * does not surround them (a PEM header needs its key material, a Twitter
   * bearer is not the interior of a base64 payload). Gets the matched value,
   * the scanned text and the match's index in it.
   */
  accept?: (value: string, content: string, index: number) => boolean;
};

// Type for context patterns (generic patterns, only run if keyword present)
// These avoid catastrophic backtracking from (?=.*keyword) lookaheads
//
// Every pattern in this tier is BARE-SHAPE: a run of hex/base64/alphanumeric
// characters with no distinctive prefix, which is also the shape of a SHA-256
// digest, an SRI hash, a git object id, an ETag and a UUID. The brand keyword
// ("together", "datadog"…) is the only thing separating them from ordinary page
// content, and brand words show up in ordinary prose. So a match here is also
// read against the key it is assigned to: never reported under a digest key or
// with no assignment at all — see classifyKeyContext.
type ContextPattern = {
  name: string;
  keyword: string; // Lowercase keyword to check via includes() first
  pattern: RegExp; // Pattern WITHOUT lookahead
  confidence: "high" | "medium";
  /**
   * A client-side key documented as public (Shopify Storefront tokens,
   * Mixpanel project tokens, Raygun API keys): reported under the
   * informational check, and claimed AHEAD of the generic assignments, which
   * would otherwise read `storefrontAccessToken:"…"` as a medium leak.
   */
  publicByDesign?: boolean;
  /**
   * The provider issues two keys of one shape, one public and one secret
   * (Pusher's app key and secret, Uploadcare's public and secret keys,
   * Algolia's search-only and admin keys), and only the key the value is
   * assigned to tells them apart (#359). Gets that key's name, or undefined
   * when none can be read; a pattern with this set reports only when it
   * returns true. Pusher's and Uploadcare's pairs are a predicate and its
   * complement, so the two never both claim, nor both miss, a value.
   */
  keyName?: (key: string | undefined) => boolean;
};

// Fast patterns - have distinctive prefixes, safe to run on all content
//
// Every entry here carries its own literal marker — a prefix (`sk-`, `ghp_`,
// `AKIA`, `pk_live_`), a suffix (`NRAL`, `-us1`), a URL host, a PEM header, or a
// required keyword in the pattern itself (AWS secret key, the generic
// assignments, `Bearer`). None of them match a bare digest, so none of them
// needs the whole key-context gate the CONTEXT_PATTERNS tier uses.
//
// The entries whose marker is a keyword the key can merely CONTAIN — the AWS
// secret key and the three generic assignments — carry `keyAnchored` instead,
// a much narrower check: the key they matched part-way through must not be a
// digest key. `cache-api-key` is a cache key however it ends.
// Exported for tests/literal-prefilter.test.ts, which proves that the mandatory
// literals derived from every one of these really are mandatory.
export const FAST_PATTERNS: FastPattern[] = [
  // AI/ML Services
  {
    name: "OpenAI API Key",
    pattern: /sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}/g,
    keywords: ["t3blbkfj"],
    confidence: "high",
  },
  {
    name: "OpenAI API Key (proj)",
    pattern: /sk-proj-[a-zA-Z0-9_-]{80,}/g,
    keywords: ["sk-proj-"],
    confidence: "high",
  },
  {
    name: "OpenAI API Key (legacy)",
    pattern: /sk-[a-zA-Z0-9]{32,}/g,
    keywords: ["sk-"],
    confidence: "medium",
  },
  {
    name: "Anthropic API Key",
    pattern: /sk-ant-[a-zA-Z0-9_-]{80,}/g,
    keywords: ["sk-ant-"],
    confidence: "high",
  },
  {
    name: "Groq API Key",
    pattern: /gsk_[a-zA-Z0-9]{52}/g,
    confidence: "high",
    keywords: ["gsk_"],
  },
  {
    name: "xAI (Grok) API Key",
    pattern: /xai-[a-zA-Z0-9]{48,}/g,
    keywords: ["xai-"],
    confidence: "high",
  },
  {
    name: "HuggingFace Token",
    pattern: /hf_[a-zA-Z0-9]{34}/g,
    keywords: ["hf_"],
    confidence: "high",
  },
  {
    name: "Replicate API Token",
    pattern: /r8_[a-zA-Z0-9]{37}/g,
    keywords: ["r8_"],
    confidence: "high",
  },
  {
    name: "Perplexity API Key",
    pattern: /pplx-[a-zA-Z0-9]{48}/g,
    keywords: ["pplx-"],
    confidence: "high",
  },
  {
    // `sk-or-v1-` + 64 hex. The OpenAI patterns stop at the first hyphen after
    // `sk-or`, so none of them matches it (#1309).
    name: "OpenRouter API Key",
    pattern: /sk-or-v1-[a-f0-9]{64}/g,
    keywords: ["sk-or-v1-"],
    confidence: "high",
  },
  {
    // `csk-` + 48 lowercase alphanumerics. The legacy OpenAI `sk-` pattern
    // never saw it: its prefix sits inside the word `csk-` (#1309).
    name: "Cerebras API Key",
    pattern: /csk-[a-z0-9]{40,}/g,
    keywords: ["csk-"],
    confidence: "high",
  },
  {
    name: "NVIDIA API Key",
    pattern: /nvapi-[A-Za-z0-9_-]{60,}/g,
    keywords: ["nvapi-"],
    confidence: "high",
  },
  {
    // `fw_` is a short prefix and also the start of identifiers
    // (`fw_config_name`), so the tail has to look drawn at random: upper and
    // lower case and a digit, no separator.
    name: "Fireworks AI API Key",
    pattern:
      /(?<![A-Za-z0-9_-])fw_(?=[A-Za-z0-9]{0,47}[A-Z])(?=[A-Za-z0-9]{0,47}[a-z])(?=[A-Za-z0-9]{0,47}[0-9])[A-Za-z0-9]{24,48}/g,
    keywords: ["fw_"],
    confidence: "medium",
    // A camelCase identifier with a digit (`fw_handleResizeEvent2Callback`) has the same character classes: two or more
    // lowercase-run-then-capital word boundaries is a name, a random key has almost none.
    accept: (value) => !CAMEL_CASE_WORDS_RE.test(value.slice(3)),
  },

  // Database/Backend Services
  {
    // Any JWT, whatever its `alg`: header, payload and signature, the first
    // two of them base64url JSON (`eyJ` is `{"`). Which token it is comes
    // from the decoded claims (secrets/confidence.ts, #361): a Supabase anon
    // key reports as public, a service_role key as high, an expired one or a
    // first-party session token as info, anything else medium.
    //
    // The look-behind lets only the first `eyJ` of a base64url run start a
    // match. A later one in the same run reads to the same run end and meets
    // the same `.`, so it can only fail where the first did, and without the
    // look-behind each of them re-reads the run: `eyJeyJeyJ…` was quadratic.
    name: "JSON Web Token",
    pattern:
      /eyJ(?<!eyJ[A-Za-z0-9_-]*?eyJ)[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}={0,2}/g,
    keywords: ["eyj"],
    confidence: "medium",
  },
  {
    name: "Supabase Personal Access Token",
    pattern: /sbp_[a-f0-9]{40}/g,
    keywords: ["sbp_"],
    confidence: "high",
  },
  {
    // Supabase's current key format. The publishable half is the browser
    // credential its own docs tell you to ship; the secret half is the one
    // that must never leave a server.
    name: "Supabase Publishable Key",
    pattern: /sb_publishable_[A-Za-z0-9_-]{20,}/g,
    keywords: ["sb_publishable_"],
    confidence: "medium",
    publicByDesign: true,
  },
  {
    name: "Supabase Secret Key",
    pattern: /sb_secret_[A-Za-z0-9_-]{20,}/g,
    keywords: ["sb_secret_"],
    confidence: "high",
  },
  {
    name: "MongoDB Connection String",
    pattern: /mongodb(\+srv)?:\/\/[^\s"'<>]+/gi,
    keywords: ["mongodb"],
    confidence: "high",
  },
  {
    name: "PostgreSQL Connection String",
    pattern: /postgres(ql)?:\/\/[^\s"'<>]+/gi,
    keywords: ["postgres"],
    confidence: "high",
  },
  {
    name: "MySQL Connection String",
    pattern: /mysql:\/\/[^\s"'<>]+/gi,
    keywords: ["mysql://"],
    confidence: "high",
  },
  {
    name: "Redis Connection String",
    pattern: /redis(s)?:\/\/[^\s"'<>]+/gi,
    keywords: ["redis"],
    confidence: "high",
  },
  {
    name: "PlanetScale Token",
    pattern: /pscale_tkn_[a-zA-Z0-9_-]{32,}/g,
    keywords: ["pscale_tkn_"],
    confidence: "high",
  },
  {
    name: "Neon Database Token",
    pattern: /neon_[a-zA-Z0-9_-]{32,}/g,
    keywords: ["neon_"],
    confidence: "high",
  },

  // Payment Services
  {
    name: "Stripe Live Key",
    pattern: /sk_live_[0-9a-zA-Z]{24,}/g,
    keywords: ["sk_live_"],
    confidence: "high",
    sharedPrefix: "sk_live_",
  },
  {
    name: "Stripe Test Key",
    pattern: /sk_test_[0-9a-zA-Z]{24,}/g,
    keywords: ["sk_test_"],
    confidence: "high",
    sharedPrefix: "sk_test_",
  },
  {
    // pk_live_/pk_test_ are public by design (Stripe docs)
    name: "Stripe Publishable Key",
    pattern: /pk_live_[0-9a-zA-Z]{24,}/g,
    keywords: ["pk_live_"],
    confidence: "medium",
    publicByDesign: true,
  },
  {
    // The test-mode publishable key: public like its live twin, and it can
    // only create test-mode tokens (#359).
    name: "Stripe Publishable Test Key",
    pattern: /pk_test_[0-9a-zA-Z]{24,}/g,
    keywords: ["pk_test_"],
    confidence: "medium",
    publicByDesign: true,
  },
  {
    // A restricted key carries the permissions its owner gave it; live ones
    // act on a real account (#1309).
    name: "Stripe Restricted Key",
    pattern: /rk_live_[0-9a-zA-Z]{24,}/g,
    keywords: ["rk_live_"],
    confidence: "high",
  },
  {
    // Admin API access token (`shpat_`), shared-secret and private-app
    // passwords (`shpss_`, `shppa_`) and custom-app tokens (`shpca_`): 32 hex
    // after the prefix, all of them server-side credentials (#1309).
    name: "Shopify Admin API Token",
    pattern: /shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}/g,
    keywords: ["shpat_", "shpss_", "shpca_", "shppa_"],
    confidence: "high",
    // Part of a longer word or a class selector (`.shpca_<md5>`, `x-shpat_<md5>`) is a name, not a token handed over after a
    // quote, `=`, `:` or a space. A file name (`/files/shpat_<md5>.png`) is dropped by the asset-name rule.
    accept: (_value, content, index) =>
      !/[.\w-]/.test(content[index - 1] ?? ""),
  },
  {
    name: "Square Access Token",
    pattern: /sq0atp-[0-9A-Za-z_-]{22}/g,
    keywords: ["sq0atp-"],
    confidence: "high",
  },
  {
    name: "Square OAuth Secret",
    pattern: /sq0csp-[0-9A-Za-z_-]{43}/g,
    keywords: ["sq0csp-"],
    confidence: "high",
  },

  // Cloud Providers
  {
    // `GOCSPX-` + 28 characters: the secret half of a Google OAuth client,
    // which the client ID beside it (public) never is (#1309).
    name: "Google OAuth Client Secret",
    pattern: /GOCSPX-[A-Za-z0-9_-]{28}/g,
    keywords: ["gocspx-"],
    confidence: "high",
  },
  {
    name: "AWS Access Key ID",
    pattern: /(A3T[A-Z0-9]|AKIA|AGPA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
    keywords: ["a3t", "akia", "agpa", "aroa", "aipa", "anpa", "anva", "asia"],
    confidence: "high",
  },
  {
    name: "AWS Secret Access Key",
    // Require at least "aws" or "secret" keyword before the value
    pattern:
      /(?:aws[_-]?(?:secret)?[_-]?(?:access)?[_-]?key|secret[_-]?access[_-]?key)['"]?\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi,
    confidence: "medium",
    keyAnchored: true,
    generic: true,
    keywords: ["aws", "secret"],
  },
  {
    // AIza… keys in frontend code are Maps/Firebase browser keys — meant to
    // be embedded; protection comes from referrer/API restrictions, not
    // secrecy (Firebase docs say these are not secrets)
    name: "Google API Key (browser)",
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    keywords: ["aiza"],
    confidence: "high",
    publicByDesign: true,
  },
  {
    // OAuth client IDs are public identifiers, not secrets. A digit run is
    // matched from its start only (a start inside it can only fail where the
    // run's start did): a long run of digits was quadratic.
    name: "Google OAuth Client ID",
    pattern: /(?<![0-9])[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com/g,
    keywords: [".apps.googleusercontent.com"],
    confidence: "high",
    publicByDesign: true,
  },
  {
    name: "Google OAuth Access Token",
    pattern: /ya29\.[0-9A-Za-z_-]+/g,
    keywords: ["ya29."],
    confidence: "high",
  },
  {
    name: "Azure Storage Key",
    pattern:
      /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+;/gi,
    keywords: ["defaultendpointsprotocol="],
    confidence: "high",
  },
  // After Azure Storage Key on purpose: this class covers lowercase+digits, so
  // a 60-character run inside an AccountKey was claimed here first and the
  // whole connection string then dropped as an "overlap" of it (#357).
  {
    // OAuth client IDs are public identifiers, not secrets
    name: "PayPal Client ID",
    pattern: /[Aa][Zz][Aa-zZ0-9-_]{60,}/g,
    keywords: ["az"],
    confidence: "medium",
    publicByDesign: true,
    valuePosition: true,
  },
  {
    name: "DigitalOcean Token",
    pattern: /dop_v1_[a-f0-9]{64}/g,
    keywords: ["dop_v1_"],
    confidence: "high",
  },

  // Hosting/Deployment
  {
    name: "Vercel Token",
    pattern: /vercel_[a-zA-Z0-9]{24}/gi,
    keywords: ["vercel_"],
    confidence: "high",
  },
  {
    name: "Netlify Token",
    pattern: /nfp_[a-zA-Z0-9]{40,}/g,
    keywords: ["nfp_"],
    confidence: "high",
  },
  {
    name: "Render API Key",
    pattern: /rnd_[a-zA-Z0-9]{32,}/g,
    keywords: ["rnd_"],
    confidence: "high",
  },
  {
    name: "Railway Token",
    pattern: /railway_[a-zA-Z0-9_-]{32,}/g,
    keywords: ["railway_"],
    confidence: "high",
  },

  // Version Control
  {
    name: "GitHub Personal Access Token",
    pattern: /ghp_[0-9a-zA-Z]{36}/g,
    keywords: ["ghp_"],
    confidence: "high",
  },
  {
    name: "GitHub OAuth Token",
    pattern: /gho_[0-9a-zA-Z]{36}/g,
    keywords: ["gho_"],
    confidence: "high",
  },
  {
    name: "GitHub App Token",
    pattern: /ghu_[0-9a-zA-Z]{36}/g,
    keywords: ["ghu_"],
    confidence: "high",
  },
  {
    name: "GitHub Refresh Token",
    pattern: /ghr_[0-9a-zA-Z]{36}/g,
    keywords: ["ghr_"],
    confidence: "high",
  },
  {
    name: "GitLab Personal Access Token",
    pattern: /glpat-[a-zA-Z0-9_-]{20,}/g,
    keywords: ["glpat-"],
    confidence: "high",
  },
  {
    name: "GitLab Pipeline Token",
    pattern: /glptt-[a-f0-9]{40}/g,
    keywords: ["glptt-"],
    confidence: "high",
  },
  {
    name: "Bitbucket App Password",
    pattern: /ATBB[a-zA-Z0-9]{32}/g,
    keywords: ["atbb"],
    confidence: "high",
  },

  // Communication
  {
    name: "Slack Token",
    pattern: /xox[baprs]-[0-9a-zA-Z-]{10,72}/g,
    keywords: ["xox"],
    confidence: "high",
  },
  {
    name: "Slack Webhook",
    pattern:
      /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9_]+\/B[a-zA-Z0-9_]+\/[a-zA-Z0-9_]+/g,
    keywords: ["hooks.slack.com"],
    confidence: "high",
  },
  {
    name: "Discord Webhook",
    pattern:
      /https:\/\/discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
    keywords: ["/api/webhooks/"],
    confidence: "high",
  },
  {
    // The id segment is base64 of a snowflake: 24 to 28 characters. Unbounded
    // (`{23,}`) it consumed every alphanumeric run to its end from every `M`
    // and `N` in it before backtracking for the `.`: 2.7 s on one 200 KB
    // image data URI (#365).
    name: "Discord Bot Token",
    pattern: /[MN][A-Za-z\d]{23,27}\.[\w-]{6}\.[\w-]{27}/g,
    keywords: ["."],
    confidence: "high",
  },
  {
    name: "Telegram Bot Token",
    pattern: /[0-9]{8,10}:[a-zA-Z0-9_-]{35}/g,
    keywords: [":"],
    confidence: "high",
    minTailEntropy: 3,
  },

  // Email Services
  {
    name: "Twilio Account SID",
    pattern: /AC[0-9a-f]{32}/g,
    keywords: ["ac"],
    confidence: "high",
  },
  {
    name: "SendGrid API Key",
    pattern: /SG\.[a-zA-Z0-9_-]{20,24}\.[a-zA-Z0-9_-]{39,50}/g,
    keywords: ["sg."],
    confidence: "high",
  },
  {
    name: "Mailgun API Key",
    pattern: /key-[0-9a-zA-Z]{32}/g,
    keywords: ["key-"],
    confidence: "high",
  },
  {
    name: "Mailchimp API Key",
    pattern: /[0-9a-f]{32}-us[0-9]{1,2}/g,
    keywords: ["-us"],
    confidence: "high",
  },
  {
    name: "Resend API Key",
    pattern: /re_[a-zA-Z0-9]{32,}/g,
    keywords: ["re_"],
    confidence: "high",
  },

  // Analytics/Monitoring
  {
    // DSNs are designed for client-side error reporting
    name: "Sentry DSN",
    pattern: /https:\/\/[a-f0-9]+@[a-z0-9]+\.ingest\.sentry\.io\/[0-9]+/gi,
    keywords: [".ingest.sentry.io/"],
    confidence: "high",
    publicByDesign: true,
  },
  {
    name: "New Relic License Key",
    pattern: /[A-Z0-9]{40}NRAL/g,
    keywords: ["nral"],
    confidence: "high",
  },
  // After New Relic on purpose: `DO` + 20 uppercase is the tail of any NRAL
  // key that happens to contain `DO`, and claiming that tail first dropped the
  // New Relic finding as an overlap (#357).
  {
    // `DO` plus twenty uppercase characters is also one segment of a font
    // CDN path (`/fontshare/wf/BRQA…/DOBF…/MVBF….woff2`), so the shape counts
    // only where a value goes (#2218).
    name: "DigitalOcean Spaces Key",
    pattern: /DO[A-Z0-9]{20,}/g,
    keywords: ["do"],
    confidence: "medium",
    valuePosition: true,
    accept: (value) => !isIbanShaped(value),
  },

  // Auth Services
  {
    name: "Clerk Secret Key",
    pattern: /sk_live_[a-zA-Z0-9]{40,}/g,
    keywords: ["sk_live_"],
    confidence: "high",
    sharedPrefix: "sk_live_",
  },

  // Maps/Location
  {
    // pk.* tokens are Mapbox public tokens (sk.* are the secret ones)
    name: "Mapbox Access Token",
    pattern: /pk\.[a-zA-Z0-9]{60,}/g,
    keywords: ["pk."],
    confidence: "high",
    publicByDesign: true,
  },
  {
    name: "Mapbox Secret Token",
    pattern: /sk\.[a-zA-Z0-9]{60,}/g,
    keywords: ["sk."],
    confidence: "high",
  },

  {
    // RevenueCat's public SDK keys, one per store: `appl_` (App Store), `goog_`
    // (Play), `amzn_`, `strp_` (Stripe) and `rcb_` (Web Billing). They ship in
    // the app by design. A digit in the tail keeps `goog_` an identifier
    // prefix and not a key (#1294).
    name: "RevenueCat Public SDK Key",
    pattern:
      /(?:appl|goog|amzn|strp|rcb)_(?=[A-Za-z0-9]{0,39}[0-9])[A-Za-z0-9]{28,40}/g,
    keywords: ["appl_", "goog_", "amzn_", "strp_", "rcb_"],
    confidence: "medium",
    publicByDesign: true,
    accept: (value, content, index) =>
      REVENUECAT_CONTEXT_RE.test(
        content.slice(
          Math.max(0, index - REVENUECAT_CONTEXT_REACH),
          index + value.length + REVENUECAT_CONTEXT_REACH
        )
      ),
  },

  // Crypto Keys
  {
    name: "Private Key (RSA)",
    pattern: /-----BEGIN RSA PRIVATE KEY-----/g,
    keywords: ["-----begin rsa private key-----"],
    confidence: "high",
    accept: hasPemBody,
  },
  {
    name: "Private Key (DSA)",
    pattern: /-----BEGIN DSA PRIVATE KEY-----/g,
    keywords: ["-----begin dsa private key-----"],
    confidence: "high",
    accept: hasPemBody,
  },
  {
    name: "Private Key (EC)",
    pattern: /-----BEGIN EC PRIVATE KEY-----/g,
    keywords: ["-----begin ec private key-----"],
    confidence: "high",
    accept: hasPemBody,
  },
  {
    name: "Private Key (OpenSSH)",
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g,
    keywords: ["-----begin openssh private key-----"],
    confidence: "high",
    accept: hasPemBody,
  },
  {
    name: "Private Key (PGP)",
    pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
    keywords: ["-----begin pgp private key block-----"],
    confidence: "high",
    accept: hasPemBody,
  },

  // Social/OAuth
  {
    name: "Facebook Access Token",
    pattern: /EAACEdEose0cBA[0-9A-Za-z]+/g,
    keywords: ["eaacedeose0cba"],
    confidence: "high",
  },
  {
    // Nineteen `A`s is nineteen zero bytes in base64, which is what the
    // padding of a WebP, a PNG or a zlib stream looks like — and the
    // alphabet's own `/` hands that run a clean left boundary, so the
    // boundary guard cannot see it. A token is assigned or handed to an auth
    // scheme; a payload's interior is neither (#2218).
    name: "Twitter Bearer Token",
    pattern: /AAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+/g,
    keywords: ["aaaaaaaaaaaaaaaaaaa"],
    confidence: "high",
    valuePosition: true,
    accept: plausibleTwitterBearer,
  },

  // Browser-exposed services with a prefix of their own (#359, parity with
  // trufflehog's detectors for the services a website ships to its visitors).
  {
    // Contentful's Content Management API personal access token. The
    // delivery token (CDA) has no prefix and stays in the context tier.
    name: "Contentful Management Token",
    pattern: /CFPAT-[A-Za-z0-9_-]{43}/g,
    keywords: ["cfpat-"],
    confidence: "high",
  },
  {
    // `pat` + 14 + `.` + 64 hex. `pat` is also a word, so the declared
    // literal is the separator: the dot and the 64-hex tail are what make
    // this a token, and a pattern with a sub-four-character keyword always
    // runs, exactly as before the prefilter.
    name: "Airtable Personal Access Token",
    pattern: /pat[A-Za-z0-9]{14}\.[a-f0-9]{64}/g,
    keywords: ["."],
    confidence: "high",
  },
  {
    // Notion's current integration token: `ntn_` + 11 digits + 35
    // alphanumerics.
    name: "Notion Integration Token",
    pattern: /ntn_[0-9]{11}[A-Za-z0-9]{35}/g,
    keywords: ["ntn_"],
    confidence: "high",
  },
  {
    // Notion's older integration token: `secret_` + 43 alphanumerics. The
    // prefix is a word, so the tail carries the proof: exactly 43
    // characters, upper case, lower case and a digit all present, and not a
    // camelCase identifier (`secret_handleTokenRefreshForUser2Callback…`).
    name: "Notion Integration Token (legacy)",
    pattern:
      /secret_(?=[A-Za-z0-9]{0,42}[A-Z])(?=[A-Za-z0-9]{0,42}[a-z])(?=[A-Za-z0-9]{0,42}[0-9])[A-Za-z0-9]{43}(?![A-Za-z0-9_])/g,
    keywords: ["secret_"],
    confidence: "medium",
    accept: (value) => !CAMEL_CASE_WORDS_RE.test(value.slice(7)),
  },
  {
    // The API environment variable Cloudinary prints: key and secret in one
    // URL, `cloudinary://<api_key>:<api_secret>@<cloud_name>`.
    name: "Cloudinary URL",
    pattern: /cloudinary:\/\/[0-9]{6,20}:[A-Za-z0-9_-]{20,40}@[A-Za-z0-9_-]+/g,
    keywords: ["cloudinary://"],
    confidence: "high",
  },
  {
    // OneSignal's v2 REST API keys (app and organization). The legacy
    // 48-character key has no prefix and is in the context tier.
    name: "OneSignal REST API Key",
    pattern: /os_v2_(?:app|org)_[a-z0-9]{56,}/g,
    keywords: ["os_v2_"],
    confidence: "high",
  },
  {
    // PubNub's secret key: server-side only, it signs access grants.
    name: "PubNub Secret Key",
    pattern: /sec-c-[A-Za-z0-9]{40,60}/g,
    keywords: ["sec-c-"],
    confidence: "high",
  },
  {
    // The publish key lets anyone publish to the app's channels. Apps that
    // publish from the browser ship it, so it is a review item, not high.
    name: "PubNub Publish Key",
    pattern:
      /pub-c-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    keywords: ["pub-c-"],
    confidence: "medium",
  },
  {
    // The subscribe key is what every PubNub client reads with: public.
    name: "PubNub Subscribe Key",
    pattern:
      /sub-c-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    keywords: ["sub-c-"],
    confidence: "medium",
    publicByDesign: true,
  },
  {
    // A Zapier "Catch Hook" URL: anyone holding it can post into the Zap.
    // Forms do post to these from the browser, so medium, not high.
    name: "Zapier Webhook URL",
    pattern:
      /https:\/\/hooks\.zapier\.com\/hooks\/catch\/[0-9]+\/[A-Za-z0-9]+\/?/g,
    keywords: ["hooks.zapier.com"],
    confidence: "medium",
  },
  {
    // A Google Cloud service-account key file: the `private_key_id` of a JSON
    // object whose `type` is `service_account`. The quotes may be escaped
    // (`\"`), since the file usually reaches a page as a JSON string.
    name: "GCP Service Account Key",
    pattern: /\\?"private_key_id\\?"\s*:\s*\\?"[a-f0-9]{40}\\?"/g,
    keywords: ["private_key_id"],
    confidence: "high",
    accept: (value, content, index) =>
      SERVICE_ACCOUNT_TYPE_RE.test(
        content.slice(
          Math.max(0, index - SERVICE_ACCOUNT_REACH),
          index + value.length + SERVICE_ACCOUNT_REACH
        )
      ),
  },
  {
    // An Azure Storage shared access signature: the query string of a SAS
    // URL, every parameter of which starts with `s` (`sv`, `ss`, `srt`,
    // `sp`, `se`, `st`, `spr`, `sr`, `sig`). It needs a version and an
    // expiry beside the signature. What the signature grants decides the
    // tier (secrets/confidence.ts): a read-only grant on one blob is the
    // storage service's capability URL and informational, a grant that can
    // write or delete is high.
    name: "Azure SAS Token",
    pattern:
      /(?<=[?&])(?:s[a-z]{1,4}=[^&\s"'<>]{1,128}&){1,12}sig=[A-Za-z0-9%+/]{40,}(?:=|%3D){0,2}(?:&s[a-z]{1,4}=[^&\s"'<>]{1,128}){0,12}/gi,
    keywords: ["sig="],
    confidence: "high",
    // The match opens on the first parameter, after the `?` or `&`: a URL's
    // path ends on a word character, and the prefix guard would read the
    // query string as the tail of a longer token.
    accept: (value) => /(?:^|&)sv=/i.test(value) && /(?:^|&)se=/i.test(value),
  },
  {
    // An Azure Functions key in the `code` query parameter of a function URL:
    // the function's whole authorization. A page that calls one from the
    // browser hands the key to every visitor.
    name: "Azure Function Key",
    pattern:
      /https:\/\/[a-z0-9-]+\.azurewebsites\.net\/api\/[^\s"'<>?]*\?(?:[^\s"'<>&]*&){0,10}code=[A-Za-z0-9_-]{40,}(?:=|%3D){0,2}/gi,
    keywords: [".azurewebsites.net/api/"],
    confidence: "medium",
  },
  {
    // Sentry organization auth token: `sntrys_` + base64 JSON + secret.
    name: "Sentry Organization Token",
    pattern: /sntrys_[A-Za-z0-9_+/=-]{60,}/g,
    keywords: ["sntrys_"],
    confidence: "high",
  },
  {
    name: "Sentry User Token",
    pattern: /sntryu_[a-f0-9]{64}/g,
    keywords: ["sntryu_"],
    confidence: "high",
  },
  {
    name: "Typeform Personal Access Token",
    pattern: /tfp_[A-Za-z0-9_-]{40,70}/g,
    keywords: ["tfp_"],
    confidence: "high",
  },
  {
    // An Intercom access token is base64 of `tok:<id>:<n>:<n>`, so it opens
    // `dG9rO` whatever the id.
    name: "Intercom Access Token",
    pattern: /dG9rO[A-Za-z0-9+/]{50,}={0,2}/g,
    keywords: ["dg9ro"],
    confidence: "high",
  },
  {
    // LaunchDarkly's server-side SDK key: full read of every flag and
    // segment rule, never meant for a browser.
    name: "LaunchDarkly SDK Key",
    pattern:
      /sdk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    keywords: ["sdk-"],
    confidence: "high",
  },
  {
    // The mobile key ships inside mobile apps; on a website it is a key
    // nobody meant to publish there.
    name: "LaunchDarkly Mobile Key",
    pattern:
      /mob-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    keywords: ["mob-"],
    confidence: "medium",
  },

  // Public client keys with their own prefix or key, ahead of the generic
  // assignments so the specific pattern claims the value first (#357 r3).
  {
    // posthog.init("phc_…") ships the project key to the browser by design.
    name: "PostHog Project Key",
    pattern: /phc_[A-Za-z0-9]{40,}/g,
    keywords: ["phc_"],
    confidence: "medium",
    publicByDesign: true,
  },
  {
    // The key names the public Storefront API token wherever it appears.
    name: "Shopify Storefront Access Token (key)",
    pattern:
      /storefrontAccessToken['"]?\s*(?:[:=]|\|\|=?|\?\?=?)\s*['"][a-f0-9]{32}['"]/g,
    keywords: ["storefrontaccesstoken"],
    confidence: "medium",
    publicByDesign: true,
  },
  {
    // LaunchDarkly's client-side ID: 24 hex under the key its JavaScript SDK
    // documents. Public by design: the browser SDK sends it on every request.
    name: "LaunchDarkly Client-side ID",
    pattern:
      /clientSideI[Dd]['"]?\s*(?:[:=]|\|\|=?|\?\?=?)\s*['"][a-f0-9]{24}['"]/g,
    keywords: ["clientsideid"],
    confidence: "medium",
    publicByDesign: true,
  },
  {
    // The New Relic browser agent's license key, inlined by its loader
    // snippet on every page it monitors: ingest-only and public by design.
    name: "New Relic Browser Key",
    pattern: /NRJS-[a-f0-9]{19}/g,
    keywords: ["nrjs-"],
    confidence: "medium",
    publicByDesign: true,
  },

  // Generic patterns (lower confidence, check context)
  //
  // Four things can sit between the key and its value here, and all four are
  // optional because all four are ordinary:
  //
  // - a closing quote, optionally followed by the `]` that closes a bracket
  //   access, because JSON quotes its keys and code reaches for them:
  //   `{"apiKey":"…"}`, `{"x-api-key":"…"}` and
  //   `process.env["SECRET_KEY"] || "…"` are how an embedded config blob, a
  //   `<script type="application/json">` payload and a build-time env read
  //   write an assignment. The `]` only counts WITH that quote — a bare
  //   `translations[apiKey] ||= "…"` is a lookup keyed by a variable, and the
  //   variable's name does not name the value.
  // - a `key`/`token` tail, so `SECRET_KEY` reads as one key and not as
  //   `secret` followed by something that broke the match.
  // - `||` / `??` (and their `||=` / `??=` forms) as well as `:` / `=`,
  //   because a hardcoded fallback behind an env var
  //   (`process.env.SECRET_KEY || "…"`) is one of the likeliest ways a real
  //   credential reaches a bundle: it looks safe in source and the bundler
  //   inlines it at build.
  //
  // The key has to END where the separator begins, so `secret_hash`,
  // `apiKeyHash` and `secretHash` match nothing; and because each of these
  // anchors on a credential word rather than on the start of the key, they are
  // `keyAnchored` and read their own left edge too, so `"cache-api-key"` and
  // `checksum_secret` stay digests.
  {
    name: "Generic API Key Assignment",
    pattern:
      /(?:api[_-]?key|apikey|master[_-]?key|search[_-]?key)(?:['"]\s*\]|['"]?)\s*(?:[:=]|\|\|=?|\?\?=?)\s*['"][a-zA-Z0-9_-]{20,}['"]/gi,
    confidence: "medium",
    keyAnchored: true,
    generic: true,
    keywords: [
      "api_key",
      "api-key",
      "apikey",
      "master_key",
      "master-key",
      "masterkey",
      "search_key",
      "search-key",
      "searchkey",
    ],
  },
  {
    name: "Generic Secret Assignment",
    pattern:
      /(?:secret|password|passwd|pwd)(?:[_-]?(?:key|token))?(?:['"]\s*\]|['"]?)\s*(?:[:=]|\|\|=?|\?\?=?)\s*['"][^'"]{8,}['"]/gi,
    confidence: "medium",
    keyAnchored: true,
    generic: true,
    keywords: ["secret", "password", "passwd", "pwd"],
  },
  {
    name: "Generic Token Assignment",
    pattern:
      /(?:access[_-]?token|auth[_-]?token)(?:['"]\s*\]|['"]?)\s*(?:[:=]|\|\|=?|\?\?=?)\s*['"][a-zA-Z0-9_-]{20,}['"]/gi,
    confidence: "medium",
    keyAnchored: true,
    generic: true,
    keywords: [
      "access_token",
      "access-token",
      "accesstoken",
      "auth_token",
      "auth-token",
      "authtoken",
    ],
  },
  {
    // Standard base64, not just base64url: a token with `+` or `/` in its first
    // 20 characters used to stop the match short of the length threshold and
    // report nothing at all, and `=` padding was dropped from the value.
    //
    // Padding is trailing and at most two characters, which is what keeps
    // `Bearer ====================` from being a token.
    name: "Bearer Token",
    pattern: /Bearer\s+[a-zA-Z0-9_+/-]{20,}={0,2}/g,
    confidence: "medium",
    generic: true,
    keywords: ["bearer"],
  },
  {
    name: "Basic Auth Header",
    pattern: /Basic\s+[A-Za-z0-9+/=]{20,}/g,
    confidence: "medium",
    generic: true,
    keywords: ["basic"],
  },
];

// Key names for the providers that issue a public and a secret key of one
// shape (#359). Function declarations, so the table below can use them.
const PRIVILEGED_KEY_NAME_RE = /secret|private|admin|master|write|server/i;

/** `pusherKey`, `PUSHER_APP_KEY`, `key`: says key, and nothing privileged. */
function isPublicKeyNamed(key: string | undefined): boolean {
  return (
    key !== undefined && /key/i.test(key) && !PRIVILEGED_KEY_NAME_RE.test(key)
  );
}

/** `UPLOADCARE_PUBLIC_KEY`, `data-public-key`, `pubkey`. */
function isUploadcarePublicKeyName(key: string | undefined): boolean {
  return (
    key !== undefined && /pub/i.test(key) && !PRIVILEGED_KEY_NAME_RE.test(key)
  );
}

/** `searchKey`, `ALGOLIA_SEARCH_API_KEY`, `searchOnlyApiKey`. */
function isAlgoliaSearchKeyName(key: string | undefined): boolean {
  return (
    key !== undefined &&
    /search/i.test(key) &&
    !PRIVILEGED_KEY_NAME_RE.test(key)
  );
}

// Context patterns - generic patterns that need keyword presence check first
// These previously used (?=.*keyword) lookaheads which caused O(n²) backtracking
// Now we check for keyword via fast includes() before running the regex
// Exported alongside FAST_PATTERNS for the prefilter soundness test.
export const CONTEXT_PATTERNS: ContextPattern[] = [
  // AI/ML Services (need context)
  {
    name: "Cohere API Key",
    keyword: "cohere",
    pattern: /[a-zA-Z0-9]{40}/gi,
    confidence: "medium",
  },
  {
    name: "Together AI Key",
    keyword: "together",
    pattern: /[a-f0-9]{64}/gi,
    confidence: "medium",
  },
  {
    name: "Mistral API Key",
    keyword: "mistral",
    pattern: /[a-zA-Z0-9]{32}/gi,
    confidence: "medium",
  },

  // Database (need context)
  {
    name: "Pinecone API Key",
    keyword: "pinecone",
    pattern: /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
    confidence: "medium",
  },

  // Hosting/Deployment (need context)
  {
    name: "Cloudflare API Token",
    keyword: "cloudflare",
    pattern: /[a-zA-Z0-9_-]{40}/gi,
    confidence: "medium",
  },
  {
    name: "Heroku API Key",
    keyword: "heroku",
    pattern:
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/gi,
    confidence: "medium",
  },

  // Email Services (need context)
  {
    name: "Twilio Auth Token",
    keyword: "twilio",
    pattern: /[a-f0-9]{32}/gi,
    confidence: "medium",
  },
  {
    name: "Postmark Server Token",
    keyword: "postmark",
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    confidence: "medium",
  },

  // Analytics/Monitoring (need context)
  {
    name: "Datadog API Key",
    keyword: "datadog",
    pattern: /[a-f0-9]{32}/gi,
    confidence: "medium",
  },
  {
    name: "Segment Write Key",
    keyword: "segment",
    pattern: /[a-zA-Z0-9]{32}/gi,
    confidence: "medium",
  },
  {
    // Project tokens are embedded by mixpanel.init() on every page that uses
    // it; the docs call them public.
    name: "Mixpanel Token",
    keyword: "mixpanel",
    pattern: /[a-f0-9]{32}/gi,
    confidence: "medium",
    publicByDesign: true,
  },
  {
    // rg4js('apiKey', …) ships the key to the browser by design.
    name: "Raygun API Key",
    keyword: "raygun",
    // Padding outside the run: with `=` in the class, `RAYGUN_API_KEY=…`
    // merges the key's letters into the match.
    pattern: /[A-Za-z0-9+/]{24,40}={0,2}/g,
    confidence: "medium",
    publicByDesign: true,
  },
  {
    // The Storefront API access token (and the web-pixel Api-Key) is a
    // public client credential: Shopify's own theme code inlines it.
    name: "Shopify Storefront Access Token",
    keyword: "shopify",
    pattern: /[a-f0-9]{32}/gi,
    confidence: "medium",
    publicByDesign: true,
  },
  {
    // The Browser SDK's API key is read by the page that reports to it; the
    // docs call it safe to expose. Ingest restrictions, not secrecy, are what
    // protect it.
    name: "Amplitude API Key",
    keyword: "amplitude",
    pattern: /[a-f0-9]{32}/gi,
    confidence: "medium",
    publicByDesign: true,
  },
  // "LogRocket App ID" (/[a-z0-9]{6}\/[a-z0-9-]+/) was dropped: it matches any
  // short path segment ("assets/logo-dark"), and a LogRocket app id is a public
  // client-side identifier anyway — LogRocket.init() ships it to the browser by
  // design. No amount of key context makes a path shape mean "credential".

  // Auth Services (need context)
  {
    name: "Auth0 Client Secret",
    keyword: "auth0",
    pattern: /[a-zA-Z0-9_-]{64}/gi,
    confidence: "medium",
  },
  {
    name: "Okta API Token",
    keyword: "okta",
    pattern: /00[a-zA-Z0-9_-]{40}/gi,
    confidence: "medium",
  },

  // CMS/Services (need context)
  {
    // Was a FAST pattern. `sk` + 30 alphanumerics is the shape of a minified
    // identifier (`skeletonLoader…`), a CSS class hash and any 32-character
    // run of base64: 346 findings on 74 of 776 real sites, none a token
    // (#357). Here it needs the brand word and a credential key like every
    // other bare shape.
    name: "Sanity Token",
    keyword: "sanity",
    pattern: /sk[a-zA-Z0-9]{30,}/g,
    confidence: "medium",
  },
  {
    name: "Contentful Access Token",
    keyword: "contentful",
    pattern: /[a-zA-Z0-9_-]{43}/gi,
    confidence: "medium",
  },
  {
    // The search-only key is the one InstantSearch and every Algolia front
    // end ship to the browser. Same shape as the admin key, so only a key
    // that says search, and nothing privileged, is read as it (#359).
    name: "Algolia Search-Only API Key",
    keyword: "algolia",
    pattern: /[a-f0-9]{32}/gi,
    confidence: "medium",
    publicByDesign: true,
    keyName: isAlgoliaSearchKeyName,
  },
  {
    // After the search-only pattern on purpose: that one claims a
    // search-named key first. No key predicate here, so this one stays out
    // of the generic assignments' claim set, and `algoliaAdminKey` keeps the
    // generic tier's admin-named escalation.
    name: "Algolia API Key",
    keyword: "algolia",
    pattern: /[a-f0-9]{32}/gi,
    confidence: "medium",
  },

  // Social/OAuth (need context)
  {
    name: "LinkedIn Client Secret",
    keyword: "linkedin",
    pattern: /[a-zA-Z0-9]{16}/gi,
    confidence: "medium",
  },
  // Browser-exposed services with no prefix of their own (#359): each needs
  // its brand word within the look-behind and a credential key, like every
  // other bare shape here.
  {
    // A Storyblok access token ends in `tt`. The public token is meant for
    // the browser and the preview token is not, and nothing in the value
    // says which, so it is a review item.
    name: "Storyblok Access Token",
    keyword: "storyblok",
    pattern: /[A-Za-z0-9]{22}tt/g,
    confidence: "medium",
  },
  {
    name: "Webflow API Token",
    keyword: "webflow",
    pattern: /[a-f0-9]{64}/gi,
    confidence: "medium",
  },
  {
    name: "Squarespace API Key",
    keyword: "squarespace",
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    confidence: "medium",
  },
  {
    // The secret half of a Mux access token pair (the id is a UUID and
    // proves nothing alone).
    name: "Mux Token Secret",
    keyword: "mux",
    pattern: /[A-Za-z0-9+/]{75}/g,
    confidence: "medium",
  },
  {
    // OneSignal's legacy REST API key. The v2 keys carry `os_v2_` and are a
    // FAST pattern; the app id beside either is a public UUID.
    name: "OneSignal REST API Key (legacy)",
    keyword: "onesignal",
    pattern: /[A-Za-z0-9]{48}/g,
    confidence: "medium",
  },
  {
    // `new Pusher("<key>", {cluster})`: the app key is the browser's half.
    name: "Pusher App Key",
    keyword: "pusher",
    pattern: /[a-f0-9]{20}/gi,
    confidence: "medium",
    publicByDesign: true,
    keyName: isPublicKeyNamed,
  },
  {
    // The same shape under any other credential key is the app secret,
    // which signs private-channel auth on the server.
    name: "Pusher App Secret",
    keyword: "pusher",
    pattern: /[a-f0-9]{20}/gi,
    confidence: "medium",
    keyName: (key) => !isPublicKeyNamed(key),
  },
  {
    // The upload widget's public key ships in the page by design.
    name: "Uploadcare Public Key",
    keyword: "uploadcare",
    pattern: /[a-f0-9]{20}/gi,
    confidence: "medium",
    publicByDesign: true,
    keyName: isUploadcarePublicKeyName,
  },
  {
    name: "Uploadcare Secret Key",
    keyword: "uploadcare",
    pattern: /[a-f0-9]{20}/gi,
    confidence: "medium",
    keyName: (key) => !isUploadcarePublicKeyName(key),
  },
  {
    // The access key goes out as `Client-ID <key>`; Unsplash's guidelines
    // ask that it stay private, behind a proxy.
    name: "Unsplash Access Key",
    keyword: "unsplash",
    pattern: /[A-Za-z0-9_-]{43}/g,
    confidence: "medium",
  },
  {
    // The Global API Key: 37 hex, account-wide, paired with the account's
    // email. The 40-character API token above is a different shape.
    name: "Cloudflare Global API Key",
    keyword: "cloudflare",
    pattern: /[a-f0-9]{37}/gi,
    confidence: "medium",
  },
  {
    // base64 of a 64-hex HMAC plus a restriction query string. Decoded by
    // secrets/confidence.ts: with restrictions it is a scoped search key and
    // public; a base64 run near "algolia" that does not decode that way is
    // dropped, so the shape alone never reports (#361).
    name: "Algolia Secured API Key",
    keyword: "algolia",
    pattern: /[A-Za-z0-9+/]{86,}={0,2}/g,
    confidence: "medium",
  },
];

// False positive filters - common non-sensitive patterns.
//
// Anchored to the value's head or tail (#357). As bare substring tests these
// dropped any real token that happened to contain `xxx`, `fake` or `sample`
// somewhere in its random body, and `a{16,}` dropped every Twitter bearer
// token, which opens with nineteen of them. A placeholder is a placeholder
// because the word IS the value (after at most a short prefix such as `ghp_`)
// or ends it; a run of one repeated character is one because it runs to the
// end.
// `redacted` is what a config dumper writes OVER a credential: `(redacted)`,
// wrapped in punctuation, which is why the head anchor below tolerates a
// couple of non-alphanumerics in front of the word (#2218). Next.js's own
// `%filtered%` needs no entry: isPercentEncodedLabel already reads it.
const PLACEHOLDER_WORDS =
  "placeholder|your[_-]?api[_-]?key|your[_-]?(?:master|search|admin)[_-]?key|(?:master|search|admin)[_-]?key[_-]?placeholder|test[_-]?key|demo[_-]?key|sample|dummy|fake|redacted";
const FALSE_POSITIVE_PATTERNS = [
  // Google tag IDs (GTM containers, GA4/UA measurement IDs, Ads/DC tags)
  // are public identifiers — never secrets, whatever pattern caught them
  /^(GTM|G|UA|AW|DC)-[A-Z0-9-]+$/i,
  new RegExp(
    `^[^A-Za-z0-9]{0,2}[A-Za-z0-9]{0,12}[_.-]?(?:${PLACEHOLDER_WORDS})`,
    "i"
  ),
  new RegExp(`(?:${PLACEHOLDER_WORDS})[_.-]?[A-Za-z0-9]{0,4}$`, "i"),
  // `example-password`, `example_secret`: the whole value is the word, a
  // credential noun and at most a short number. Anchored at both ends, so a
  // real password that merely starts with "Example" is not a placeholder.
  /^[^A-Za-z0-9]{0,2}example[_.-]?(?:api[_-]?key|password|passwd|secret|token|value|pass|pwd)[_.-]?[0-9]{0,4}$/i,
];

/**
 * A run of one repeated character that ends the value: `sk_live_xxxxxxxx`,
 * `AKIA0000000000000000`. Counted by a walk rather than `/(?:x{3,}|0{16,})$/`, // pragma: allowlist secret
 * which retries the anchored repetition from every character and goes
 * quadratic on a long match (a connection string runs to the next quote).
 */
function endsInRepeatedChar(value: string): boolean {
  if (value.length === 0) return false;
  const last = value.charCodeAt(value.length - 1) | 0x20; // fold case
  let run = 0;
  for (
    let i = value.length - 1;
    i >= 0 && (value.charCodeAt(i) | 0x20) === last;
    i--
  )
    run++;
  if (last === 120) return run >= 3; // x
  if (last === 48 || last === 49 || last === 97) return run >= 16; // 0 1 a
  return false;
}

// Check if value looks like a code identifier (function/variable name)
function looksLikeCodeIdentifier(value: string): boolean {
  // CamelCase: starts lowercase, has uppercase in middle (e.g., convertToReport)
  if (/^[a-z]+[A-Z]/.test(value)) return true;

  // snake_case with lowercase (not SCREAMING_SNAKE constants)
  if (/_/.test(value) && /[a-z]/.test(value)) return true;

  // Common JS function name prefixes
  if (
    /^(get|set|is|has|on|handle|create|update|delete|fetch|parse|render|convert|init|load|save|find|add|remove|check|validate|process|build|make|format|transform)/i.test(
      value
    )
  )
    return true;

  // PascalCase component names (e.g., MyComponent, AmazonRobot)
  if (/^[A-Z][a-z]+[A-Z]/.test(value)) return true;

  return false;
}

// Check if value appears in a value position (assigned via = or :, not array element)
function isInValuePosition(
  window: string,
  match: string,
  matchIndex: number
): boolean {
  // Look at characters before and after the match
  const before = window.slice(Math.max(0, matchIndex - 20), matchIndex);
  const after = window.slice(
    matchIndex + match.length,
    matchIndex + match.length + 5
  );

  // Check if in array position: preceded by ," or ,' (comma then quote)
  // This indicates it's an array element, not an assigned value
  // e.g., ["linkedinbot","facebookexternal","amazonbot"]
  if (/,\s*['"`]$/.test(before) && /^['"`]\s*[,\]]/.test(after)) {
    return false; // Array element, not a value assignment
  }

  // Check if assigned via = or : (the value position in key-value pair)
  // Patterns like: = "value", : "value", ="value", :"value"
  if (/[:=]\s*['"`]?$/.test(before)) {
    return true;
  }

  // A fallback behind an env var — `process.env.SECRET_KEY || "value"`,
  // `?? "value"` — is a value position too. classifyKeyContext still reads the
  // key in front of the `||`, so a `cacheKey || "…"` fallback stays a digest.
  if (/(?:\|\||\?\?)=?\s*['"`]?$/.test(before)) {
    return true;
  }

  // Check if it's in a quoted string that's an object value
  // e.g., { key: "value" } or "key": "value"
  if (/:\s*['"`]$/.test(before) && /^['"`]/.test(after)) {
    return true;
  }

  // If not clearly assigned, check if it's a standalone quoted string
  // preceded by assignment-related keywords (key, token, secret, etc.)
  const keywordMatch = /(key|token|secret|password|apikey|api_key|auth)/i.test(
    before
  );
  if (keywordMatch && /['"`]$/.test(before) && /^['"`]/.test(after)) {
    return true;
  }

  // `Authorization: Bearer <value>` hands the value to a scheme rather than to
  // a separator. classifyKeyContext already reads that as a credential
  // context; a value position is what it is (#2218).
  if (AUTH_SCHEME_RE.test(before)) {
    return true;
  }

  return false;
}

// Keys whose value is a digest, hash, cache entry or object id — never a
// credential. A release page publishing `sha256:"01e4fbb0…"` next to a download
// is doing the right thing, and so is an SRI `integrity=` attribute, a git
// commit id, or a cache key built by hashing its inputs.
const DIGEST_KEY_WORDS = new Set([
  "sha",
  "sha1",
  "sha256",
  "sha384",
  "sha512",
  "md5",
  "hash",
  "hashes",
  "digest",
  "checksum",
  "checksums",
  "integrity",
  "etag",
  "commit",
  "revision",
  "fingerprint",
  "cache",
  "cachekey",
]);

// Keys that say the value is meant to be secret. Bare `api` is deliberately
// absent — `api:"…"` names a service, not a credential — while bare `key` is
// deliberately present: `key:"…"` is a weak signal, but these are all
// medium-confidence findings and dropping it costs real detections.
const CREDENTIAL_KEY_WORDS = new Set([
  "apikey",
  "key",
  "keys",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "bearer",
  "credential",
  "credentials",
]);

// What keyWords glues into a single word: everything it does not split on.
const WORD_CHAR_RE = /[A-Za-z0-9]/;

// `x-api-key`, `apiKey`, `SHA256`, `"sha256"` -> the words a key is made of.
// A one-letter word is also glued to its successor so lower-camel `eTagKey`
// yields `etag`, not `e` + `tag`.
function keyWords(key: string): string[] {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  const words = [...parts];
  for (const [index, part] of parts.entries()) {
    const next = parts[index + 1];
    if (part.length === 1 && next) words.push(part + next);
  }
  return words;
}

// Characters that can be part of a key, so cutting the look-back in the middle
// of a run of them would hand classifyKeyContext a truncated key.
const KEY_CHAR_RE = /[A-Za-z0-9_$.-]/;

// Whitespace between a key and its value is layout, not content: a formatter,
// an aligned manifest or a minifier's line break can put arbitrarily much of it
// there without changing a word of what the key says.
const SPACE_CHAR_RE = /\s/;

/**
 * `\s` for one position, decided on the code unit. The look-back tests every
 * character it walks over, and a regex call per character costs more than the
 * whole rest of the walk — but only the ASCII half is worth open-coding, so the
 * Unicode spaces `\s` also accepts (NBSP, the line separators) fall through to
 * it and stay in step with the `\s*` in the key patterns.
 */
function isSpaceAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  if (code < 0x80) return false;
  return SPACE_CHAR_RE.test(text[index] ?? "");
}

// How far back the walk may reach in total. The budget below buys significant
// characters only, so without a second bound one long run of spaces would drag
// the walk across the whole window.
const LOOKBEHIND_SCAN_LIMIT = SECRET_KEY_LOOKBEHIND_SIZE * 8;

export interface KeyLookBack {
  /** The text immediately before the match, for reading the key off. */
  before: string;
  /** `before` opens part-way through a key, so it opens on a fragment. */
  cut: boolean;
}

/**
 * Read back from a match to the key in front of it.
 *
 * SECRET_KEY_LOOKBEHIND_SIZE is a budget over the characters that carry
 * meaning: whitespace is skipped for free. Charging for it is what lost the
 * key — `{"sha256"` and `:"<hex>"` are one assignment however many spaces sit
 * between them, but 62 of them pushed `sha256` out of the window, the digest
 * read back as a bare `:`, and an unnamed assignment reports.
 *
 * The budget is not a hard cut either: stopping at exactly that offset can land
 * inside the key itself, and `redential="` classifies as nothing at all. So the
 * walk continues to the nearest non-key character, spending at most the same
 * budget again before giving up.
 *
 * A walk that runs out of room — the scan limit, the second budget, or the left
 * edge of the window it was handed — never saw where the key began, so `cut`
 * says the text opens on a fragment rather than on a whole key. Reaching
 * position 0 settles nothing either: the window carries a lead-in precisely
 * because its left edge can land mid-key.
 */
export function readKeyLookBack(text: string, index: number): KeyLookBack {
  const scanFloor = Math.max(0, index - LOOKBEHIND_SCAN_LIMIT);

  let start = index;
  let budget = SECRET_KEY_LOOKBEHIND_SIZE;
  while (start > scanFloor && budget > 0) {
    if (!isSpaceAt(text, start - 1)) budget--;
    start--;
  }

  const floor = Math.max(scanFloor, start - SECRET_KEY_LOOKBEHIND_SIZE);
  while (start > floor && KEY_CHAR_RE.test(text[start - 1] ?? "")) start--;

  // Stopping on a non-key character is the walk reaching the key's left edge;
  // stopping anywhere else is it running out of room part-way through one.
  const opensOnKeyChar = KEY_CHAR_RE.test(text[start] ?? "");
  const reachedEdge = start > 0 && !KEY_CHAR_RE.test(text[start - 1] ?? "");
  return {
    before: text.slice(start, index),
    cut: opensOnKeyChar && !reachedEdge,
  };
}

/** The look-back text on its own, for callers that only read the key off it. */
export function lookBehind(text: string, index: number): string {
  return readKeyLookBack(text, index).before;
}

// The three regexes below all separate a key from its value with
// `(?:[:=]|\|\||\?\?)`. `||` and `??` are there for the same reason
// isInValuePosition accepts them: `process.env.SECRET_KEY || "…"` is an
// assignment. Reading the key across the fallback is what keeps it honest —
// `cacheKey || "<hex>"` still classifies as a digest.

// The key an assignment puts immediately in front of a value:
// `sha256:"`, `api_key = "`, `"x-api-key":`, `apiKey:`, `SECRET_KEY || "`
//
// These three end in `\s*(?:["'`]\s*)?$`, not the equivalent `\s*["'`]?\s*$`:
// with no quote, two adjacent `\s*` split a whitespace run every possible way,
// which made this one cubic in the look-back window.
const PRECEDING_KEY_RE =
  /["'`]?([A-Za-z_$][A-Za-z0-9_$.-]*)(?:["'`]\s*\]|["'`]?)\s*(?:[:=]|\|\|=?|\?\?=?)\s*(?:["'`]\s*)?$/;

// The same, written as a bracket access: `cfg["apiKey"] = "`, `cfg['sha256'] =`
const BRACKET_KEY_RE =
  /\[\s*["'`]([^"'`\]]{1,64})["'`]\s*\]\s*(?:[:=]|\|\|=?|\?\?=?)\s*(?:["'`]\s*)?$/;

// Anything at all in value position, whatever the key turned out to be
const ASSIGNMENT_RE = /[:=]\s*(?:["'`]\s*)?$/;

// SRI and prefixed-digest values: integrity="sha384-…", `sha256-…`, `md5:…`
const DIGEST_PREFIX_RE = /(?:sha-?(?:1|256|384|512)|md5)\s*[-:]\s*[\w+/=-]*$/i;

// An HTML integrity attribute, whatever the algorithm prefix looks like
const INTEGRITY_ATTR_RE = /\bintegrity\s*=\s*["'][^"']*$/i;

// Header-style credentials: `Authorization: Bearer <value>`, `Basic <value>`
const AUTH_SCHEME_RE = /\b(?:bearer|basic)(?:\s|\+|%20)+$/i;

// Attributes that name the value carried by a sibling attribute of the same
// tag, in either order: `<meta name="algolia-api-key" content="…">` and
// `<meta content="…" name="algolia-api-key">` say the same thing.
const TAG_NAMING_ATTR_RE =
  /\b(?:name|id|itemprop|property)\s*=\s*["']([^"']{1,64})["']/gi;
const TAG_DATA_ATTR_RE = sharedRegex(/\b(data-[A-Za-z0-9_-]{1,64})\s*=/g);
type KeyContext = "digest" | "credential" | "assigned" | "none";

function classifyKeyName(key: string, keyword: string): KeyContext | "unknown" {
  const words = keyWords(key);
  if (words.some((word) => DIGEST_KEY_WORDS.has(word))) return "digest";
  if (words.some((word) => CREDENTIAL_KEY_WORDS.has(word))) return "credential";
  // The brand word ALONE names the value (`together: "…"`, `cfg["together"]`).
  // As one word among others it names something about the brand, not a
  // credential: `data-heroku-dyno`, `herokuAppName`, `segmentId` (#357).
  if (words.length === 1 && words[0] === keyword) return "credential";
  return "unknown";
}

/**
 * The name of the key a value is assigned to, read off its look-behind. Inside
 * a tag the attribute holding the value is `content` or `value`, and the name
 * is on the tag (`<meta name="pusher-key" content="…">`): the tag's naming
 * attributes are appended, so a predicate reads both.
 */
function assignedKeyName(before: string, tag?: string): string | undefined {
  const key = (BRACKET_KEY_RE.exec(before) ??
    PRECEDING_KEY_RE.exec(before))?.[1];
  if (tag === undefined) return key;
  const names: string[] = key === undefined ? [] : [key];
  TAG_NAMING_ATTR_RE.lastIndex = 0;
  for (const attr of tag.matchAll(TAG_NAMING_ATTR_RE)) names.push(attr[1]!);
  return names.length === 0 ? undefined : names.join(" ");
}

/** The whole tag a value sits inside, or undefined if it sits between tags. */
// How far a tag may extend either side of a keyword before the tag-scoped
// exception gives up on it: attribute soup past this is not one tag's worth.
const TAG_SCAN_LIMIT = 2048;

/**
 * The `<`…`>` bounds of the tag `index` sits inside, or undefined when it
 * sits between tags or the tag is longer than TAG_SCAN_LIMIT either way.
 * Bounded, unlike enclosingTag's lastIndexOf: a keyword deep in a script body
 * with no `<` for a megabyte must not walk that megabyte per occurrence.
 */
function tagBoundsAround(
  text: string,
  index: number
): { start: number; end: number } | undefined {
  let start = -1;
  for (let i = index; i >= 0 && index - i <= TAG_SCAN_LIMIT; i--) {
    const c = text.charCodeAt(i);
    if (c === 62) return undefined; // > : between tags
    if (c === 60) {
      start = i;
      break;
    }
  }
  if (start === -1) return undefined;
  for (let i = index; i < text.length && i - index <= TAG_SCAN_LIMIT; i++) {
    if (text.charCodeAt(i) === 62) return { start, end: i + 1 };
  }
  return undefined;
}

/**
 * Does a naming attribute of this tag carry the keyword? `<meta
 * name="algolia-api-key" content="…">` and the same tag with the attributes
 * the other way round both name their value, and the 40-character rule is
 * about prose distance, not attribute order: inside one tag the whole tag is
 * the look-behind.
 */
function tagNamesKeyword(tag: string, keyword: string): boolean {
  for (const re of [TAG_NAMING_ATTR_RE, TAG_DATA_ATTR_RE]) {
    // matchAll clones the regex WITH its lastIndex, so the shared global
    // regexes are reset first; an early return must not leave them dirty.
    re.lastIndex = 0;
    for (const attr of tag.matchAll(re)) {
      if (attr[1]!.toLowerCase().includes(keyword)) return true;
    }
  }
  return false;
}

export function enclosingTag(text: string, index: number): string | undefined {
  const open = text.lastIndexOf("<", index);
  if (open === -1) return undefined;
  // A `>` between the tag opener and the value means the value is text content.
  if (text.slice(open, index).includes(">")) return undefined;
  const close = text.indexOf(">", index);
  return close === -1 ? undefined : text.slice(open, close + 1);
}

// The characters a bare identifier is made of. `.` is absent on purpose: it
// starts a new name rather than continuing this one, so `cache.apiKey` is the
// `apiKey` of a cache and not a key called `cache.apiKey`. `-` is absent for a
// sharper reason: between two identifiers it is the subtraction operator.
const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

// The same, plus the `-` that a quoted key or an HTML attribute name spells one
// name with: `"x-api-key"`, `<img data-cache-api-key="…">`.
const KEY_SEGMENT_CHAR_RE = /[A-Za-z0-9_$-]/;

const QUOTE_CHAR_RE = /["'`]/;

/**
 * Is this the position an HTML attribute name occupies — whitespace behind it,
 * inside an unclosed tag? Bounded to the lookBehind budget, so a value far
 * enough into a long tag simply reads as "not an attribute".
 */
function isAttributeNamePosition(text: string, start: number): boolean {
  if (!/\s/.test(text[start - 1] ?? "")) return false;
  const floor = Math.max(0, start - SECRET_KEY_LOOKBEHIND_SIZE * 2);
  for (let i = start - 1; i >= floor; i--) {
    const char = text[i];
    if (char === ">") return false;
    if (char === "<") return true;
  }
  return false;
}

/**
 * Does the key this match started in the middle of say "digest"?
 *
 * The generic assignments anchor on a credential word, not on the start of the
 * key, so `cache-api-key:"…"` starts an `api-key` match at character 6 and
 * `checksum_secret = "…"` starts a `secret` match at character 9. Nothing
 * behind them catches it: the FAST tier has no classifyKeyContext gate, by
 * design — every other pattern in it carries a literal marker that a digest
 * cannot wear. These three do not, so they read their own left edge.
 *
 * Only syntax makes a `-` part of a name. Inside quotes it is a JSON or YAML
 * key and inside a tag it is an attribute name, so `"cache-api-key"` and
 * `data-cache-api-key=` are single digest keys. Everywhere else it is the
 * subtraction operator, and reading `cache-apiKey||"…"` as one key would let a
 * minified expression swallow a real credential.
 *
 * Spending the whole lookBehind budget without reaching the start of the key
 * means the prefix was never read, only cut, and a cut prefix is not evidence
 * in either direction: it can drop the `cache` off `cache-…-api-key` and it can
 * invent one out of the tail of `xcache-…`. So an over-long key does not
 * suppress — a missed digest reads as one extra medium-confidence warning,
 * where an invented one silently drops a real leak.
 */
function startsInsideDigestKey(text: string, index: number): boolean {
  const floor = Math.max(0, index - SECRET_KEY_LOOKBEHIND_SIZE * 2);

  // Walk the hyphenated run first, only to see what encloses it.
  let runStart = index;
  while (
    runStart > floor &&
    KEY_SEGMENT_CHAR_RE.test(text[runStart - 1] ?? "")
  ) {
    runStart--;
  }
  const hyphenJoins =
    QUOTE_CHAR_RE.test(text[runStart - 1] ?? "") ||
    isAttributeNamePosition(text, runStart);
  const keyChar = hyphenJoins ? KEY_SEGMENT_CHAR_RE : IDENT_CHAR_RE;

  let start = index;
  while (start > floor && keyChar.test(text[start - 1] ?? "")) {
    start--;
  }
  if (start === index) return false;
  if (start === floor && keyChar.test(text[start - 1] ?? "")) return false;
  return keyWords(text.slice(start, index)).some((word) =>
    DIGEST_KEY_WORDS.has(word)
  );
}

/** Every key a tag names, whichever attribute order it wrote them in. */
function classifyTagKeys(tag: string, keyword: string): KeyContext | "unknown" {
  let verdict: KeyContext | "unknown" = "unknown";

  const consider = (key: string) => {
    const cls = classifyKeyName(key, keyword);
    // Digest wins outright; a credential hit still yields to a later digest.
    if (cls === "digest") verdict = "digest";
    else if (cls === "credential" && verdict === "unknown") verdict = cls;
  };

  TAG_NAMING_ATTR_RE.lastIndex = 0;
  for (const attr of tag.matchAll(TAG_NAMING_ATTR_RE)) {
    if (attr[1]) consider(attr[1]);
  }
  TAG_DATA_ATTR_RE.lastIndex = 0;
  for (const attr of tag.matchAll(TAG_DATA_ATTR_RE)) {
    if (attr[1]) consider(attr[1]);
  }
  return verdict;
}

/**
 * Classify a bare-shape match by the key it is assigned to.
 *
 * - `digest` — a checksum, SRI hash, cache key or object id. Never reported.
 * - `credential` — a key that says "secret". Reported.
 * - `assigned` — in value position under a key the look-back could not read
 *   whole. Reported: an unreadable key is not evidence of anything.
 * - `none` — no assignment at all (a hex run in prose or a table cell).
 *   Not reported.
 *
 * Digest beats credential when a key claims both, so `sha256Key` is a checksum.
 *
 * `keyCut` says the look-back opens on a fragment (see readKeyLookBack), and a
 * fragment costs two different things.
 *
 * A word read out of it may never have existed: `api_key_xsha256` cut to
 * `sha256` reads as a checksum and would suppress a real credential. Only a
 * separator inside the fragment redeems a word — it marks a left edge the walk
 * did see, so `x.sha256` really does carry `sha256`, whatever `x` was cut from.
 *
 * And a key that begins inside the fragment is not the whole key, so "this key
 * says nothing" is a verdict about a truncated read: the part that was cut off
 * is exactly where the words live. Such a key leaves the value where an
 * unreadable key always leaves it — `assigned`, and reported.
 */
export function classifyKeyContext(
  before: string,
  keyword: string,
  tag?: string,
  keyCut = false
): KeyContext {
  let fragment = 0;
  while (keyCut && KEY_CHAR_RE.test(before[fragment] ?? "")) fragment++;

  // A match can start past the character the fragment opens with — the key
  // patterns cannot begin on a digit, a `-` or a `.` — so "starts at index 0"
  // is not the question. The question is whether the character to its left is
  // glued to it, which is what keyWords reads as one word.
  const wordsAreWhole = (found: RegExpExecArray | null) => {
    if (!found || found.index >= fragment) return found !== null;
    // Nothing at all to the left is the cut itself, which proves nothing.
    const left = before[found.index - 1];
    return left !== undefined && !WORD_CHAR_RE.test(left);
  };

  if (
    wordsAreWhole(DIGEST_PREFIX_RE.exec(before)) ||
    wordsAreWhole(INTEGRITY_ATTR_RE.exec(before))
  ) {
    return "digest";
  }

  const bracket = BRACKET_KEY_RE.exec(before);
  const match = bracket ?? PRECEDING_KEY_RE.exec(before);
  const key = match?.[1];
  const cutKey = match !== null && match.index < fragment;

  // Read the key from wherever its left edge was actually seen: a key opening
  // on the cut opens on a word taken from the middle of one, and dropping that
  // word is what stops `…_xsha256` from reading as `sha256`.
  const readable =
    key && !wordsAreWhole(match) ? key.replace(/^[A-Za-z0-9]+/, "") : key;

  if (readable) {
    const direct = classifyKeyName(readable, keyword);
    if (direct !== "unknown") return direct;
  }

  // The naming attribute may sit on either side of the one holding the value.
  if (tag) {
    const fromTag = classifyTagKeys(tag, keyword);
    if (fromTag !== "unknown") return fromTag;
  }

  // A key that was read whole and says nothing is "none" — and that now
  // includes a minifier's member access (`t.a = "…"`, `e.k = "…"`). Letting
  // those through as "assigned" was the single largest source of real-world
  // noise: every Cloudflare challenge and Shopify pixel bootstrap assigns a
  // nonce to a one-letter member within reach of a brand word (#357).
  if (key) {
    return cutKey ? "assigned" : "none";
  }

  if (AUTH_SCHEME_RE.test(before)) return "credential";

  return ASSIGNMENT_RE.test(before) ? "assigned" : "none";
}

export interface LeakedSecret {
  type: string;
  value: string;
  /** Set when `value` was cut to STORED_VALUE_MAX_LENGTH; `length` still holds the full length. */
  truncated?: boolean;
  /** `info`: expired, or a session token the crawl itself was issued. Never a leak. */
  confidence: Confidence;
  publicByDesign: boolean;
  /** Where it was read, with ` (base64)` when it sat inside a decoded blob. */
  location: ReportedLocation;
  /** Character length of the secret value, excluding an assignment key or quotes. The full length, even when `value` was cut. */
  length: number;
  /** Zero-based character offset of the secret in the scanned source body. */
  offset: number;
  /** Zero-based position of an inline script in the page's complete script list. */
  scriptIndex?: number;
  sourceUrl?: string; // URL of the script file or page
  /** At `framework-payload`: the framework whose server-side data block carried the value (#362). */
  framework?: FrameworkPayload;
  /** What the value's own structure decoded to (#361): account id, role… */
  extra?: FindingExtra;
  /**
   * Redacted text around the match (up to EVIDENCE_CONTEXT_RADIUS characters each side) so a reader can find it in the
   * source: the value is masked as in the item id, and every quoted literal, assigned value and token-shaped run nearby is
   * starred out. Absent when the match could not be located in the scanned text.
   */
  context?: string;
}

/**
 * Pattern names whose value only ever belongs on a server: database
 * connection strings, service-role and secret keys, live secret keys, AWS
 * secret keys and other cloud provider secrets. Keyed by `LeakedSecret.type`
 * because the pattern tiers carry no class field. Publishable and anon keys
 * (Stripe pk_live, Supabase anon and publishable) are `publicByDesign` and
 * never reach this test. The DigitalOcean Spaces pattern is left out: it
 * matches the access key id (the public half, like an AWS `AKIA` id) by
 * shape alone, and public vendor ids share that shape (#574).
 */
const SERVER_ONLY_TYPES: ReadonlySet<string> = new Set([
  "MongoDB Connection String",
  "PostgreSQL Connection String",
  "MySQL Connection String",
  "Redis Connection String",
  "Supabase Personal Access Token",
  "Shopify Admin API Token",
  "Stripe Restricted Key",
  "Google OAuth Client Secret",
  "Supabase Secret Key",
  "Supabase Service Role JWT",
  "Stripe Live Key",
  "Paystack Live Secret Key",
  "Clerk Secret Key",
  "AWS Secret Access Key",
  "Azure Storage Key",
  "DigitalOcean Token",
]);

/**
 * An inline or external script is shipped to every visitor's browser, and so is a framework's data payload (an inline
 * script), a same-origin source map and a config endpoint a bundle fetches (#362): anyone can read them.
 */
function isBrowserServed(location: ReportedLocation): boolean {
  return (
    location.startsWith("inline-script") ||
    location.startsWith("external-script") ||
    location.startsWith("framework-payload") ||
    location.startsWith("source-map") ||
    location.startsWith("config-endpoint")
  );
}

const LOOPBACK_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/**
 * A value a tutorial prints rather than one a deploy shipped: AWS's documented
 * example credentials (`…EXAMPLE`, `…EXAMPLEKEY`), an Azure connection string
 * whose AccountKey is not a 64-byte base64 key (`<account-key>`), a connection
 * string the confidence pass already marked as naming a placeholder host or
 * database, and a database URL whose every host is this machine, which is a
 * development credential. A docs page built on a framework that inlines its
 * content into `<script>` payloads would otherwise read as critical. These
 * keep their own tier; they only do not escalate.
 */
function isTutorialValue(s: LeakedSecret): boolean {
  if (s.value.includes("EXAMPLE") || s.extra?.placeholder !== undefined)
    return true;
  if (s.type === "Azure Storage Key")
    return !/AccountKey=[A-Z0-9+/]{86}==;/i.test(s.value);
  if (!s.type.endsWith("Connection String")) return false;
  const authority = /:\/\/([^/?#]*)/.exec(s.value)?.[1] ?? "";
  const hosts = authority
    .slice(authority.lastIndexOf("@") + 1)
    .toLowerCase()
    .split(",");
  return hosts.every((host) =>
    LOOPBACK_HOST_RE.test(host.replace(/:\d*$/, ""))
  );
}

/** A server-only secret read from a browser-served script: critical. */
export function isShippedServerSecret(s: LeakedSecret): boolean {
  return (
    !s.publicByDesign &&
    SERVER_ONLY_TYPES.has(s.type) &&
    isBrowserServed(s.location) &&
    !isTutorialValue(s)
  );
}

/**
 * A host, so anywhere: a connection string to example.com (or a subdomain of
 * it) is a placeholder. The value is split into host-shaped tokens and each is
 * compared exactly or by its `.example.com` suffix, so `example.com.evil.net`
 * and `notexample.com` do not count as the placeholder host.
 */
function mentionsExampleHost(value: string): boolean {
  return value
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .some((token) => token === "example.com" || token.endsWith(".example.com"));
}

function isLikelyFalsePositive(value: string): boolean {
  return (
    endsInRepeatedChar(value) ||
    mentionsExampleHost(value) ||
    FALSE_POSITIVE_PATTERNS.some((pattern) => pattern.test(value))
  );
}

// ── What a generic assignment's value cannot be (#2218) ─────────────────────
//
// The generic assignments anchor on a credential word in the KEY, so the key
// says nothing about whether the VALUE could be a credential. Three shapes on
// the 197-site launch corpus never could be, and each of them is a class:
//
// - a translated label in a script that does not space its words, which the
//   whitespace test cannot see (`weakPassword:"パスワードは8文字以上…"`);
// - a location: a URL, a rooted path, or a lowercase `a/b/c` route key
//   (`FORGOT_PASSWORD:"/shop/forgot-password"`, `"auth/auth/reset_password"`);
// - a dotted identifier chain, which is how an i18n catalogue and an analytics
//   event map name their entries (`"login.err.weakPassword"`,
//   `"hatch.connect.password"`).
//
// Each test is written so that a credential cannot fall into it. A token is
// ASCII, and base64, hex and the random alphanumerics every generated key is
// made of mix case or run longer than the segment bounds below, so the
// all-lowercase segments the path test demands and the twenty-character
// segments the identifier test allows both rule a real value out.

// A quarter of the characters outside printable ASCII makes the value text in
// some other script, not a credential. A share rather than a flag, so a
// passphrase carrying one accented letter still reports.
const NON_ASCII_SHARE_DIVISOR = 4;
const PATH_SEGMENT_RE = /^[a-z0-9]+(?:[_.-][a-z0-9]+)*$/;
const DOTTED_SEGMENT_RE = /^[a-z][A-Za-z0-9]{0,19}$/;
const DOTTED_MAX = 64;

/** Text in a script that does not space its words: a translated label. */
function isNonAsciiText(body: string): boolean {
  let outside = 0;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code > 0x7e || code < 0x20) outside++;
  }
  return outside > 0 && outside * NON_ASCII_SHARE_DIVISOR >= body.length;
}

/**
 * A rooted path or a multi-segment lowercase route key.
 *
 * Deliberately NOT "anything with a scheme": an absolute URL under a
 * credential key is often the credential. A Teams incoming-webhook URL under
 * `webhookSecret:` and a Zapier catch-hook under `secret:` are bearer
 * credentials in URL form, and an earlier version of this test dropped both.
 * A `scheme://` value fails the segment test below on its own (`https:`
 * carries a colon), so it is left to report.
 */
function isLocationValue(body: string): boolean {
  if (!body.includes("/")) return false;
  const rooted = body.startsWith("/");
  const segments = body
    .split("/")
    .filter((segment, i) => !(i === 0 && segment === ""));
  if (segments.length === 0) return false;
  if (!segments.every((segment) => PATH_SEGMENT_RE.test(segment))) return false;
  return rooted || segments.length > 1;
}

/**
 * An AMD / RequireJS module path: `Magento_Customer/js/change-email-password`, `Magento_Ui/js/form/element/abstract`,
 * `text!Vendor_Module/template/form`. Word segments joined by `/` (letters, with `-`, `_` or `.` between words, at most two digits
 * and three capitals after a word's first letter, so a camelCase name passes and a drawn value does not), under a module name of the
 * `Vendor_Module` form or a plain `js` segment. Narrow on purpose: every segment is a short word, there is no long
 * digit run or mixed-case run anywhere, and the path says what it is (#1292).
 */
const MODULE_SEGMENT_RE = /^[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*$/;
// `Magento_Customer`, `Acme_ShopBase`: two CamelCase names of lower-case words, no digits (a drawn `KrllP_YU8RDYAyNCX` is not one)
const VENDOR_MODULE_RE =
  /^[A-Z][a-z]+(?:[A-Z][a-z]+)*_[A-Z][a-z]+(?:[A-Z][a-z]+)*$/;

// The words of the module paths a store's own code writes (AMD / RequireJS names: `Magento_Customer/js/change-email-password`). A word
// outside the list is not read as one: a drawn lower-case run of letters, however word-shaped, is a credential until a person names it.
const MODULE_VOCABULARY = new Set([
  "abstract",
  "account",
  "accounts",
  "action",
  "actions",
  "add",
  "address",
  "addresses",
  "admin",
  "advanced",
  "ajax",
  "alert",
  "alerts",
  "api",
  "app",
  "apply",
  "auth",
  "authentication",
  "authorization",
  "authorize",
  "back",
  "backend",
  "base",
  "basic",
  "billing",
  "block",
  "blocks",
  "bootstrap",
  "button",
  "cache",
  "cancel",
  "captcha",
  "card",
  "cards",
  "carousel",
  "cart",
  "cartdata",
  "catalog",
  "categories",
  "category",
  "change",
  "checkbox",
  "checkout",
  "city",
  "close",
  "collapse",
  "column",
  "columns",
  "common",
  "compare",
  "component",
  "components",
  "config",
  "confirm",
  "confirmation",
  "content",
  "controller",
  "controllers",
  "cookie",
  "cookies",
  "core",
  "countries",
  "country",
  "coupon",
  "create",
  "credit",
  "css",
  "custom",
  "customer",
  "customers",
  "data",
  "default",
  "define",
  "delete",
  "description",
  "dialog",
  "discount",
  "domready",
  "dynamic",
  "edit",
  "element",
  "elements",
  "email",
  "emails",
  "error",
  "errors",
  "event",
  "events",
  "expand",
  "extended",
  "external",
  "factory",
  "fetch",
  "field",
  "fields",
  "fieldset",
  "filter",
  "filters",
  "footer",
  "forgot",
  "form",
  "forms",
  "front",
  "frontend",
  "gallery",
  "general",
  "generic",
  "get",
  "global",
  "grid",
  "group",
  "groups",
  "handler",
  "handlers",
  "header",
  "helper",
  "helpers",
  "hide",
  "html",
  "http",
  "i18n",
  "image",
  "images",
  "index",
  "info",
  "init",
  "initialize",
  "inline",
  "input",
  "internal",
  "item",
  "items",
  "jquery",
  "js",
  "json",
  "keeper",
  "key",
  "keys",
  "knockout",
  "ko",
  "label",
  "labels",
  "lang",
  "language",
  "layout",
  "layouts",
  "less",
  "lib",
  "libs",
  "list",
  "listing",
  "load",
  "loader",
  "loading",
  "local",
  "locale",
  "locales",
  "login",
  "logout",
  "mage",
  "magento",
  "main",
  "map",
  "mapper",
  "mapping",
  "maps",
  "menu",
  "message",
  "messages",
  "method",
  "methods",
  "mixin",
  "mixins",
  "modal",
  "model",
  "models",
  "module",
  "modules",
  "multi",
  "name",
  "names",
  "nav",
  "navigation",
  "newsletter",
  "notice",
  "notices",
  "observer",
  "observers",
  "open",
  "option",
  "options",
  "order",
  "orders",
  "overlay",
  "page",
  "pager",
  "pages",
  "pagination",
  "password",
  "passwords",
  "path",
  "paths",
  "payment",
  "payments",
  "phone",
  "plugin",
  "plugins",
  "polyfill",
  "polyfills",
  "popup",
  "post",
  "postal",
  "postcode",
  "price",
  "prices",
  "private",
  "product",
  "products",
  "provider",
  "providers",
  "public",
  "put",
  "quote",
  "quotes",
  "radio",
  "rate",
  "rates",
  "recaptcha",
  "region",
  "regions",
  "register",
  "registration",
  "remember",
  "remote",
  "remove",
  "renderer",
  "renderers",
  "request",
  "requests",
  "require",
  "requirejs",
  "reset",
  "response",
  "review",
  "reviews",
  "route",
  "router",
  "routes",
  "row",
  "rows",
  "rule",
  "rules",
  "sass",
  "save",
  "scss",
  "search",
  "secret",
  "secrets",
  "security",
  "select",
  "send",
  "service",
  "services",
  "session",
  "sessions",
  "setting",
  "settings",
  "shared",
  "shim",
  "shims",
  "shipping",
  "show",
  "sidebar",
  "signin",
  "signup",
  "simple",
  "single",
  "skin",
  "slider",
  "sort",
  "sorter",
  "standard",
  "state",
  "static",
  "status",
  "statuses",
  "step",
  "steps",
  "storage",
  "store",
  "stores",
  "submit",
  "subscription",
  "success",
  "summary",
  "swatch",
  "swatches",
  "tab",
  "table",
  "tabs",
  "tax",
  "taxes",
  "template",
  "templates",
  "text",
  "theme",
  "themes",
  "title",
  "titles",
  "toggle",
  "token",
  "tokens",
  "tooltip",
  "total",
  "totals",
  "translate",
  "translation",
  "type",
  "types",
  "ui",
  "underscore",
  "update",
  "uri",
  "url",
  "urls",
  "user",
  "users",
  "util",
  "utils",
  "validation",
  "validator",
  "validators",
  "vendor",
  "verification",
  "verify",
  "view",
  "views",
  "warning",
  "weight",
  "widget",
  "widgets",
  "wishlist",
  "wizard",
  "xml",
  "zip",
  "zoom",
]);
const MODULE_MAX_WORDS_PER_SEGMENT = 3;
const CAMEL_PART_RE = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g;

/** A word of a module path: in {@link MODULE_VOCABULARY}, a plural of one, or digits. */
function isModuleWord(word: string): boolean {
  const lower = word.toLowerCase();
  if (/^[0-9]+$/.test(lower) || MODULE_VOCABULARY.has(lower)) return true;
  return lower.endsWith("s") && MODULE_VOCABULARY.has(lower.slice(0, -1));
}

/** A segment of a module path: one to three words joined by `-`, `_` or `.`, each of camelCase parts that are module words. */
function isModuleSegment(segment: string): boolean {
  const words = segment.split(/[-_.]/);
  if (words.length > MODULE_MAX_WORDS_PER_SEGMENT) return false;
  return words.every((word) =>
    (word.match(CAMEL_PART_RE) ?? []).every(isModuleWord)
  );
}

export function isModulePath(body: string): boolean {
  if (body.length > 128 || !body.includes("/")) return false;
  const segments = body.replace(/^[a-z]+!/, "").split("/");
  if (segments.length < 2) return false;
  for (const segment of segments) {
    if (segment.length > 32 || !MODULE_SEGMENT_RE.test(segment)) return false;
    let digits = 0;
    let capitals = 0;
    for (const ch of segment) {
      if (ch >= "0" && ch <= "9") digits++;
      else if (ch >= "A" && ch <= "Z") capitals++;
    }
    if (digits > 2) return false;
    // capitals after the first letter: `changeEmailPassword` and `Vendor_Module` are names, a drawn run of mixed case is not
    if (
      capitals - (segment[0]! >= "A" && segment[0]! <= "Z" ? 1 : 0) > 3 &&
      !VENDOR_MODULE_RE.test(segment)
    )
      return false;
  }
  // every segment is a name's words; the `Vendor_Module` head is judged by its own pattern
  if (
    !segments.every(
      (segment, i) =>
        (i === 0 && VENDOR_MODULE_RE.test(segment)) || isModuleSegment(segment)
    )
  )
    return false;
  return VENDOR_MODULE_RE.test(segments[0]!) || segments.includes("js");
}

/** `login.err.weakPassword`: a catalogue key, not a secret. */
function isDottedIdentifier(body: string): boolean {
  if (!body.includes(".") || body.length > DOTTED_MAX) return false;
  const segments = body.split(".");
  return (
    segments.length > 1 &&
    segments.every((segment) => DOTTED_SEGMENT_RE.test(segment))
  );
}

// The word "password" in the languages a locale file most often carries it
// in, folded to lowercase ASCII letters. A locale catalogue writes
// `password: "Passwort"` and `"auth.password": "Contraseña"`, and both are // pragma: allowlist secret
// the field's label in another language, never its value. Words under eight
// letters (`senha`, `parola`) are absent: the generic pattern never matches
// a value that short, so listing them would only read as a blind spot.
const PASSWORD_TRANSLATIONS = new Set([
  "passwort",
  "geheimnis",
  "kennwort",
  "wachtwoord",
  "wagwoord",
  "adgangskode",
  "losenord",
  "salasana",
  "contrasena",
  "contrasenya",
  "contrasinal",
  "pasahitza",
  "motdepasse",
  "palavrapasse",
  "katasandi",
]);

// A word in a language that is not English: letters only, at least one of
// them outside ASCII, joined at most by a hyphen or an apostrophe.
const NON_ASCII_WORD_RE = /^\p{L}+(?:['’-]\p{L}+)*$/u;
const HAS_NON_ASCII_RE = /[^\x00-\x7f]/;

/**
 * A translated label: `password: "Passwort"`, `password: "Contraseña"`. // pragma: allowlist secret
 * The share test in isNonAsciiText cannot see a Latin-script word with one
 * accented letter, and a word in a table of translations is not random
 * whatever its entropy. A value with a digit or a symbol in it is never
 * read as a word here.
 */
function isTranslatedLabel(body: string): boolean {
  if (NON_ASCII_WORD_RE.test(body) && HAS_NON_ASCII_RE.test(body)) return true;
  const folded = body
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  if (/[^a-z'’ -]/.test(folded)) return false;
  return PASSWORD_TRANSLATIONS.has(folded.replace(/[^a-z]/g, ""));
}

// A template or JSX expression standing where a value will be filled in:
// `{form.password}`, `{{ user.password }}`, `${cfg.password}`, `<%= pwd %>`.
// The interior is a member chain or a call; a bare name qualifies only when
// it has no digit in it, so a brace-wrapped random string stays a value.
const TEMPLATE_EXPRESSION_RE =
  /^(?:\{\{?|\$\{|<%=?|\[\[)\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[\w'"]*\]|\(\))*)\s*(?:\}\}?|%>|\]\])$/;

function isTemplateExpression(body: string): boolean {
  const inner = TEMPLATE_EXPRESSION_RE.exec(body)?.[1];
  if (inner === undefined) return false;
  return /[.[(]/.test(inner) || !/[0-9]/.test(inner);
}

// ── What a generic assignment's value can be (#1292) ────────────────────────
//
// The gate below is the second half of isNotACredentialValue: shapes that name
// something other than a credential even though a credential word sits in the
// key. Each one is a class counted in the corpus triage; a random token falls
// into none of them (it mixes case or digits, has no separator-joined words,
// is not a location, and is not rooted in an expression).

/** A CSS-module class (`styles-module__secret___x9Y2z`, `Button__primary___3xK9z`). `Name_key_hash` alone is not: it reads like a drawn password. */
const CSS_MODULE_HEAD_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CSS_MODULE_HASH_RE = /^[A-Za-z0-9_-]{3,}$/;

/**
 * The WHOLE value is a css-loader class, `<file>__<local>___<hash>` (`styles-module__secret___x9Y2z`, `Button__primary___3xK9z`): a
 * head with a `__` and a local name, then `___` and a hash. A value that merely contains `-module__` somewhere, or has no
 * `___hash`, is not one (`Xk9mQ2vL8zPq-module__4tR7yU1iO3` is a password). Linear: one split at the last `___`.
 */
function isCssModuleClass(body: string): boolean {
  const cut = body.lastIndexOf("___");
  if (cut <= 0) return false;
  const head = body.slice(0, cut);
  const local = head.lastIndexOf("__");
  return (
    local > 0 &&
    local + 2 < head.length &&
    CSS_MODULE_HEAD_RE.test(head) &&
    CSS_MODULE_HASH_RE.test(body.slice(cut + 3))
  );
}

/**
 * `user_password_field`, `secret:reset:token`, `app_secret_v6`: words joined by
 * `_`, `:` or `.`: all lower case, each word at most eight characters (sixteen when the
 * key ends in a `_v6`-style version), no more than two digits in all. A longer word, a capital or a digit run reads as drawn at
 * random (`Prod_token_8fK2mQ9x`) and reports. Not `-`: a hyphenated
 * passphrase (`correct-horse-battery-staple`) is a password people choose. A storage key or a
 * catalogue key, not a value drawn at random.
 */
const IDENTIFIER_JOINED_RE = /^[a-z][a-z0-9]{0,7}(?:[_:.][a-z][a-z0-9]{0,7})+$/;
/** A storage key with a version suffix (`app_secret_v6`, `authentication_secret_v6`): lower-case words of up to sixteen characters, then `_v` and one or two digits. */
const VERSIONED_KEY_RE =
  /^[a-z][a-z0-9]{0,15}(?:[_:.][a-z][a-z0-9]{0,15})*[_:.]v\d{1,2}$/;

/**
 * A joined identifier is a NAME of a credential, so one of its words says so: `user_password_field`, `secret:reset:token`,
 * `app_secret_v6`. Random lower-case words joined by `_` (a passphrase, a drawn value) have none and are reported.
 */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  "secret",
  "secrets",
  "token",
  "tokens",
  "key",
  "keys",
  "apikey",
  "pass",
  "password",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "cred",
  "creds",
  "credential",
  "credentials",
  "api",
  "private",
  "bearer",
  "session",
  "sign",
  "signature",
  "salt",
  "jwt",
  "login",
  "access",
  "oauth",
]);

/** The patterns whose value is handed over after a scheme word (`Bearer x`, `Basic x`): the value is never a name. */
const SCHEME_VALUE_PATTERNS: ReadonlySet<string> = new Set([
  "Bearer Token",
  "Basic Auth Header",
]);

function isJoinedIdentifier(body: string): boolean {
  if (
    body.length > 48 ||
    !(IDENTIFIER_JOINED_RE.test(body) || VERSIONED_KEY_RE.test(body))
  )
    return false;
  // A WHOLE word: `monkey`, `capital`, `bypass` or `author` merely contain one and say nothing.
  if (!body.split(/[_:.]/).some((word) => CREDENTIAL_WORDS.has(word)))
    return false;
  let digits = 0;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code >= 48 && code <= 57) digits++;
  }
  return digits <= 2;
}

/**
 * A URL or a rooted path. A URL that carries a credential in it is still one:
 * a Teams or Zapier webhook has an id segment with digits in it, and userinfo
 * is a password. So a URL counts as a location only when it has neither.
 */
function isUrlWithoutCredential(body: string): boolean {
  if (!/^(?:https?:)?\/\//i.test(body) && !body.startsWith("/")) return false;
  if (/^(?:https?:)?\/\/[^/?#]*@/i.test(body)) return false;
  // Any query value of eight characters or more can be the credential.
  const query = body.indexOf("?");
  if (
    query !== -1 &&
    body
      .slice(query + 1)
      .split(/[&=#]/)
      .some((part) => part.length >= 8)
  )
    return false;
  for (const part of body.split(/[/?#&=]/)) {
    if (part.length >= 6 && /[0-9]/.test(part)) return false;
    // A long run of letters is as much a secret as a long run of letters and digits.
    if (part.length >= 20) return false;
  }
  return true;
}

// An env-var reference (`process.env.NAME`, `${NAME}`) and a mask of bullets, `*`, `.`, `_`, `-` or spaces are placeholders, not values:
// `isImplausibleSecretValue` drops them. A short value that ends in an ellipsis is not dropped: see `isElidedValue`.
const ENV_REFERENCE_RE =
  /^(?:(?:process|import\.meta)\.env\.[A-Za-z_]\w*|\$\{[A-Z][A-Z0-9_]{2,}\})$/;
const MASK_RE = /^[•●·*.\s_-]*$/u;

/**
 * `abcdefgh...`: a short stub with an ellipsis. It may be the visible start of a real secret, so it is never dropped: the
 * generic path reports it as a partial value at the informational tier (see `PARTIAL_VALUE_TYPE`). A value that is only a
 * mask (`••••`, `...`) is still dropped, by `MASK_RE`.
 */
function isElidedValue(body: string): boolean {
  const stripped = body.endsWith("...")
    ? body.slice(0, -3)
    : body.endsWith("…")
      ? body.slice(0, -1)
      : undefined;
  return stripped !== undefined && stripped.length <= 12;
}

/** The type of a value that ends in an ellipsis: not known to be a secret, not known to be anything else. */
const PARTIAL_VALUE_TYPE = "Partial Secret Value Visible (elided)";

/** The captured span reads as code, not as a quoted value. */
/** Longer than this a quoted value is not read as a code fragment: the clauses below can fire inside a long random password. */
const CODE_SPAN_MAX_LENGTH = 64;

function looksLikeCodeSpan(body: string): boolean {
  if (body.length > CODE_SPAN_MAX_LENGTH) return false;
  // Strict comparison belongs to code and to nothing else.
  if (/===|!==/.test(body)) return true;
  // The rest also occurs inside a real password (`Zx9&&Kw3mQ7`, `return-of-the-king`),
  // so it counts only with the statement separator that code has between them.
  if (
    body.includes(";") &&
    /=>|\)\s*\{|\bfunction\b|\breturn\b|;(?:var|let|const|if|for)\b|;\s+[A-Za-z_$][\w$]*\s*[=(.]/.test(
      body
    )
  )
    return true;
  let open = 0;
  let close = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") open++;
    else if (body[i] === ")") close++;
  }
  // Unbalanced parentheses count as code only around a member call (`a.b(`),
  // not around a bare `(` in a password (`Pa(ssw.rd9Qx`).
  return (
    open !== close &&
    /(?<![\w$])[A-Za-z][a-z]{2,}\.[a-z][A-Za-z]{2,}\(/.test(body)
  );
}

// None of these shapes is longer than a short label, a class name or an identifier;
// a longer value is not gated, which also bounds the work of every test below.
const IMPLAUSIBLE_MAX_LENGTH = 256;

export function isImplausibleSecretValue(
  body: string,
  patternName = ""
): boolean {
  if (body.length > IMPLAUSIBLE_MAX_LENGTH) return false;
  return (
    isUrlWithoutCredential(body) ||
    isCssModuleClass(body) ||
    (!SCHEME_VALUE_PATTERNS.has(patternName) && isJoinedIdentifier(body)) ||
    ENV_REFERENCE_RE.test(body) ||
    MASK_RE.test(body) ||
    looksLikeCodeSpan(body)
  );
}

// ── Credentials in sample data the page renders (#1308) ─────────────────────
//
// A seed-user table, a breach-lookup demo, a puzzle level and a generator's
// sample output carry realistic credentials as DATA. The value cannot tell
// them from a leak; the structure around it can: a row of an array of three or
// more objects with the same keys, with the email domains beside it reserved
// (`.test`, `example.com`), or an object that carries game or sample markers.

const TABLE_WALK_BACK = 1500;
const TABLE_WALK_FORWARD = 8000;
const TABLE_MIN_ROWS = 3;
const SEED_OBJECT_REACH = 600;
// Markers a puzzle or a generator carries and a configuration object does not.
// `flag` counts only with a string value: `flags:{…}` and `flag:true` are
// feature flags, which sit right beside real configuration.
const SEED_MARKERS: readonly RegExp[] = [
  /\bFLAG\{/,
  /\bflag(?:Path|Value|Answer)?\s*["']?\s*:\s*["'`]/,
  /\bcandidates\s*["']?\s*:\s*\[/,
  /\bcrack[A-Z]\w*\s*["']?\s*:/,
  /\bsample\s*["']?\s*:[\s\S]{0,400}?\boptions\b/,
  /\boptions\s*["']?\s*:[\s\S]{0,200}?\blength\s*["']?\s*:/,
];
// One marker alone is not enough: a real configuration can carry a string
// `flag` or an `options` object with a `length`. Two distinct markers in one
// object are a puzzle or a generator; one marker counts only inside a table.
const SEED_MARKERS_ALONE = 2;

/** The `{…}` the match sits in, bounded; undefined when it is not inside one. */
/** Characters the seed-data checks have walked, and the most one scan may spend on them. */
export const seedWork = { examined: 0 };
const SEED_SCAN_BUDGET = 3_000_000;

function enclosingObject(content: string, at: number): string | undefined {
  let depth = 0;
  let start = -1;
  for (let i = at - 1; i >= 0 && at - i <= SEED_OBJECT_REACH; i--) {
    const ch = content[i];
    if (ch === "}" || ch === "]") depth++;
    else if (ch === "{" || ch === "[") {
      if (depth > 0) depth--;
      else if (ch === "{") {
        start = i;
        break;
      } else return undefined;
    }
  }
  if (start === -1) return undefined;
  depth = 0;
  for (
    let i = start;
    i < content.length && i - start <= SEED_OBJECT_REACH * 2;
    i++
  ) {
    const ch = content[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return content.slice(start, start + SEED_OBJECT_REACH * 2);
}
const HOST_AFTER_AT_RE = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/;
const EMAIL_LOCAL_CHAR_RE = /[A-Za-z0-9._%+-]/;
/** The longest host read after an `@`: a name is at most 253 characters. */
const EMAIL_HOST_MAX = 255;

/**
 * The hosts of the email addresses in `text`: found from each `@`, with a one-character look behind and a bounded read ahead, so
 * a long run of local-part characters with no `@` in it (a hostile row) costs nothing per character.
 */
function emailHosts(text: string): string[] {
  const hosts: string[] = [];
  let at = text.indexOf("@");
  while (at !== -1) {
    if (at > 0 && EMAIL_LOCAL_CHAR_RE.test(text[at - 1]!)) {
      const host = HOST_AFTER_AT_RE.exec(
        text.slice(at + 1, at + 1 + EMAIL_HOST_MAX)
      )?.[1];
      if (host !== undefined) hosts.push(host);
    }
    at = text.indexOf("@", at + 1);
  }
  return hosts;
}
const RESERVED_HOST_RE =
  /(?:^|\.)(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|example|invalid|localhost)|(?:test|example|invalid|localhost))$/i;
// A key is at most 64 characters: unbounded, a long run of word characters with no colon is scanned again from every character in it.
const KEY_IN_ROW_RE = sharedRegex(/["']?([A-Za-z_$][\w$-]{0,63})["']?\s*:/g);

export type SeedVerdict = "skip" | "demo-login" | undefined;

/** Rows of the array the match sits in, when that array is a table of same-keyed objects. */
function tableAround(
  content: string,
  at: number,
  spend: (n: number) => void
): { text: string; rows: string[] } | undefined {
  spend(TABLE_WALK_BACK + TABLE_WALK_FORWARD);
  let depth = 0;
  let sawObject = false;
  let arrayStart = -1;
  for (let i = at - 1; i >= 0 && at - i <= TABLE_WALK_BACK; i--) {
    const ch = content[i];
    if (ch === "}" || ch === "]") depth++;
    else if (ch === "{" || ch === "[") {
      if (depth > 0) depth--;
      else if (ch === "{") {
        if (sawObject) return undefined;
        sawObject = true;
      } else {
        arrayStart = i;
        break;
      }
    }
  }
  if (arrayStart === -1 || !sawObject) return undefined;
  // Forward to the array's end, collecting the top-level objects as rows.
  const rows: string[] = [];
  let d = 0;
  let rowStart = -1;
  let end = -1;
  for (
    let i = arrayStart;
    i < content.length && i - arrayStart <= TABLE_WALK_FORWARD;
    i++
  ) {
    const ch = content[i];
    if (ch === "{" || ch === "[") {
      d++;
      if (d === 2 && ch === "{") rowStart = i;
    } else if (ch === "}" || ch === "]") {
      if (d === 2 && ch === "}" && rowStart !== -1) {
        rows.push(content.slice(rowStart, i + 1));
        rowStart = -1;
      }
      d--;
      if (d === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1 || rows.length < TABLE_MIN_ROWS) return undefined;
  return { text: content.slice(arrayStart, end), rows };
}

function rowKeys(row: string): string {
  const keys = new Set<string>();
  KEY_IN_ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEY_IN_ROW_RE.exec(row)) !== null) keys.add(m[1]!.toLowerCase());
  return [...keys].sort().join(",");
}

/**
 * What the data structure around a generic match says. `skip`: a sample (a
 * table whose emails are all reserved, or an object with game or sample
 * markers). `demo-login`: a table of same-keyed rows with real-domain emails,
 * which can be working logins and stays reported, labelled as such.
 */
function seedDataVerdict(
  content: string,
  at: number,
  keyName: string,
  budget: { left: number }
): SeedVerdict {
  // One scan has a fixed allowance for these walks; past it nothing is exempted,
  // so a page of ten thousand adversarial rows costs a bounded amount and every
  // password after the allowance reports as usual.
  const spend = (n: number) => {
    budget.left -= n;
    seedWork.examined += n;
  };
  if (budget.left <= 0) return undefined;
  spend(SEED_OBJECT_REACH * 2);
  const object = enclosingObject(content, at);
  const markers =
    object === undefined
      ? 0
      : SEED_MARKERS.filter((re) => re.test(object)).length;
  if (markers >= SEED_MARKERS_ALONE) return "skip";
  const near = content.slice(Math.max(0, at - 400), at + 400);
  // Cheap pre-check: a table has object separators close to the match.
  if (!/\}\s*,\s*\{/.test(near)) return undefined;
  if (budget.left <= 0) return undefined;
  const table = tableAround(content, at, spend);
  if (!table) return undefined;
  const shapes = table.rows.map(rowKeys);
  const key = keyName.toLowerCase();
  const carries = (shape: string) => shape.includes(key);
  const mine = shapes.filter(carries);
  if (mine.length < TABLE_MIN_ROWS || new Set(mine).size !== 1)
    return undefined;
  // A marker plus a table of same-shaped records is sample data.
  if (markers >= 1) return "skip";
  // The email domains that count are those of the rows that carry the secret's own key (an unrelated row of the same array with a
  // reserved-domain email does not make a real secret sample data), and EVERY such row needs an email: one row with a reserved
  // address does not excuse two rows with none.
  const perRow = table.rows
    .filter((_row, index) => carries(shapes[index]!))
    .map(emailHosts);
  if (perRow.some((rowHosts) => rowHosts.length === 0)) return undefined;
  const hosts = perRow.flat();
  return hosts.every((host) => RESERVED_HOST_RE.test(host))
    ? "skip"
    : "demo-login";
}

/** Could this body be a credential at all? */
export function isNotACredentialValue(body: string, patternName = ""): boolean {
  return (
    isNonAsciiText(body) ||
    isLocationValue(body) ||
    isModulePath(body) ||
    isDottedIdentifier(body) ||
    isTranslatedLabel(body) ||
    isTemplateExpression(body) ||
    isImplausibleSecretValue(body, patternName)
  );
}

// How far left a key may sit inside the string literal that holds it.
const LABEL_SCAN_LIMIT = 64;
const LABEL_CHAR_RE = /[\p{L}\p{N} _.'’-]/u;

/**
 * Is the credential word this match opens with the text of a string
 * literal, with the "value" opened by that literal's own closing quote?
 *
 * Compiled JSX writes a label as `children:"Password:"` and then goes on
 * with code, so `Password:"}),(0,r.jsx)("` is an assignment character for
 * character: the key, a `:`, a quote, eight characters that are not quotes
 * and a quote. What gives it away is that the key is followed straight by
 * the `:` (a quoted key closes first) while the walk to its left, over label
 * text only, meets an opening quote of the same kind as the one the "value"
 * opens with. A key in code is preceded by `{`, `,`, `;`, a line start or an
 * operator, never by a quote with only words between.
 */
function keyInsideStringLiteral(
  text: string,
  index: number,
  match: string
): boolean {
  // A label ends `Password:`; an HTML attribute (`a="b" password="…"`)
  // sits after a closing quote too, and is read as the assignment it is.
  const key = keyOf(match);
  const label = /^\s*:(['"])/.exec(match.slice(key.length));
  if (!label) return false;
  const valueQuote = label[1]!;
  const floor = Math.max(0, index - LABEL_SCAN_LIMIT);
  let at = index;
  while (at > floor && LABEL_CHAR_RE.test(text[at - 1] ?? "")) at--;
  // A label opens on its first word; a quote followed by a space is the
  // close of an earlier string (`name: "bob" password: "…"`).
  return at > 0 && text[at - 1] === valueQuote && !isSpaceAt(text, at);
}

// How far back a quoted key's own opening quote may sit.
const TERNARY_SCAN_LIMIT = 96;

/**
 * Is the credential word this match opens with the inside of a ternary branch
 * rather than a key? `m === 'password' ? 'password' : 'emailLink'` and
 * `p.startsWith("/reset-password") ? "Reset Password" : "Acme"` both
 * put a credential word immediately in front of a `:` and a string, which is
 * the shape of an assignment character for character (#2218).
 *
 * What tells them apart is what opens the quoted string the word sits in: a
 * key's quote follows `{`, `,` or the start of a line; a branch's follows the
 * `?`. Bounded, and the walk stops at the first quote either way.
 */
function startsInTernaryBranch(text: string, index: number): boolean {
  const floor = Math.max(0, index - TERNARY_SCAN_LIMIT);
  let at = index;
  while (at > floor && !QUOTE_CHAR_RE.test(text[at - 1] ?? "")) at--;
  if (at === floor || at === 0) return false;
  let quote = at - 1;
  while (quote > 0 && isSpaceAt(text, quote - 1)) quote--;
  return text[quote - 1] === "?";
}

/**
 * The shortest tail of a separator-shaped value: everything after its first
 * `:`. See FastPattern.minTailEntropy.
 */
function separatorTailOf(value: string): string {
  const at = value.indexOf(":");
  return at === -1 ? value : value.slice(at + 1);
}

const SCRIPT_SRC_ATTR_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;

/** Does this script's `src` point at a host other than the page's own? */
function isCrossOriginScript(src: string, pageUrl: string): boolean {
  try {
    return new URL(src, pageUrl).hostname !== new URL(pageUrl).hostname;
  } catch {
    return false;
  }
}

/**
 * A `data-*` credential attribute on a THIRD-PARTY `<script src="…">` element
 * is that script's own configuration, read by the vendor's loader in the
 * browser: `<script src="https://app.vendor.test/w.js" data-vendor="true"
 * data-api-key="…">`. A key a third-party loader reads out of the DOM is a
 * client key by construction, so it reports as public rather than as a leak —
 * shown, with the usual "verify usage restrictions" note, never counted
 * (#2218).
 *
 * The src has to resolve to a different host from the page's. A first-party
 * bundle (`src="/assets/app.js"`, `src="app.js"`) carrying a `data-api-key` is
 * the site's own key in the site's own markup, and nothing about that says
 * public. Without a page URL to resolve against, nothing is downgraded.
 */
function isVendorScriptDataAttribute(
  text: string,
  index: number,
  pageUrl: string | undefined
): boolean {
  if (pageUrl === undefined) return false;
  // The attribute is `data-<anything>`: the match starts at its credential
  // word (`secret` of `data-tb-secret`), so walk back over the attribute's name.
  let nameStart = index;
  while (
    nameStart > 0 &&
    index - nameStart < 64 &&
    /[A-Za-z0-9-]/.test(text[nameStart - 1] ?? "")
  )
    nameStart--;
  if (text.slice(nameStart, nameStart + 5).toLowerCase() !== "data-")
    return false;
  // The WHOLE attribute name has to be free of privileged words, not just its
  // last segment: `data-admin-api-key` ends in `api-key` and is not a widget key.
  if (
    keyWords(text.slice(nameStart, index)).some((w) =>
      PRIVILEGED_NAME_WORDS.includes(w)
    )
  )
    return false;
  const tag = tagBoundsAround(text, index);
  if (!tag) return false;
  const open = text.slice(tag.start, tag.end);
  if (!/^<script\b/i.test(open)) return false;
  const src = SCRIPT_SRC_ATTR_RE.exec(open)?.[1];
  return src !== undefined && isCrossOriginScript(src, pageUrl);
}

// ── Shapes that need their surroundings (#1283, #1227) ──────────────────────

/**
 * A PEM header is a private key only when key material follows it. UI help
 * text ("it starts with -----BEGIN OPENSSH PRIVATE KEY-----"), a regex in a
 * validator and a docs snippet whose body is elided (`MIIE...`) name the
 * header and carry no key. The key is a run of 32 or more base64 characters
 * right after the header, on one line or added up over narrow lines (a body
 * wrapped at 16, 20, 30 or 31 characters is a key too: chunks of 16 or more
 * characters count, and a word or `...` ends them), and what lies between the
 * header and the body has to be line breaks in whatever form the page writes
 * them and nothing else: `\n`, `\u000a`, `%0A`, `&#10;`, a `<br>` or `<p>` tag, a
 * quote, comma, `+`, bracket or `.concat(` between string literals, spaces, and
 * armor headers (`Proc-Type:`, `Version:`), at most PEM_MAX_GAP characters of
 * them. Prose, code or another `-----` marker between them means the header
 * was prose. A line is 64 characters in PEM and PGP armor and 70 in OpenSSH,
 * and the body may be a whole key on one line (#1227).
 */
// The body has to start within the gap limit of the header, so that is as far as
// the search reads: a bound per header, not per page (a page of ten thousand
// headers costs ten thousand small windows).
const PEM_REACH = 600;
const PEM_MAX_GAP = 400;
const PEM_BODY_RUN = 32;
/** The shortest line of key material counted towards a narrowly wrapped body (16-character wraps are real). */
const PEM_MIN_CHUNK = 16;
const PEM_BASE64_LEAD_RE = /^[A-Za-z0-9+/]+/;
// Line breaks in the encodings a page uses for them, kept as `\n` so armor
// header lines stay lines; and joins between string literals, which are not.
const PEM_BREAK_RES = [
  /\\u000[aAdD]/g,
  /\\x0[aAdD]/g,
  /\\[nrt]/g,
  /%0[aAdD]/g,
  /&#(?:x0*[aAdD]|0*1[03]);/gi,
  /&NewLine;/gi,
  /<\/?[A-Za-z][A-Za-z0-9-]{0,15}\b[^>]{0,200}>/gi,
];
const PEM_JOIN_RE = /\.(?:concat|join)\(/g;
// The armor header lines that sit between a header and its body.
const PEM_ARMOR_LINE_RE =
  /^[ \t"'`,;+[\]()\\]*(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset|MessageID):[^\n]{0,120}$/gim;
// Separates body chunks. `+` is NOT in it: it is a base64 character, and a join between string literals is a `+` token of its own
// (the quotes around it separate), which the loop below skips.
const PEM_CHUNK_SPLIT_RE = /[%\s"'`,;[\]()\\\u200b-\u200d\u2060\ufeff]+/;

/** Characters of header-following text examined, for the counter-based perf test. */
export const pemWork = { examined: 0 };

function hasPemBody(value: string, content: string, index: number): boolean {
  const start = index + value.length;
  let tail = content.slice(start, start + PEM_REACH);
  // Another header or the footer ends the search: nothing past it is this key's.
  const marker = tail.indexOf("-----");
  if (marker !== -1) tail = tail.slice(0, marker);
  pemWork.examined += tail.length;
  const raw = tail;
  for (const separator of PEM_BREAK_RES) tail = tail.replace(separator, "\n");
  tail = tail.replace(PEM_JOIN_RE, " ").replace(PEM_ARMOR_LINE_RE, "");
  // The body is a run of base64 chunks, one per line, however narrow the page wraps them: the chunk lengths add up.
  // Anything else (a word, `...`, a colon) ends it, and a chunk of under 16 characters is a word, not a line of key.
  let total = 0;
  let chunks = 0;
  let body = "";
  for (const token of tail.split(PEM_CHUNK_SPLIT_RE)) {
    if (token === "" || /^\++$/.test(token)) continue;
    // What lies between the header and the body, as the page wrote it, is bounded.
    if (chunks === 0 && raw.indexOf(token) > PEM_MAX_GAP) return false;
    const lead = PEM_BASE64_LEAD_RE.exec(token)?.[0] ?? "";
    if (lead.length >= PEM_BODY_RUN) return true;
    if (
      lead.length < PEM_MIN_CHUNK ||
      lead.length !== token.replace(/={1,2}$/, "").length
    )
      break;
    total += lead.length;
    chunks++;
    body += lead;
    // Several short lines add up to a key; a few long words do not look like one (a real body mixes cases and digits).
    if (total >= PEM_BODY_RUN)
      return (
        chunks === 1 ||
        (/[A-Z]/.test(body) && /[a-z]/.test(body) && /[0-9+/]/.test(body))
      );
  }
  return false;
}

/**
 * Twitter's app-only bearer tokens open with 21 `A` and then run through
 * URL-encoded segments (`%2B`, `%3D`) for about 110 characters in all. Runs of
 * `A` are also what zero bytes look like in base64, so a payload's interior
 * (a PNG, a WOFF font, a WASM module, a Dart table) opens the same way. The
 * token is not the interior of a base64 run (`/` or `+` either side, a
 * `base64,` lead-in), has real characters after the run of `A` and is not
 * mostly `A` itself (#1283).
 */
const TWITTER_BEARER_MAX_LENGTH = 200;
const TWITTER_BEARER_MIN_TAIL = 30;

// What a token is handed over with: `Authorization: Bearer AAAA`, `Bearer+AAAA`
// (a URL-encoded space), `token=AAAA`. After one of these the character in
// front of the run is the delimiter, not the edge of a base64 payload.
const BEARER_LEAD_RE = /(?:bearer|authorization|token|key)\W{0,3}$/i;

function plausibleTwitterBearer(
  value: string,
  content: string,
  index: number
): boolean {
  if (value.length > TWITTER_BEARER_MAX_LENGTH) return false;
  if (
    content
      .slice(Math.max(0, index - 7), index)
      .toLowerCase()
      .endsWith("base64,")
  )
    return false;
  const lead = content.slice(Math.max(0, index - 16), index);
  if (!BEARER_LEAD_RE.test(lead)) {
    const before = content[index - 1];
    const after = content[index + value.length];
    if (before === "/" || before === "+" || after === "/" || after === "+")
      return false;
  }
  let run = 0;
  while (value[run] === "A") run++;
  if (value.length - run < TWITTER_BEARER_MIN_TAIL) return false;
  let as = 0;
  for (let i = 0; i < value.length; i++) if (value[i] === "A") as++;
  return as * 2 <= value.length;
}

/**
 * An IBAN is `DO` for the Dominican Republic plus a two-digit check, a four
 * character bank code and twenty digits, 28 characters in all, and its check
 * digits satisfy mod 97. `DO` plus twenty uppercase characters is also the
 * shape of a DigitalOcean Spaces key id; a string that passes the IBAN check
 * is a bank account number printed as a form example (#1283).
 */
const IBAN_DO_RE = /^DO\d{2}[A-Z0-9]{4}\d{20}$/;

function isIbanShaped(value: string): boolean {
  if (!IBAN_DO_RE.test(value)) return false;
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : ch;
    for (const d of digits)
      remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/**
 * A prefixed token inside a file name: `neon_<hash>.png`, `sk-<hash>.svg`,
 * `key-<hash>.webp`. The prefix is a hashed asset's own naming, and the token
 * is followed by the file's extension, which no credential is (#1283).
 */
/** Two or more `lowercase-word Capital-word` boundaries: a camelCase name, not a random key. */
const CAMEL_CASE_WORDS_RE = /[a-z]{3,}[A-Z][a-z]{3,}[a-z0-9]*[A-Z][a-z]{3,}/;
const ASSET_EXTENSION_RE =
  /^\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm)(?![A-Za-z0-9])/i;

const ASSET_NAMED_PATTERNS: ReadonlySet<string> = new Set([
  "Shopify Admin API Token",
  "Neon Database Token",
  "OpenAI API Key (legacy)",
  "Mailgun API Key",
  "Resend API Key",
]);

// A file name starts after a path separator, a quote, `(` (CSS `url(`), `=` or a
// comma (a `srcset`); a token that is merely followed by `.png` in running text
// is not one.
const FILE_NAME_LEAD_RE = /[/"'(=,]$/;

function endsInAssetExtension(
  content: string,
  end: number,
  start: number
): boolean {
  return (
    FILE_NAME_LEAD_RE.test(content.slice(Math.max(0, start - 1), start)) &&
    ASSET_EXTENSION_RE.test(content.slice(end, end + 8))
  );
}

/**
 * Paystack's secret keys use Stripe's prefix: `sk_live_` or `sk_test_` plus
 * exactly 40 lowercase hex characters. Stripe's own tail is 24 random
 * alphanumerics in the old format and about a hundred in the current one, so a
 * tail that is nothing but hex and 32 or more characters long is not Stripe's.
 * Other widget vendors write the same prefix in front of 48 hex (#1283).
 */
const PAYSTACK_TAIL_RE = /^[0-9a-f]{40}$/;
const HEX_TAIL_RE = /^[0-9a-f]{32,}$/;
const DATA_KEY_ATTR_RE = /\b(data-[a-z0-9-]*(?:key|token))\s*=\s*["']?$/i;
const PRIVILEGED_ATTR_RE = /secret|private|server|admin|master/i;

function isWidgetKeyAttribute(before: string): boolean {
  const name = DATA_KEY_ATTR_RE.exec(before)?.[1];
  return name !== undefined && !PRIVILEGED_ATTR_RE.test(name);
}

// ── Search-only and platform-owned keys (#1287, #1229) ──────────────────────

/**
 * A key whose own name says it is the search key: `search_api_key`,
 * `search-only-api-key`. Hosted-search products issue a search-only key for the
 * browser by design, but a name is only a name: an admin key stored under
 * `ALGOLIA_SEARCH_API_KEY` reads the same, and nothing offline says which it
 * is. So the name earns a hint on the finding, never a downgrade (#1229).
 */
const PRIVILEGED_KEY_WORDS = [
  "admin",
  "secret",
  "private",
  "write",
  "master",
  "management",
  "manage",
  "backend",
  "server",
  "root",
];
const SEARCH_PROVIDER_KEY_SHAPE_RE = /^[A-Za-z0-9_-]{32}$/;

function isSearchKeyName(key: string): boolean {
  const words = keyWords(key);
  // `searchAdminApiKey` is the admin key of a search product, not its
  // browser key: the name has to say search and nothing privileged.
  return (
    (words.includes("search") || words.includes("searchkey")) &&
    !words.some((w) => PRIVILEGED_KEY_WORDS.includes(w))
  );
}

function isAdminSearchProviderKey(key: string, value: string): boolean {
  const words = keyWords(key);
  return (
    words.includes("master") ||
    words.includes("masterkey") ||
    (SEARCH_PROVIDER_KEY_SHAPE_RE.test(value) && words.includes("admin"))
  );
}

// A name that is only the scope word and `key`: Meilisearch's `masterKey` and
// `searchKey`, in any spelling (`MASTER_KEY`, `masterkey`, `SEARCHKEY`). A name
// that also says `api`, in two words or one (`search_apikey`), is a provider
// `*_api_key` name and is read by the generic detector as before.
function isBareSearchScopeKey(key: string): boolean {
  const words = keyWords(key);
  if (words.some((w) => w === "api" || w === "apikey")) return false;
  return words.some(
    (w) =>
      w === "search" || w === "master" || w === "searchkey" || w === "masterkey"
  );
}

function hasMeilisearchContext(
  content: string,
  index: number,
  key: string
): boolean {
  if (key.toLowerCase().includes("meili")) return true;
  return content
    .slice(Math.max(0, index - PROVIDER_CONTEXT_GAP), index)
    .toLowerCase()
    .includes("meili");
}

/**
 * Shopify's platform bundles (`/shopifycloud/` on cdn.shopify.com,
 * `/cdn/shopifycloud/` on a shop's own domain) are byte-identical on every
 * store: an `apiKey` in one is the platform's, not the merchant's. Only that
 * one assignment is skipped, never a secret, token or provider key, and only
 * on a Shopify host (cdn.shopify.com, or `*.myshopify.com`): a path alone is
 * something any site can serve (#1287).
 * The Shopify App Store listing pages carry the listed app's public `api-key`.
 */
const SHOPIFY_CDN_BUNDLE_PATH = "/shopifycloud/";
const SHOPIFY_STORE_BUNDLE_PATH = "/cdn/shopifycloud/";
const SHOPIFY_APP_STORE_HOST = "apps.shopify.com";
const APP_STORE_KEY_RE = /^(?:data-)?api[_-]?key$/i;

function platformSourceOf(
  location: ReportedLocation,
  sourceUrl: string | undefined
): "bundle" | "app-store" | undefined {
  if (sourceUrl === undefined) return undefined;
  try {
    const url = new URL(sourceUrl);
    if (location.startsWith("external-script")) {
      // A Shopify host, by parsed hostname: nothing else is evidence that the
      // bytes are Shopify's. A custom-domain shop's copy is not recognised and
      // reports like any other script.
      if (
        url.hostname === "cdn.shopify.com" &&
        url.pathname.startsWith(SHOPIFY_CDN_BUNDLE_PATH)
      )
        return "bundle";
      if (
        url.hostname.endsWith(".myshopify.com") &&
        url.pathname.startsWith(SHOPIFY_STORE_BUNDLE_PATH)
      )
        return "bundle";
    }
    if (url.hostname === SHOPIFY_APP_STORE_HOST) return "app-store";
  } catch {
    // not a URL: nothing is claimed
  }
  return undefined;
}
// ── Keys that are public by what they are called (#1294) ────────────────────

/**
 * Bundlers expose only the variables with a public prefix to the browser
 * (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`), so a value under one of those is public
 * by construction, and a key a developer called `public...` or `publishable...`
 * or `client...Key` says the same. A value with a secret prefix is not
 * rescued by its key: the prefix is the provider's own statement.
 */
const PUBLIC_ENV_PREFIX_RE = /^(?:NEXT_PUBLIC_|NUXT_PUBLIC_|VITE_|PUBLIC_)/;
const SECRET_VALUE_PREFIX_RE = /^(?:sk_|rk_|sb_secret_)/;
const PRIVILEGED_NAME_WORDS = [
  "secret",
  "private",
  "server",
  "admin",
  "password",
  "master",
  "service",
];

function isPublicKeyName(key: string): boolean {
  if (PUBLIC_ENV_PREFIX_RE.test(key)) return true;
  const words = keyWords(key);
  if (words.some((w) => PRIVILEGED_NAME_WORDS.includes(w))) return false;
  return (
    words[0] === "public" ||
    words[0] === "publishable" ||
    (words[0] === "client" && words[words.length - 1] === "key")
  );
}

// An AWS access key id is the public half of the pair: with no secret key
// beside it, it grants nothing (#1294). The secret is looked for within this
// many characters either side, as a keyed 40-character value.
const AWS_PAIR_REACH = 300;
// Any 40-character base64-alphabet token near the id may be its secret key, keyed or not
// (`["AKIA...", "<40>"]`, `{id, secret}`).
const AWS_SECRET_NEAR_RE =
  /(?<![A-Za-z0-9/+_-])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=_-])/;
// The access key id's shape, unanchored: whether a body holds one at all (the page HTML pass, #1864).
const AWS_KEY_ID_SHAPE_RE =
  /(?:A3T[A-Z0-9]|AKIA|AGPA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/;

// Browser SDKs whose init call takes a project key that is public by design
// (Bugsnag's notifier API key, Amplitude's API key). The key counts only when
// the SDK is the immediately enclosing call or object: `Bugsnag.start({apiKey`,
// `amplitude.getInstance().init(..., {apiKey`, `bugsnag: {apiKey`. The brand
// word anywhere nearby is not that, and the brands whose `apiKey` IS the
// secret API key (Datadog, Rollbar) or whose public id has no distinctive
// shape (Crisp, Tawk) are deliberately absent.
const SDK_INIT_BRANDS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /(?:bugsnag)[A-Za-z0-9_$.()]*\(\s*$|bugsnag["']?\s*[:=]\s*$/i,
    "Bugsnag API Key",
  ],
  [
    /(?:amplitude)[A-Za-z0-9_$.()]*\([^()]{0,80}$|amplitude["']?\s*[:=]\s*$/i,
    "Amplitude API Key",
  ],
];
const SDK_INIT_REACH = 240;

function sdkInitBrandOf(content: string, keyAt: number): string | undefined {
  let depth = 0;
  for (let i = keyAt - 1; i >= 0 && keyAt - i <= SDK_INIT_REACH; i--) {
    const ch = content[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const before = content.slice(Math.max(0, i - 80), i);
      return SDK_INIT_BRANDS.find(([re]) => re.test(before))?.[1];
    }
  }
  return undefined;
}

// What a RevenueCat key has to sit beside: the SDK's own name, in front of the
// value or after it. Without it `goog_ModuleLoaderConfigurationData1` is just an
// identifier.
const REVENUECAT_CONTEXT_RE = /purchases|revenuecat/i;
const REVENUECAT_CONTEXT_REACH = 200;

// A `private_key_id` is a service-account key file's only when the object it
// sits in says so: `"type": "service_account"` (quotes possibly escaped).
const SERVICE_ACCOUNT_TYPE_RE = /\\?"type\\?"\s*:\s*\\?"service_account\\?"/;
const SERVICE_ACCOUNT_REACH = 600;

/** Characters of source text kept on each side of a match in a finding's `context`. */
export const EVIDENCE_CONTEXT_RADIUS = 120;

// A long token-shaped run, the credentials of a URL or an unquoted assigned value: whatever else sits near a match could
// itself be a secret. A token run is any run of characters a password can hold (`@ ! # $ & %` included), stopped only by
// whitespace, quotes and code punctuation.
const NEARBY_TOKEN_RE = /[^\s"'`<>(){}[\];,]{20,}/g;
const NEARBY_TOKEN_CHAR_RE = /[^\s"'`<>(){}[\];,]/;
const URL_CREDENTIALS_RE = /(:\/\/)[^\s/@"'<>]+@/g;
// The unquoted value after `=`, `:` or `=>` (`DB_PASSWORD=p@ssw0rd!`), but not the `//` right after a URL scheme's `:`
// or the rest of `==` or `::`. The value runs to the next whitespace or quote, so punctuation inside a password
// (`Tr0ub;4dor&x`, `;6`) does not cut it short, and a value of any length is masked (`pin=482`). Code after an `=` or `:`
// (`"db": {`) is starred too: the snippet cannot tell it from a password.
const NEARBY_ASSIGNED_RE = /((?:=>|=|:(?!\/\/))\s*)([^\s"'`=:>][^\s"'`]*)/g;
// A run of 12 or more characters after a secret's label with no `=` or `:` between (`X-Api-Key abcdEFGHijklMNOP`,
// `// password qwertyuiopasdfghjk`). A letters-only run escapes the letter-and-digit rule, so the label marks it; a
// shorter word after a label (`the password field`) is prose and kept.
// `pin` must be the whole word: `spinner` and `pinned` are not labels.
const NEARBY_LABELLED_RE =
  /\b((?:x-)?api[-_ ]?key|access[-_]?key|secret[-_]?key|private[-_]?key|client[-_]?secret|secret|password|passwd|passphrase|passcode|pwd|pass|token|credentials?|pin\b)(\s+)([^\s"'`]{12,})/gi;
// A key before `=`, `:` or `=>` whose name holds a secret's label (`DB_PASSWORD`, `x-api-key`, `apiKey`, `PASSWORD2`,
// `db_pass_1`, `"password"`, `pin`, but not `passport`, `spinner` or `stripeKey`): its unquoted value is starred to the end of
// the line, so a passphrase with spaces (`password: correct horse battery staple`) shows none of its words, and so is every
// following line indented deeper than the key's, which holds a YAML block (`password: |`), folded (`>`) or continued plain
// value. Read on the raw text, before whitespace is collapsed, since a collapsed snippet has no line ends.
const LABELLED_KEY_LINE_RE = sharedRegex(
  /(^|[^\w$.-])(["']?)([A-Za-z_$][\w$.-]*)\2([ \t]*(?:=>|=(?![>=])|:)[ \t]*)(?=[^\s"'`]|[\r\n]|$)/gm
);
// A secret's label as a whole segment of a key, with an optional number after it (`PASSWORD2`, `db_pass_1`). The long labels
// count anywhere in the key (`passwordless`, `userpassword`).
const LABEL_SEGMENT_RE =
  /(?:^|[_.$-])(?:api[-_]?key|access[-_]?key|secret[-_]?key|private[-_]?key|client[-_]?secret|secret|pwd|pw|pass|token|credentials?|pin)\d*(?=$|[_.$-])|password|passwd|passphrase|passcode/;
// A last segment that names something about a secret, not the secret itself (`password_hint`, `token_url`, `pin_length`).
const NOT_A_SECRET_SEGMENT_RE =
  /[_.$-](?:hint|label|placeholder|prompt|title|field|policy|length|min|max|required|enabled|visible|type|url|path|file|name|id|expiry|expires|ttl)$/;
// An XML element: its text is starred when its tag name is a secret's label (`<password>correcthorsebattery</password>`).
const LABELLED_ELEMENT_RE = sharedRegex(
  /<([A-Za-z_][\w.:-]*)(?:\s[^<>]*)?>([^<]+)/g
);
// How far before the window a labelled key is read, so a key above the window still stars its value inside it.
const LABELLED_LOOKBACK = 1024;
const LINE_BREAK_RE = sharedRegex(/\r\n?|\n/g);
// Code punctuation: a span between two quotes that holds any of it is read as code between two literals, not as a literal.
const CODE_PUNCT_RE = /[;,(){}[\]=:+<>&|]/;
// When the match is not quoted, a reading that starts inside a quote and never closes it in the window claims the whole
// side is one literal: that is starred out when it is this long, an operand or holds no code punctuation.
const NEARBY_OPEN_LITERAL_MIN = 8;
// A literal whose opening quote follows `=`, `:`, `=>`, `(`, `,`, `[`, `{`, `?`, `+`, `||`, `&&` or `return` is an
// operand: an assigned value (`pw = "Pa55"`, `"password":"x"`), an argument, a list item or a fallback (`env.PW || 'x'`).
const OPERAND_BEFORE_RE = /(?:=>|\|\||&&|[=:(,[{?+]|\breturn)\s*$/;
// A shorter unquoted run that mixes letters and digits reads as a password or token too (`p@ssw0rd!`, a 16-character
// bearer token), and so does whatever follows an HTTP auth scheme word.
const NEARBY_SHORT_TOKEN_RE = /[^\s"'`<>(){}[\];,]{8,}/g;
const NEARBY_AUTH_SCHEME_RE =
  /\b(Bearer|Basic|Token|Digest)(\s+)([^\s"'`<>(){}[\];,]{4,})/gi;
const QUOTE_CHARS = ['"', "'", "`"] as const;

/**
 * A value near the match, masked: every character is starred out (at most 20 stars), so no part of a secret the
 * scanner did not itself recognize is shown. Only the match keeps the item id's prefix and suffix.
 */
function maskNearby(value: string): string {
  return "*".repeat(Math.min(value.length, 20));
}

/** Whether `key` (`DB_PASSWORD`, `apiKey`, `x-api-key`) names a secret: a label is one of its segments. */
function isLabelledKey(key: string): boolean {
  const segmented = key
    .replace(/^.*:/, "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return (
    LABEL_SEGMENT_RE.test(segmented) && !NOT_A_SECRET_SEGMENT_RE.test(segmented)
  );
}

/** The end of the line `at` sits on (the index of its line break, or `to`), and where the next line starts. */
function lineEndFrom(
  text: string,
  at: number,
  to: number
): { end: number; next: number } {
  LINE_BREAK_RE.lastIndex = at;
  const m = LINE_BREAK_RE.exec(text);
  if (!m || m.index >= to) return { end: to, next: to };
  return { end: m.index, next: Math.min(to, m.index + m[0].length) };
}

/**
 * The ranges of `content` between `from` and `to` that hold a labelled value: the unquoted value after a labelled key to the
 * end of its line, every following line indented deeper than the key's (blank lines between them included), and the text
 * of an element whose tag name is a label (see LABELLED_KEY_LINE_RE, LABELLED_ELEMENT_RE).
 */
function labelledValueRanges(
  content: string,
  from: number,
  to: number
): Array<[number, number]> {
  const text = content.slice(from, to);
  const ranges: Array<[number, number]> = [];
  const indentAt = (lineStart: number) =>
    /^[ \t]*/.exec(text.slice(lineStart, lineStart + 256))?.[0].length ?? 0;
  LABELLED_KEY_LINE_RE.lastIndex = 0;
  for (
    let m = LABELLED_KEY_LINE_RE.exec(text);
    m !== null;
    m = LABELLED_KEY_LINE_RE.exec(text)
  ) {
    if (!isLabelledKey(m[3] ?? "")) continue;
    const keyAt = m.index + (m[1] ?? "").length;
    const keyLineStart =
      Math.max(
        text.lastIndexOf("\n", keyAt - 1),
        text.lastIndexOf("\r", keyAt - 1)
      ) + 1;
    const indent = indentAt(keyLineStart);
    const valueAt = m.index + m[0].length;
    const valueLine = lineEndFrom(text, valueAt, text.length);
    ranges.push([from + valueAt, from + valueLine.end]);
    let scanned = valueLine.end;
    let next = valueLine.next;
    while (next < text.length) {
      const line = lineEndFrom(text, next, text.length);
      const body = text.slice(next, line.end);
      if (/\S/.test(body)) {
        const lineIndent = indentAt(next);
        if (lineIndent <= indent) break;
        ranges.push([from + next + lineIndent, from + line.end]);
      }
      scanned = line.end;
      if (line.next === line.end) break;
      next = line.next;
    }
    LABELLED_KEY_LINE_RE.lastIndex = Math.max(scanned, valueAt + 1);
  }
  LABELLED_ELEMENT_RE.lastIndex = 0;
  for (
    let m = LABELLED_ELEMENT_RE.exec(text);
    m !== null;
    m = LABELLED_ELEMENT_RE.exec(text)
  ) {
    if (!isLabelledKey(m[1] ?? "")) continue;
    const textAt = m.index + m[0].length - (m[2] ?? "").length;
    ranges.push([from + textAt, from + m.index + m[0].length]);
  }
  return ranges;
}

/** `content` from `s` to `e` with the parts inside `ranges` starred, its quotes and line breaks kept. */
function maskRanges(
  content: string,
  s: number,
  e: number,
  ranges: Array<[number, number]>
): string {
  const clipped = ranges
    .map(([a, b]): [number, number] => [Math.max(a, s), Math.min(b, e)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let out = "";
  let pos = s;
  for (const [a, b] of clipped) {
    if (b <= pos) continue;
    const from = Math.max(a, pos);
    out +=
      content.slice(pos, from) +
      content.slice(from, b).replace(/[^"'`\r\n]+/g, maskNearby);
    pos = b;
  }
  return out + content.slice(pos, e);
}

function redactNearby(text: string): string {
  return text
    .replace(URL_CREDENTIALS_RE, "$1****@")
    .replace(
      NEARBY_AUTH_SCHEME_RE,
      (_whole, scheme: string, gap: string, val: string) =>
        scheme + gap + maskNearby(val)
    )
    .replace(
      NEARBY_ASSIGNED_RE,
      (_whole, op: string, val: string) => op + maskNearby(val)
    )
    .replace(
      NEARBY_LABELLED_RE,
      (_whole, label: string, gap: string, val: string) =>
        label + gap + maskNearby(val)
    )
    .replace(NEARBY_TOKEN_RE, (run) => {
      // `DB_PASSWORD=` before its starred value is a key, not part of a token: keep it readable. A key that mixes letters
      // and digits is still starred by the short-token rule below.
      const keyed = /^([A-Za-z_$][\w$.-]{0,18}(?:=>|=|:))\*+$/.exec(run);
      return keyed
        ? keyed[1] + maskNearby(run.slice(keyed[1].length))
        : maskNearby(run);
    })
    .replace(NEARBY_SHORT_TOKEN_RE, (run) =>
      /[A-Za-z]/.test(run) && /[0-9]/.test(run) ? maskNearby(run) : run
    );
}

/** A string literal read in `text`: its [start, end) content span, whether its closing quote is in the window, and whether
 * it is the literal the reading started inside (rather than one opened by a quote in the window). */
interface LiteralSpan {
  start: number;
  end: number;
  closed: boolean;
  initial: boolean;
}

/**
 * The string literals in `text`, read outward from the match: forward for the text after it, backward for the text before
 * it. `openAt` is the quote the reading starts inside, if any. A literal left open at the far edge of the window runs to
 * that edge.
 */
function literalSpans(
  text: string,
  backward: boolean,
  openAt: string | undefined
): LiteralSpan[] {
  const spans: LiteralSpan[] = [];
  const n = text.length;
  const at = (k: number) => (backward ? n - 1 - k : k);
  const escaped = (k: number) => {
    const i = at(k);
    let slashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) slashes++;
    return slashes % 2 === 1;
  };
  let open = openAt;
  let from = 0;
  let initial = openAt !== undefined;
  const push = (from: number, to: number, closed: boolean) =>
    spans.push(
      backward
        ? { start: n - to, end: n - from, closed, initial }
        : { start: from, end: to, closed, initial }
    );
  for (let k = 0; k < n; k++) {
    const ch = text[at(k)];
    if (!QUOTE_CHARS.includes(ch as (typeof QUOTE_CHARS)[number]) || escaped(k))
      continue;
    if (open === undefined) {
      open = ch;
      from = k + 1;
    } else if (ch === open) {
      push(from, k, true);
      open = undefined;
      initial = false;
    }
  }
  if (open !== undefined) push(from, n, false);
  return spans;
}

/**
 * `text` with every quoted literal starred out, whatever its length, and the URL credentials, assigned values and token
 * runs between the literals starred out too.
 *
 * Which quotes open and which close is not known from the window alone: a stray apostrophe (`// don't`) flips every later
 * quote. Each quote character swaps "outside" with "inside that quote", so the four readings (outside, inside `"`, `'` or
 * `` ` ``) between them hold the true state at every point, and the literal that holds a secret is a literal in at least
 * one of them. When the match is not directly quoted, every reading is a main one; when it is, the reading that starts
 * inside the match's quote is. Every literal of a main reading is starred out, one the window cuts off included (see
 * NEARBY_OPEN_LITERAL_MIN for the one it starts inside); the other three
 * readings add each literal that is an operand, holds no code punctuation or holds no whitespace (their other "literals"
 * are the code between two real literals, so prose there survives and a token such as `-p'S3cr;tPw'` or `echo 'a;b'` does
 * not). The literal a reading starts inside and never closes in the window is not added: it would
 * star the whole side whenever a quote kind is absent, and the literals nested in it are the main reading's literals.
 */
function redactSide(
  text: string,
  backward: boolean,
  openQuote: string | undefined
): string {
  const operandOrPlain = (l: LiteralSpan) => {
    const body = text.slice(l.start, l.end);
    const operand =
      l.start > 0 && OPERAND_BEFORE_RE.test(text.slice(0, l.start - 1));
    return operand || (/\S/.test(body) && !CODE_PUNCT_RE.test(body));
  };
  const spans: Array<[number, number]> = [];
  const main =
    openQuote === undefined ? [undefined, ...QUOTE_CHARS] : [openQuote];
  for (const l of main.flatMap((q) => literalSpans(text, backward, q))) {
    if (
      l.closed ||
      !l.initial ||
      l.end - l.start >= NEARBY_OPEN_LITERAL_MIN ||
      operandOrPlain(l)
    )
      spans.push([l.start, l.end]);
  }
  if (openQuote !== undefined) {
    for (const q of [
      undefined,
      ...QUOTE_CHARS.filter((c) => c !== openQuote),
    ]) {
      for (const l of literalSpans(text, backward, q)) {
        if (l.initial && !l.closed) continue;
        if (
          operandOrPlain(l) ||
          (l.closed && !/\s/.test(text.slice(l.start, l.end)))
        )
          spans.push([l.start, l.end]);
      }
    }
  }
  const merged: Array<[number, number]> = [];
  for (const [s, e] of spans
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  let out = "";
  let pos = 0;
  for (const [s, e] of merged) {
    out += redactNearby(text.slice(pos, s)) + maskNearby(text.slice(s, e));
    pos = e;
  }
  return out + redactNearby(text.slice(pos));
}

/**
 * The redacted evidence context of a match at `offset` in `content`: the text either side with other quoted literals and
 * token-shaped runs masked, and the match itself masked exactly as its item id is. A token run the window cuts off at either
 * edge is dropped, so no fragment of it shows unmasked. Undefined when the match is not at that offset.
 */
export function evidenceContext(
  content: string,
  offset: number,
  length: number,
  value: string
): string | undefined {
  if (
    offset < 0 ||
    length <= 0 ||
    content.slice(offset, offset + Math.min(length, value.length)) !==
      value.slice(0, length)
  ) {
    return undefined;
  }
  const isToken = (i: number) =>
    i >= 0 && i < content.length && NEARBY_TOKEN_CHAR_RE.test(content[i] ?? "");
  const start = Math.max(0, offset - EVIDENCE_CONTEXT_RADIUS);
  const end = Math.min(
    content.length,
    offset + length + EVIDENCE_CONTEXT_RADIUS
  );
  let beforeAt = start;
  let afterEnd = end;
  if (isToken(start - 1) && isToken(start)) {
    const cut = [...content.slice(start, offset)].findIndex(
      (ch) => !NEARBY_TOKEN_CHAR_RE.test(ch)
    );
    beforeAt = cut < 0 ? offset : start + cut + 1;
  }
  if (isToken(end) && isToken(end - 1)) {
    let cut = end - 1;
    while (
      cut >= offset + length &&
      NEARBY_TOKEN_CHAR_RE.test(content[cut] ?? "")
    )
      cut--;
    afterEnd = Math.max(cut, offset + length);
  }
  // Labelled values run to the end of their line and onto deeper-indented lines, so star them before the line ends are
  // collapsed. They are read from a little before the window, so a key above it still stars its value, and on both sides
  // of the match, so a labelled value on the match's own line, before it, is starred up to the match. The match itself is
  // never starred here: it is masked as in the item id.
  const ranges = labelledValueRanges(
    content,
    Math.max(0, beforeAt - LABELLED_LOOKBACK),
    afterEnd
  );
  const before = maskRanges(content, beforeAt, offset, ranges);
  const after = maskRanges(content, offset + length, afterEnd, ranges);
  const prev = content[offset - 1];
  const openQuote = QUOTE_CHARS.find((q) => q === prev);
  const flat = (t: string) => t.replace(/\s+/g, " ");
  return `${redactSide(flat(before), true, openQuote)}${maskSecret(value)}${redactSide(flat(after), false, openQuote)}`;
}

function maskSecret(value: string): string {
  if (value.length <= 12) {
    return value.slice(0, 4) + "*".repeat(value.length - 4);
  }
  return (
    value.slice(0, 6) +
    "*".repeat(Math.min(value.length - 10, 20)) +
    value.slice(-4)
  );
}

/**
 * How far past a brand keyword a bare-shape value may START (#357, after
 * trufflehog's PrefixRegex). The value may run on past it.
 *
 * The old ±500-character window meant "the word together appears somewhere
 * on this screen of text", which on real pages it does. Forty characters is
 * `togetherKey: "`, `TOGETHER_API_KEY = "` and `"together": {"token": "`,
 * and not a share link three lines up.
 */
export const CONTEXT_KEYWORD_GAP = 40;

// The longest a context value can be, plus the gap: how much text past a
// keyword is worth handing the regex. Every bounded shape in the tier is
// under 70 characters; Sanity's `{30,}` is open-ended but a real token is
// under 200.
const CONTEXT_SCAN_SPAN = CONTEXT_KEYWORD_GAP + 512;

// How much text either side of a value the key-context helpers get to see:
// the whole look-back budget, and enough after it to find the tag's `>`.
const CONTEXT_LOCAL_REACH = LOOKBEHIND_SCAN_LIMIT + SECRET_KEY_LOOKBEHIND_SIZE;

// `\w` on one code unit: the boundary the prefix patterns and the bounded
// look-behind both want.
function isWordCharAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const c = text.charCodeAt(index);
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95
  );
}

// How far a continued token is read past its match before it is cut.
const CONTINUED_TOKEN_MAX = 256;

/**
 * Where the token a match sits at the start of really ends, or `end` itself
 * when the match is the whole token.
 *
 * The left-boundary guard makes a prefix count only at the start of a token;
 * this is the same question asked on the right. A provider format has a
 * fixed length or a fixed alphabet, so `ghp_` + 36, `AKIA` + 16 or `key-` +
 * 32 followed by more letters and digits (or by `_`, or `-` and more) is a
 * longer token that happens to open like a credential. It is not an
 * independently delimited provider token and is not reported as one; the
 * caller reports the whole token with the provider left unknown. A token the
 * match does not stop short of ends on a quote, a space or punctuation, and
 * this returns `end`.
 */
function continuedTokenEnd(text: string, end: number): number {
  let at = end;
  const limit = Math.min(text.length, end + CONTINUED_TOKEN_MAX);
  while (at < limit) {
    if (isWordCharAt(text, at)) at++;
    else if (text.charCodeAt(at) === 45 && isWordCharAt(text, at + 1))
      at++; // -
    else break;
  }
  return at;
}

/** The finding type for a secret-prefixed token no provider can be named for. */
export function unattributedKeyType(prefix?: string): string {
  return prefix === undefined
    ? "Secret Key (provider unknown)"
    : `Secret Key (${prefix} prefix, provider unknown)`;
}

// One window's worth of characters. Every pattern in this file matches more
// than a dozen, so a value with no window of its own is rare enough to compare
// against directly.
const OVERLAP_WINDOW = 12;

// The longest value worth indexing. Several patterns are unbounded on the right
// — a connection string runs to the first quote — so one runaway match can be
// megabytes, and hashing every window of it costs more than the comparisons it
// saves. Far above any real credential: a Supabase JWT, the longest thing this
// file matches on purpose, is a few hundred characters.
const OVERLAP_MAX_INDEXED = 1024;

// Rabin-Karp over one window, mod 2^32. A collision costs one extra comparison
// and nothing else: no part of the decision rests on the hash.
const OVERLAP_BASE = 131;
const OVERLAP_LEAD = (() => {
  let lead = 1;
  for (let i = 1; i < OVERLAP_WINDOW; i++) lead = Math.imul(lead, OVERLAP_BASE);
  return lead >>> 0;
})();

function windowHash(text: string, start: number): number {
  let hash = 0;
  for (let i = 0; i < OVERLAP_WINDOW; i++) {
    hash = (Math.imul(hash, OVERLAP_BASE) + text.charCodeAt(start + i)) >>> 0;
  }
  return hash;
}

/** The window one character along, without re-reading the eleven it shares. */
function rollWindow(text: string, hash: number, nextStart: number): number {
  const dropped = Math.imul(text.charCodeAt(nextStart - 1), OVERLAP_LEAD);
  const shifted = Math.imul((hash - dropped) >>> 0, OVERLAP_BASE);
  return (shifted + text.charCodeAt(nextStart + OVERLAP_WINDOW - 1)) >>> 0;
}

// Bits for the window filter: a page that finds nothing never fills it, and one
// that finds thousands still stops at a quarter of a megabyte.
function filterWordCount(contentLength: number): number {
  const wanted = Math.min(Math.max(contentLength >> 3, 64), 1 << 16);
  let words = 64;
  while (words < wanted) words *= 2;
  return words;
}

export interface SeenValues {
  has: (value: string) => boolean;
  add: (value: string) => void;
  overlaps: (value: string) => boolean;
}

/** A seen value with the hash of its first window, for the second reject. */
interface IndexedValue {
  value: string;
  firstHash: number;
}

/**
 * The values already kept, and the question asked of them for every candidate:
 * does either one contain the other?
 *
 * Asked pairwise that is quadratic, and it bites — an 880 KB page producing
 * 16k findings spent 2.1s of a 2.2s scan inside this one loop (#176). But both
 * halves are really window questions. `value.includes(seen)` is "some window of
 * `value` equals `seen`", and `seen.includes(value)` is "some window of `seen`
 * equals `value`", so hashing windows narrows each half to a handful of pairs:
 *
 * - a seen value INSIDE the candidate ends on one of the candidate's own
 *   windows and begins on another, so seen values are indexed by the hash of
 *   their LAST window and rejected on the hash of their first;
 * - a seen value CONTAINING the candidate has to be longer than it and has to
 *   contain its first window, so a filter over every window of every seen value
 *   rules out nearly every candidate before a comparison happens.
 *
 * Indexed by the last window rather than the first because a secret is a family
 * with a constant head: every JWT this file matches opens with the same 37
 * characters, `AIza` and `ghp_` and `sk-` open thousands more, and keying on
 * the head would file a page of them into one bucket and walk it for every
 * candidate. The random tail is the end that tells them apart.
 *
 * Neither structure decides anything. Both only narrow the field, the string
 * comparison still makes every call, and no pair reaches it that the pairwise
 * loop did not also compare — so the suppression is the one the loop made.
 */
export function createSeenValues(contentLength: number): SeenValues {
  const values = new Set<string>();
  const byLastWindow = new Map<number, IndexedValue[]>();
  const byLength = new Map<number, string[]>();
  // Values with no window of their own, and values too long to be worth one.
  // Neither is indexed; both are compared directly, and there are never many.
  const windowless: string[] = [];
  const oversized: string[] = [];
  const windowBits = new Uint32Array(filterWordCount(contentLength));
  const bitMask = windowBits.length * 32 - 1;
  // The candidate's own window hashes, reused across candidates so that reading
  // a value's last window costs a lookup rather than a second pass.
  const windowHashes = new Uint32Array(OVERLAP_MAX_INDEXED);
  let longest = 0;

  const setBit = (hash: number) => {
    const bit = hash & bitMask;
    windowBits[bit >>> 5]! |= 1 << (bit & 31);
  };

  const hasBit = (hash: number) => {
    const bit = hash & bitMask;
    return (windowBits[bit >>> 5]! & (1 << (bit & 31))) !== 0;
  };

  const add = (value: string) => {
    values.add(value);
    if (value.length > longest) longest = value.length;

    if (value.length < OVERLAP_WINDOW) {
      windowless.push(value);
      return;
    }
    if (value.length > OVERLAP_MAX_INDEXED) {
      oversized.push(value);
      return;
    }

    const sameLength = byLength.get(value.length);
    if (sameLength) sameLength.push(value);
    else byLength.set(value.length, [value]);

    const first = windowHash(value, 0);
    let hash = first;
    for (let start = 0; start + OVERLAP_WINDOW <= value.length; start++) {
      if (start > 0) hash = rollWindow(value, hash, start);
      setBit(hash);
    }

    // `hash` has rolled to the last window by now, which is the key.
    const indexed: IndexedValue = { value, firstHash: first };
    const bucket = byLastWindow.get(hash);
    if (bucket) bucket.push(indexed);
    else byLastWindow.set(hash, [indexed]);
  };

  const overlaps = (value: string): boolean => {
    // A candidate the index cannot describe is compared the way it always was.
    if (value.length < OVERLAP_WINDOW || value.length > OVERLAP_MAX_INDEXED) {
      for (const seen of values) {
        if (value.includes(seen) || seen.includes(value)) return true;
      }
      return false;
    }

    // Values outside the index are shorter than every candidate that reaches
    // here, or longer than all of them, so each can only sit on one side.
    for (const seen of windowless) {
      if (value.includes(seen)) return true;
    }
    for (const seen of oversized) {
      if (seen.includes(value)) return true;
    }

    const lastStart = value.length - OVERLAP_WINDOW;
    let hash = windowHash(value, 0);
    windowHashes[0] = hash;
    for (let start = 1; start <= lastStart; start++) {
      hash = rollWindow(value, hash, start);
      windowHashes[start] = hash;
    }

    // A seen value this one contains ends on one of these windows and begins on
    // another, so both have to line up before the strings are compared at all.
    // Where it ends fixes where it begins, which is why the comparison below is
    // anchored rather than searched for. An equal value is caught here too, on
    // the windows it shares with itself.
    for (let end = 0; end <= lastStart; end++) {
      for (const seen of byLastWindow.get(windowHashes[end]!) ?? []) {
        const start = end - (seen.value.length - OVERLAP_WINDOW);
        if (start < 0 || windowHashes[start] !== seen.firstHash) continue;
        if (value.startsWith(seen.value, start)) return true;
      }
    }

    // A seen value containing this one is strictly longer and holds its first
    // window, so a clear bit ends the question for the whole set.
    if (value.length < longest && hasBit(windowHashes[0]!)) {
      for (const [length, sameLength] of byLength) {
        if (length <= value.length) continue;
        for (const seen of sameLength) {
          if (seen.includes(value)) return true;
        }
      }
    }
    return false;
  };

  return { has: (value) => values.has(value), add, overlaps };
}

// The mandatory literals are derived from each pattern's SOURCE, so they are
// computed once at module load rather than per page.
const PREFILTERED_FAST_PATTERNS = withPrefilter(FAST_PATTERNS);

// Below this a bare-shape value under a credential key is a label, a
// placeholder or a word, not a token (gitleaks: 3.5 for generic-api-key).
const GENERIC_MIN_ENTROPY = 3.5;

/**
 * The floor a generic value has to clear. Empirical entropy cannot exceed
 * log2(length), so a flat 3.5 would silence every 8–11 character password
 * however random: the floor scales down for short values, asking them to be
 * NEAR their maximum instead. `K8#mZ2!q` (3.0 of a possible 3.0) passes,
 * `aaaabbbb` (1.0) does not, and from 12 characters up it is the flat 3.5.
 */
function genericEntropyFloor(length: number): number {
  return Math.min(GENERIC_MIN_ENTROPY, Math.log2(Math.max(length, 2)) - 0.5);
}

/**
 * The part of a generic match that is the value: the quoted body of an
 * assignment, or the token after `Bearer`/`Basic`.
 */
function genericValueOf(match: string): string {
  const quoted = /['"]([^'"]*)['"]$/.exec(match);
  let body = (quoted ? quoted[1]! : match).replace(/^(?:Bearer|Basic)\s+/i, "");
  if (!quoted) {
    // `aws_secret_access_key = XXXX`: the value is the last token.
    // Split on separators, not on a token's own `=` padding: `Bearer …==`
    // ends in two of them, and an empty last part has no entropy at all. The
    // padding comes off by a walk, not `/=+$/`: on `Basic ====…A` that
    // regex retries from every `=` and goes quadratic.
    let end = body.length;
    while (end > 0 && body.charCodeAt(end - 1) === 61) end--;
    const parts = body
      .slice(0, end)
      .split(/[\s:=]+/)
      .filter(Boolean);
    body = parts[parts.length - 1] ?? body;
  }
  return body;
}

/**
 * Does the keyword prefilter let this FAST pattern run on this content? True
 * unless the gram index proves every one of the pattern's keywords absent.
 * The index folds ASCII case, so the lowercase keywords are looked up as-is
 * and no lowercased copy of the content is needed; a keyword under four
 * characters (`re_`, `ac`) proves nothing and its pattern always runs, as
 * it did before. A pattern with no keywords declared always runs too; the
 * corpus meta-test is what makes that an error rather than a silent default.
 */
function fastPatternMayFire(
  pattern: { keywords?: string[] },
  index: GramIndex | null
): boolean {
  const keywords = pattern.keywords;
  if (!index || !keywords || keywords.length === 0) return true;
  for (const keyword of keywords) {
    if (mayContain(index, keyword)) return true;
  }
  return false;
}

// The public-by-design context patterns, each with its shape anchored to a
// whole value: a generic assignment yields to one of these only when its
// keyword is in front of the value AND the value IS that shape. Proximity
// alone would let `shopify: {password: "…"}` hide a real password.
// The pair patterns that read their key's name (#359) claim the same way: the
// key already said which half of the pair the value is, so `PUSHER_SECRET`
// reports as the Pusher app secret rather than as a generic secret.
const CLAIMING_CONTEXT = CONTEXT_PATTERNS.filter(
  (p) => p.publicByDesign || p.keyName
).map((p) => ({
  keyword: p.keyword,
  keyName: p.keyName,
  whole: new RegExp(
    `^(?:${p.pattern.source})$`,
    p.pattern.flags.replace("g", "")
  ),
}));
const CLAIMING_KEYWORD_MAX = Math.max(
  0,
  ...CLAIMING_CONTEXT.map((p) => p.keyword.length)
);

/**
 * Client SDKs whose configuration object or custom element carries a key
 * that is public by design. A generic assignment under one of these — the
 * brand as the parent key (`raygun:{apiKey:"…"}`), as the tag name
 * (`<builder-component api-key="…">`) or within the look-behind — reports at
 * the public tier under the brand's name (#357 r3). Deliberately short:
 * the public keys pub#359 added carry a shape of their own (`sub-c-`,
 * `NRJS-`, `pk_test_`) or a key-name rule in CONTEXT_PATTERNS (Pusher,
 * Uploadcare, Algolia search-only), which a brand word alone cannot give.
 */
const PUBLIC_BRANDS: ReadonlyArray<readonly [brand: string, type: string]> = [
  ["raygun", "Raygun API Key"],
  ["builder", "Builder.io API Key"],
  ["posthog", "PostHog Project Key"],
  ["mixpanel", "Mixpanel Token"],
  ["sentry", "Sentry Client Key"],
  ["mapbox", "Mapbox Access Token"],
  ["algolia-docsearch", "Algolia DocSearch Key"],
  ["intercom", "Intercom App ID"],
  ["hotjar", "Hotjar Site ID"],
  ["fullstory", "FullStory Org ID"],
  ["logrocket", "LogRocket App ID"],
  ["launchdarkly-client", "LaunchDarkly Client ID"],
];
const PUBLIC_BRAND_MAX = Math.max(...PUBLIC_BRANDS.map(([b]) => b.length));

// Shopify's own boot JSON and theme code inline the Storefront token under
// `accessToken`; on a page that loads from cdn.shopify.com a 32-hex value
// under that key is it.
const SHOPIFY_TOKEN_KEY_RE = /^(?:access[_-]?token|accesstoken)$/i;
const SHOPIFY_TOKEN_RE = /^[a-f0-9]{32}$/;
// A parsed-host test, not a substring and not a regex over the content:
// `cdn.shopify.com.evil.test` and `notcdn.shopify.com` must not make a page
// Shopify's. Every absolute or protocol-relative URL in the body is a
// candidate; each is parsed and its hostname compared whole.
const SHOPIFY_CDN_HOST = "cdn.shopify.com";
const URL_CANDIDATE_RE = sharedRegex(/(?:https?:)?\/\/[^\s"'<>]+/g);
const URL_CANDIDATE_CAP = 2000;

/** Does the page reference `hostname` by URL? Parsed, never matched. */
function pageLoadsFrom(text: string, hostname: string): boolean {
  URL_CANDIDATE_RE.lastIndex = 0;
  let seen = 0;
  let m: RegExpExecArray | null;
  while (
    (m = URL_CANDIDATE_RE.exec(text)) !== null &&
    seen++ < URL_CANDIDATE_CAP
  ) {
    try {
      if (new URL(m[0], "https://page.invalid/").hostname === hostname)
        return true;
    } catch {
      // not a URL after all
    }
  }
  return false;
}

// A `<script …>` open tag, for the blocks whose attributes name a public
// keyword (`<script id="shopify-features">`): the whole block is that
// keyword's look-behind.
const SCRIPT_OPEN_RE = sharedRegex(/<script\b([^>]*)>/gi);
const SCRIPT_BLOCK_LIMIT = 65536;
const SCRIPT_CLOSE_RE = /<\/script/i;

/** Where a script block opened at `from` ends: its close tag, case-insensitive, or the cap. */
function scriptBlockEnd(text: string, from: number): number {
  const slice = text.slice(from, from + SCRIPT_BLOCK_LIMIT);
  const close = SCRIPT_CLOSE_RE.exec(slice);
  return from + (close ? close.index : slice.length);
}

/**
 * Is the match the tail of a URL, not an assignment? `src="https://cdn…/
 * Access…"` matched the generic token pattern part-way through a path.
 * Reads back 60 characters for an unclosed `src="`, `href="` or `url(`.
 */
const URL_OPENERS: ReadonlyArray<readonly [marker: string, closer: string]> = [
  ['src="', '"'],
  ["src='", "'"],
  ['href="', '"'],
  ["href='", "'"],
];

function insideUrlValue(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 60), index).toLowerCase();
  for (const [marker, closer] of URL_OPENERS) {
    const at = window.lastIndexOf(marker);
    if (at === -1) continue;
    // The PATH runs from the marker's end. A closer before the match means
    // the attribute ended; a `?` means the match is in the query string,
    // where `?password=…` is a credential, not a path segment.
    const path = window.slice(at + marker.length);
    if (!path.includes(closer) && !path.includes("?")) return true;
  }
  return false;
}

/**
 * A vendor's public identifier carried in the query string of a script or
 * link URL (#574): `<script src="https://cdn.mida.so/js/optimize.js?key=…">`.
 * The vendor's own install snippet puts it there for every visitor, so a
 * secret-shaped value in that exact parameter is the vendor's client
 * identifier, not a leak, and is neither reported nor listed as public.
 *
 * Add a row only when the vendor's documentation says the identifier is
 * public and shows it in a URL. A row names the exact hostnames, the exact
 * path and the query parameters; nothing is matched by substring, and the
 * same parameter on any other host or path is still read as a credential.
 */
export interface PublicUrlIdentifier {
  vendor: string;
  /** Exact hostnames, lowercase. A port, userinfo or subdomain does not match. */
  hosts: readonly string[];
  /** Exact URL paths the snippet loads. */
  paths: readonly string[];
  /** Query parameters whose value is the public identifier. */
  params: readonly string[];
}

export const PUBLIC_URL_IDENTIFIERS: readonly PublicUrlIdentifier[] = [
  // Mida A/B testing: the project key in the optimize.js install snippet.
  {
    vendor: "Mida",
    hosts: ["cdn.mida.so", "cdn-eu.mida.so"],
    paths: ["/js/optimize.js"],
    params: ["key"],
  },
  // Klaviyo: `company_id` is the public API key (site ID); its API docs
  // call the six-character value public and for client-side use.
  {
    vendor: "Klaviyo",
    hosts: ["static.klaviyo.com"],
    paths: ["/onsite/js/klaviyo.js"],
    params: ["company_id"],
  },
  // Google reCAPTCHA v3 / Enterprise: `render` carries the site key, the
  // half of the key pair that goes in the page; the secret stays on the server.
  {
    vendor: "Google reCAPTCHA",
    hosts: ["www.google.com", "www.recaptcha.net"],
    paths: ["/recaptcha/api.js", "/recaptcha/enterprise.js"],
    params: ["render"],
  },
];

const PUBLIC_URL_HOSTS: ReadonlyArray<
  readonly [host: string, entry: PublicUrlIdentifier]
> = PUBLIC_URL_IDENTIFIERS.flatMap((entry) =>
  entry.hosts.map((host) => [host, entry] as const)
);
const PUBLIC_URL_MAX_PER_HOST = 64;
const PUBLIC_URL_MAX_LENGTH = 2048;
const URL_TOKEN_END_RE = /[\s"'<>\\)]/;

/**
 * The `[start, end)` spans of every vendor identifier value in `content`.
 * Positional on purpose: a finding is dropped only when it lies wholly inside
 * one, so the same value elsewhere on the page, or a longer secret that
 * merely contains it, is still read on its own terms.
 */
export function publicUrlIdentifierSpans(
  content: string,
  index: GramIndex | null = null
): Array<[start: number, end: number]> {
  const spans: Array<[number, number]> = [];
  for (const [host, entry] of PUBLIC_URL_HOSTS) {
    // Each host is a search of the whole content; the content's gram index can prove it is not there (#1864).
    if (index && !mayContain(index, host)) continue;
    let from = 0;
    let seen = 0;
    let at: number;
    while (
      (at = content.indexOf(host, from)) !== -1 &&
      seen++ < PUBLIC_URL_MAX_PER_HOST
    ) {
      from = at + host.length;
      // The host must open a URL: `//host` after a scheme colon, a quote,
      // `=`, `(`, `,` or whitespace; never `https://other.test//host`.
      if (
        at < 2 ||
        content.charCodeAt(at - 1) !== 47 ||
        content.charCodeAt(at - 2) !== 47
      )
        continue;
      const lead = at >= 3 ? content[at - 3]! : "";
      if (lead !== "" && !/[:\s"'(=,]/.test(lead)) continue;

      let end = from;
      const limit = Math.min(content.length, at + PUBLIC_URL_MAX_LENGTH);
      while (end < limit && !URL_TOKEN_END_RE.test(content[end]!)) end++;
      const rest = content.slice(from, end);
      // `rest` starts right after the host: it must be the path start, not
      // more host (`cdn.mida.so.evil.test`, `cdn.mida.so:8080`, `@evil`).
      if (rest[0] !== "/") continue;
      const q = rest.indexOf("?");
      if (q === -1) continue;
      if (!entry.paths.includes(rest.slice(0, q))) continue;
      let queryEnd = rest.indexOf("#", q);
      if (queryEnd === -1) queryEnd = rest.length;

      let segStart = q + 1;
      while (segStart <= queryEnd) {
        let segEnd = rest.indexOf("&", segStart);
        if (segEnd === -1 || segEnd > queryEnd) segEnd = queryEnd;
        const eq = rest.indexOf("=", segStart);
        if (
          eq !== -1 &&
          eq < segEnd &&
          entry.params.includes(rest.slice(segStart, eq)) &&
          segEnd > eq + 1
        ) {
          spans.push([from + eq + 1, from + segEnd]);
        }
        segStart = segEnd + 1;
      }
    }
  }
  return spans;
}

/**
 * Providers whose key kind is written in the key's own prefix, so a value
 * under a generic credential key can be classified rather than labelled
 * generically. A row applies only when the provider's name sits within
 * PROVIDER_CONTEXT_GAP characters before the key (a parent object, an init
 * call, an env var name). Without it, a `secret`-kind prefix is reported
 * under the prefix with the provider left unknown, and a `client`-kind
 * prefix is left to the generic assignment as before.
 *
 * Add a row only when the provider's documentation states which prefix is
 * confidential and which is meant for public applications.
 */
export interface ProviderKeyPrefix {
  provider: string;
  /** Lowercase word that names the provider in the text before the key. */
  keyword: string;
  /** The whole value, prefix included. */
  shape: RegExp;
  prefix: string;
  kind: "server-secret" | "client-sdk";
  type: string;
}

export const PROVIDER_KEY_PREFIXES: readonly ProviderKeyPrefix[] = [
  // Statsig: server secret keys are confidential, client SDK keys are meant
  // for public applications (docs.statsig.com/access-management/api-keys).
  {
    provider: "Statsig",
    keyword: "statsig",
    shape: /^secret-[A-Za-z0-9]{32,64}$/,
    prefix: "secret-",
    kind: "server-secret",
    type: "Statsig Server Secret Key",
  },
  {
    provider: "Statsig",
    keyword: "statsig",
    shape: /^client-[A-Za-z0-9]{32,64}$/,
    prefix: "client-",
    kind: "client-sdk",
    type: "Statsig Client SDK Key",
  },
];

// From the end of the provider's name to the start of the whole key: wide
// enough for a config object holding a server key and then a client key
// (`statsig: {serverSideApiKey: "secret-…", clientSideApiKey:`), not for an // pragma: allowlist secret
// import at the top of a bundle. The value must already have the row's exact
// prefixed shape, so the name only has to say whose key it is.
const PROVIDER_CONTEXT_GAP = 120;
const PROVIDER_KEYWORD_MAX = Math.max(
  ...PROVIDER_KEY_PREFIXES.map((row) => row.keyword.length)
);

// What an offline read of a page can and cannot establish about a key.
const EXPOSURE_ONLY: FindingExtra = {
  exposure: "present in content served to the browser",
  validity: "not tested",
  scope: "not tested",
};

// The generic keys a public brand may claim: an API key or an access token
// is the SDK's client credential, a password, secret or auth token is not,
// whatever object it sits in (`sentry:{authToken:"sntrys_…"}` is a server
// token).
const BRAND_CLAIMABLE_KEY_RE =
  /^(?:api[_-]?key|apikey|access[_-]?token|accesstoken)$/i;

/** The quoted body a value ends with, or the value itself. */
function quotedBodyOf(value: string): string {
  return /['"]([^'"]*)['"]$/.exec(value)?.[1] ?? value;
}

// WordPress writes its oEmbed nonce as `<blockquote class="wp-embedded-content"
// data-secret="…">` on every embed: ten alphanumerics, public by design.
const WP_EMBED_NONCE_RE = /^[A-Za-z0-9]{10}$/;

/** The key a generic assignment match opens with: `password` of `password:"…"`. */
function keyOf(match: string): string {
  return /^[A-Za-z_-]+/.exec(match)?.[0] ?? "";
}

/**
 * The complete key a key-anchored generic match started inside.
 *
 * The patterns begin at their credential suffix, so `DROPBOX_ACCESS_TOKEN`
 * arrives as `ACCESS_TOKEN:"..."`. Recover the bounded identifier prefix so
 * a value that is merely the same storage key in kebab case can be compared
 * against the whole key. If the walk exhausts its budget, keep only the
 * matched suffix: a truncated prefix must not suppress a possible secret.
 */
function completeKeyOf(text: string, index: number, match: string): string {
  const suffix = keyOf(match);
  const floor = Math.max(0, index - SECRET_KEY_LOOKBEHIND_SIZE * 2);

  let runStart = index;
  while (
    runStart > floor &&
    KEY_SEGMENT_CHAR_RE.test(text[runStart - 1] ?? "")
  ) {
    runStart--;
  }
  const hyphenJoins =
    QUOTE_CHAR_RE.test(text[runStart - 1] ?? "") ||
    isAttributeNamePosition(text, runStart);
  const keyChar = hyphenJoins ? KEY_SEGMENT_CHAR_RE : IDENT_CHAR_RE;

  let start = index;
  while (start > floor && keyChar.test(text[start - 1] ?? "")) {
    start--;
  }
  if (start === floor && start > 0 && keyChar.test(text[start - 1] ?? "")) {
    return suffix;
  }
  return text.slice(start, index) + suffix;
}

/** Lowercase alphanumerics: what is left of a word once case and separators go.
 *  Digits stay, so `secretkey1` is not `secret_key`. */
function alnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// A URL-encoded label: `%20` is a space however it is spelt, and a body of
// letters and percent signs that ends on one (`…characters%`) is a sentence
// cut off mid-escape. A real password ending in `%` still has digits or
// punctuation in it.
function isPercentEncodedLabel(body: string): boolean {
  return (
    body.includes("%20") || (body.endsWith("%") && /^[A-Za-z%]+$/.test(body))
  );
}

/**
 * Is the character before `index` the last hex digit of a `%XX` escape? A
 * URL-encoded JSON blob writes `%22pk_live_…%22`, and the `2` that precedes
 * the token is punctuation in disguise, not the tail of a longer word.
 */
function endsPercentEscape(text: string, index: number): boolean {
  if (index < 3 || text.charCodeAt(index - 3) !== 37) return false; // %
  return isHexAt(text, index - 2) && isHexAt(text, index - 1);
}

function isHexAt(text: string, index: number): boolean {
  const c = text.charCodeAt(index);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

/**
 * Is a Bearer value the head of a JWT — `eyJ…` up to the first dot, with a
 * second segment following?
 */
function isJwtHead(body: string, text: string, end: number): boolean {
  return (
    /^eyJ[A-Za-z0-9_-]+$/.test(body) &&
    text.charCodeAt(end) === 46 &&
    isWordCharAt(text, end + 1)
  );
}

/**
 * A Bearer value that is only the HEADER segment of a JWT: `eyJhbGciOiJIUzI1NiIs`, base64url of `{"alg":"HS256",` with no payload or
 * signature behind it. It is a documentation or UI fragment (a truncated example), not a credential. Dropped only on proof (#1227):
 * - the WHOLE body decodes to a complete JOSE header: a plain JSON object, with an `alg`, whose keys are all JOSE header names
 *   ({@link JOSE_HEADER_KEYS}); or
 * - the body is short (at most {@link TRUNCATED_HEADER_MAX_CHARS}) and cut mid-JSON, and its decoded prefix still opens with `{"alg"`,
 *   `{"typ"`, `{"kid"` or `{"cty"`.
 * Any other `eyJ…` value (a JSON object that merely opens with `typ` or `alg` and goes on to carry a `sub`, a `token`, padding) is an
 * opaque bearer token and still reports. A value that continues as a token (see {@link continuesAsToken}) is not a header on its own.
 */
const JWT_HEADER_START_RE = /^\{\s*"(?:alg|typ|kid|cty)"/;
const TRUNCATED_HEADER_MAX_CHARS = 64;
const MAX_HEADER_BODY_CHARS = 2_048;
const JOSE_HEADER_KEYS = new Set([
  "alg",
  "typ",
  "kid",
  "cty",
  "enc",
  "zip",
  "x5t",
  "x5t#S256",
  "x5u",
  "x5c",
  "jku",
  "jwk",
  "crit",
]);

/**
 * Whether the text after a Bearer value goes on as part of a token: a `.` followed by a token character, a `%` or `\`
 * (an escaped separator: `%2E`, `\x2e`), or, after whitespace or a `,`, a `.` or another `eyJ`. The end of the text, a quote, a
 * bracket and other punctuation do not continue one.
 */
function continuesAsToken(text: string, end: number): boolean {
  const c = text.charAt(end);
  if (c === "") return false;
  if (c === ".") return /[A-Za-z0-9_-]/.test(text.charAt(end + 1));
  if (c === "%" || c === "\\") return true;
  if (c === "," || /\s/.test(c)) {
    const after = /^[\s,]*/.exec(text.slice(end, end + 64))?.[0].length ?? 0;
    const next = text.slice(end + after, end + after + 3);
    return next.startsWith(".") || next === "eyJ";
  }
  return false;
}

function isHeaderOnlyJwt(body: string, text: string, end: number): boolean {
  // a complete header is a few hundred characters: a longer value is not one, and is not parsed
  if (body.length > MAX_HEADER_BODY_CHARS || !/^eyJ[A-Za-z0-9_-]+$/.test(body))
    return false;
  if (continuesAsToken(text, end)) return false;
  const decoded = Buffer.from(body, "base64url").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    // cut mid-JSON: a header only when it is short and its prefix still opens like one
    return (
      body.length <= TRUNCATED_HEADER_MAX_CHARS &&
      JWT_HEADER_START_RE.test(decoded)
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  const keys = Object.keys(parsed);
  return keys.includes("alg") && keys.every((key) => JOSE_HEADER_KEYS.has(key));
}

/**
 * The FAST patterns the keyword prefilter selects for this content, by name.
 * Exported for the corpus meta-test, which asserts that every positive's
 * input selects the pattern it expects and a corrupted keyword deselects it.
 * Content too short to index selects everything, exactly as scanContent does.
 */
export function selectFastPatterns(content: string): string[] {
  const index = buildGramIndex(content);
  return FAST_PATTERNS.filter((p) => fastPatternMayFire(p, index)).map(
    (p) => p.name
  );
}

// ── How many findings one page keeps (#1554) ──────────────────────────────────
//
// Nothing used to bound this, and a page full of distinct secret-shaped values (a generated fixture, a data dump) kept
// hundreds of MB, made a rule result of tens of MB and, past about 638K, threw at the merge. What already bounded the
// result downstream: the report clamps every check to `REPORT_LIMITS.maxItemsPerCheck` items (the rest become
// `details.additional`) and the publish cap shrinks a report to 1 MiB, so a page's findings past that count were never
// shown anywhere. The page cap is that same number, so the three caps agree: whatever the page keeps can be listed.
//
// A page over the cap keeps its most serious findings, not its first: critical, then high, then medium, then public and
// informational ones, each tier in scan order. What was left out is COUNTED and travels with the page (`omitted`), so
// the rule can say so and the page does not read as clean.

/** Most findings one page (or one external script) keeps. */
export const PAGE_FINDINGS_CAP = REPORT_LIMITS.maxItemsPerCheck;

/** 0 critical (a server-only secret in a browser-served script), 1 high, 2 medium, 3 public by design or informational. */
function severityTier(s: LeakedSecret): number {
  if (s.publicByDesign || s.confidence === "info") return 3;
  if (isShippedServerSecret(s)) return 0;
  return s.confidence === "high" ? 1 : 2;
}

/** Collects findings (see above). */
export interface FindingSink {
  add(finding: LeakedSecret): void;
  /** Counts findings that were left out elsewhere (a nested scan's). */
  omit(count: number, serious?: boolean): void;
  /** Distinct values seen and not kept. */
  omitted(): number;
  /** True when anything left out was more serious than public or informational (tier 0 to 2). */
  omittedSerious(): boolean;
  /** What was kept, in scan order. */
  result(): LeakedSecret[];
  /** The JWT decoy retries this sink's scan may still spend (see {@link JWT_RETRY_CAP}); `reported` once the cut was counted. */
  jwtRetries: { left: number; reported: boolean };
  /**
   * Which part of the page the next findings come from. Scan order within the page is canonical: a lower phase comes before a
   * higher one in the result and in the rule's dedupe ("the last of equals wins"), whatever order the phases were scanned in.
   */
  phase(phase: number): void;
  /** Entries the sink holds in all its structures (for tests: bounded whatever is added). */
  retained(): number;
  /** A sink of the same kind for a nested scan (a decoded blob). */
  child(): FindingSink;
}

/**
 * The most decoy-retry steps (#1530) one page scan spends. Each step is one sticky match attempt, so the cost is bounded; a run of
 * short `eyJ` segments would otherwise be walked end to end. Past it the match is kept as found and the page is counted as having
 * findings left out, not passed in silence.
 */
const JWT_RETRY_CAP = 1000;

/** Every finding, in scan order, no cap and no dedupe: the contract of `scanContent` and `scanPageForSecrets`. */
export function createListSink(): FindingSink {
  const phases = new Map<number, LeakedSecret[]>();
  let current: LeakedSecret[] = [];
  phases.set(0, current);
  return {
    add: (finding) => void current.push(finding),
    omit: () => undefined,
    jwtRetries: { left: JWT_RETRY_CAP, reported: false },
    omittedSerious: () => false,
    phase(phase) {
      let list = phases.get(phase);
      if (!list) phases.set(phase, (list = []));
      current = list;
    },
    omitted: () => 0,
    result: () =>
      [...phases.entries()]
        .sort((x, y) => x[0] - y[0])
        .flatMap(([, list]) => list),
    retained: () =>
      [...phases.values()].reduce((n, list) => n + list.length, 0),
    child: createListSink,
  };
}

/** What the site rule's dedupe by value keeps: public by design (2) over a shipped server secret (1) over the rest (0); the last of equals. */
function precedence(s: LeakedSecret): number {
  if (s.publicByDesign) return 2;
  return isShippedServerSecret(s) ? 1 : 0;
}

/** A generic assignment: the site rule drops one whose quoted body is a public record's value. */
const isGeneric = (s: LeakedSecret): boolean =>
  !s.publicByDesign && s.type.startsWith("Generic ");

/** A 53-bit hash of a string (two FNV-1a passes): distinct values are counted and remembered without holding the strings. */
function hash53(text: string): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) + i;
  }
  return (h1 >>> 0) * 0x200000 + ((h2 >>> 0) & 0x1fffff);
}

interface Kept {
  finding: LeakedSecret;
  /** Canonical scan position of the first copy (phase, then order within it). */
  seq: number;
  /** Canonical scan position of the copy kept, the latest of equals. */
  last: number;
  tier: number;
  alive: boolean;
  /** Set for a generic assignment: the hash of its quoted body (see `genericsByBody`). */
  body?: number;
}

/**
 * The sink's own bookkeeping is bounded too, not only what it keeps (#1554 probes): the hash set of values left out holds at
 * most cap times this many entries (past it, further left-out findings are counted one each, which can count a value twice),
 * so a page of a million distinct values cannot grow it without limit; the same bound holds the set of public bodies.
 */
const BOOKKEEPING_CAP_FACTOR = 8;

/**
 * The bounded sink of one page or script. It applies the site rule's own dedupe by value (`precedence`) BEFORE counting
 * toward the cap, so copies of one value, which the rule would merge anyway, neither fill the cap nor are counted as
 * omitted: the cap and the omitted count are in distinct values. A generic assignment whose quoted body is a public
 * record's value is dropped, as the rule drops it, so the cap cannot keep the generic one and evict the public one. Over the
 * cap, a finding of a more serious tier replaces the most recent one of the least serious tier; everything not kept is
 * counted once, by value (up to the bookkeeping bound above). Memory is bounded in what it keeps AND in what it remembers:
 * a replaced or evicted entry leaves no residue.
 */
export function createFindingSink(
  cap: number = PAGE_FINDINGS_CAP
): FindingSink {
  const kept = new Map<string, Kept>();
  const tiers: Kept[][] = [[], [], [], []];
  const alive = [0, 0, 0, 0];
  const omittedValues = new Set<number>();
  const publicBodies = new Set<number>();
  const genericsByBody = new Map<number, Set<Kept>>();
  const bookkeepingCap = Math.max(16, cap * BOOKKEEPING_CAP_FACTOR);
  let overflowOmitted = 0;
  let seriousOmitted = false;
  let external = 0;
  let seq = 0;
  let base = 0;

  /** Drops dead entries from a tier's list once they outnumber the live ones plus a margin, so a list never grows with churn. */
  const compact = (tier: number): void => {
    const list = tiers[tier]!;
    if (list.length > alive[tier]! * 2 + 64)
      tiers[tier] = list.filter((entry) => entry.alive);
  };
  const kill = (entry: Kept): void => {
    entry.alive = false;
    alive[entry.tier]!--;
    kept.delete(entry.finding.value);
    if (entry.body !== undefined) {
      const set = genericsByBody.get(entry.body);
      if (set) {
        set.delete(entry);
        if (set.size === 0) genericsByBody.delete(entry.body);
      }
    }
    compact(entry.tier);
  };
  const insert = (finding: LeakedSecret, order: number, last: number): void => {
    const tier = severityTier(finding);
    const entry: Kept = { finding, seq: order, last, tier, alive: true };
    tiers[tier]!.push(entry);
    alive[tier]!++;
    kept.set(finding.value, entry);
    if (isGeneric(finding)) {
      const body = hash53(quotedBodyOf(finding.value));
      entry.body = body;
      const set = genericsByBody.get(body);
      if (set) set.add(entry);
      else genericsByBody.set(body, new Set([entry]));
    }
  };
  const remember = (key: number, tier: number): void => {
    if (tier < 3) seriousOmitted = true;
    if (omittedValues.size < bookkeepingCap) omittedValues.add(key);
    else if (!omittedValues.has(key)) overflowOmitted++;
  };

  return {
    add(finding) {
      if (finding.publicByDesign) {
        const body = hash53(quotedBodyOf(finding.value));
        if (publicBodies.size < bookkeepingCap) publicBodies.add(body);
        for (const generic of [...(genericsByBody.get(body) ?? [])])
          if (generic.alive) kill(generic);
      } else if (
        isGeneric(finding) &&
        publicBodies.has(hash53(quotedBodyOf(finding.value)))
      ) {
        return; // the rule drops it: a public client key it re-reads
      }
      const at = base + seq++;
      const prior = kept.get(finding.value);
      if (prior) {
        // the rule's dedupe by value: the higher precedence wins, the last of equals in canonical scan order; it keeps
        // the first place (the earliest copy's)
        const rank = precedence(finding) - precedence(prior.finding);
        if (rank > 0 || (rank === 0 && at > prior.last)) {
          kill(prior);
          insert(finding, Math.min(prior.seq, at), Math.max(prior.last, at));
        } else if (at < prior.seq) {
          prior.seq = at;
        }
        return;
      }
      const key = hash53(finding.value);
      if (kept.size < cap) {
        omittedValues.delete(key);
        insert(finding, at, at);
        return;
      }
      const tier = severityTier(finding);
      let worst = 3;
      while (worst > 0 && alive[worst] === 0) worst--;
      if (tier < worst) {
        const list = tiers[worst]!;
        let victim = list.pop();
        while (victim && !victim.alive) victim = list.pop(); // the most recent kept one of the least serious tier makes room
        if (victim) {
          remember(hash53(victim.finding.value), victim.tier);
          kill(victim);
        }
        omittedValues.delete(key);
        insert(finding, at, at);
      } else {
        remember(key, tier);
      }
    },
    omit(count, serious = true) {
      external += count;
      if (serious && count > 0) seriousOmitted = true;
    },
    omittedSerious: () => seriousOmitted,
    jwtRetries: { left: JWT_RETRY_CAP, reported: false },
    phase(phase) {
      base = phase * 2 ** 32;
      seq = 0;
    },
    omitted: () => omittedValues.size + overflowOmitted + external,
    result() {
      const all: Kept[] = [];
      for (const list of tiers)
        for (const entry of list) if (entry.alive) all.push(entry);
      all.sort((a, b) => a.seq - b.seq);
      return all.map((entry) => entry.finding);
    },
    retained: () =>
      kept.size +
      tiers.reduce((n, l) => n + l.length, 0) +
      omittedValues.size +
      publicBodies.size +
      [...genericsByBody.values()].reduce((n, set) => n + set.size, 0),
    child: () => createFindingSink(cap),
  };
}

// ── How many findings one site keeps (#1568) ──────────────────────────────────
//
// The per-page cap alone still lets N pages of PAGE_FINDINGS_CAP each keep N times that: the records are held for the whole
// crawl. The site has a cap of its own on DISTINCT values kept. Tiers share it unevenly so a flood of low findings cannot use
// the room a serious one needs: public and informational findings may fill 40% of it, medium 60%, high 80%, critical all of it.
// The decision for a page depends on the pages before it, so it is made on the way into the crawl's list, never on the page's
// own (cached) record. A value already kept elsewhere is a copy the rule merges anyway: it costs no room of this cap, but a
// second cap bounds the copies themselves, and a copy of a higher precedence is always kept (the rule's merge needs it).

/** Distinct findings the crawl keeps in all (the rule lists at most {@link PAGE_FINDINGS_CAP} of a check anyway). */
export const SITE_FINDINGS_CAP = 10_000;

/** The share of the site cap each tier may fill, by tier (see `severityTier`). */
const SITE_TIER_SHARE = [1, 0.8, 0.6, 0.4] as const;

export interface SiteFindingBudget {
  /**
   * The page's findings the site still has room for, in their order, how many were left out (at least that many: a value
   * left out on several pages counts on each), and whether any of them was more serious than public or informational.
   */
  admit(secrets: readonly LeakedSecret[]): {
    secrets: LeakedSecret[];
    omitted: number;
    omittedSerious: boolean;
  };
  /** Distinct values kept so far. */
  kept(): number;
}

/**
 * One budget per crawl. Per value it remembers the best precedence AND the most serious tier admitted so far: the rule's
 * "last of equals wins" can make a later copy the one that is reported, so a copy that is more serious than any kept before
 * it is always admitted, whatever the copy allowance. A copy dropped for the allowance is counted as omitted.
 */
export function createSiteFindingBudget(
  cap: number = SITE_FINDINGS_CAP
): SiteFindingBudget {
  const seen = new Map<number, { rank: number; tier: number }>();
  let copies = 0;
  return {
    kept: () => seen.size,
    admit(secrets) {
      const out: LeakedSecret[] = [];
      let omitted = 0;
      let omittedSerious = false;
      for (const finding of secrets) {
        const key = hash53(finding.value);
        const tier = severityTier(finding);
        const rank = precedence(finding);
        const prior = seen.get(key);
        if (prior !== undefined) {
          if (rank > prior.rank || tier < prior.tier) {
            seen.set(key, {
              rank: Math.max(rank, prior.rank),
              tier: Math.min(tier, prior.tier),
            });
            out.push(finding);
          } else if (copies < cap) {
            copies++;
            out.push(finding);
          } else {
            omitted++; // a copy of a kept value at no higher rank or tier: counted, never dropped in silence, and never serious
          }
          continue;
        }
        if (seen.size < Math.floor(cap * SITE_TIER_SHARE[tier]!)) {
          seen.set(key, { rank, tier });
          out.push(finding);
        } else {
          omitted++;
          if (tier < 3) omittedSerious = true;
        }
      }
      return { secrets: out, omitted, omittedSerious };
    },
  };
}

/**
 * How much text after a value a decoder may read. A signature sits PAST the
 * key it signs, so a presigned S3 URL cannot be recognised from the
 * look-behind alone; one kilobyte covers the query string of one.
 */
const FORWARD_REACH = 1024;

/** Where a body of text came from, for the offsets and the context a scan reports with. */
interface ScanSource {
  /** Added to every reported offset; a finding that lands before 0 belongs to someone else and is dropped. */
  offsetBase?: number;
  scriptIndex?: number;
  /**
   * Whether the PAGE the body sits on loads from the Shopify CDN, when the body is not the whole page: an inline
   * script, or the page's HTML with its scanned scripts blanked (#1864). Read instead of the body's own answer for
   * the page's HTML, and in addition to it for a script, so a token in a script is judged by the page around it.
   */
  pageLoadsShopify?: { read: () => boolean; replacesOwn: boolean };
  /**
   * The body is the page's HTML with its long blanked script bodies shortened to {@link BLANK_KEEP} spaces: how much
   * each one lost, in page order, so offsets are reported as they are in the fully blanked page.
   */
  blankCut?: readonly number[];
  /** The body is this framework's server-side data payload (#362): every finding in it says so. */
  framework?: FrameworkPayload;
}

/**
 * How many spaces a blanked script body keeps in the page's HTML pass. Every look the scan takes around a position is
 * shorter than this (the longest is the seed-table walk, 8,000 characters forward), so a body of spaces longer than it
 * reads exactly like one this long: the rest is cut, and the pass reads ~360 KB of a 1.1 MB page instead of all of it.
 */
const BLANK_KEEP = 16_384;

/** The findings of one body: at most {@link PAGE_FINDINGS_CAP} distinct values, and how many more there were. */
export function scanContentBounded(
  content: string,
  location: ReportedLocation,
  sourceUrl?: string,
  depth = 0,
  source: ScanSource = {}
): { secrets: LeakedSecret[]; omitted: number; omittedSerious: boolean } {
  const sink = createFindingSink();
  scanInto(sink, content, location, sourceUrl, depth, source);
  return {
    secrets: sink.result(),
    omitted: sink.omitted(),
    omittedSerious: sink.omittedSerious(),
  };
}

/**
 * The findings of several texts read as one body's (#362): a source map's original sources, which share ONE cap of
 * {@link PAGE_FINDINGS_CAP} distinct values like a page's scripts do. Offsets are into each text.
 */
export function scanTextsBounded(
  texts: readonly string[],
  location: ReportedLocation,
  sourceUrl?: string
): { secrets: LeakedSecret[]; omitted: number; omittedSerious: boolean } {
  const sink = createFindingSink();
  for (const text of texts) scanInto(sink, text, location, sourceUrl, 0, {});
  return {
    secrets: sink.result(),
    omitted: sink.omitted(),
    omittedSerious: sink.omittedSerious(),
  };
}

/** Every finding of one body, in scan order: no cap, no dedupe. The site rule reads {@link scanContentBounded}. */
export function scanContent(
  content: string,
  location: ReportedLocation,
  sourceUrl?: string,
  depth = 0,
  source: ScanSource = {}
): LeakedSecret[] {
  const sink = createListSink();
  scanInto(sink, content, location, sourceUrl, depth, source);
  return sink.result();
}

/**
 * Longest value a finding keeps (#1592). The caps count findings, not bytes,
 * so one generic assignment with a 1 MB value was kept whole, and 100 such
 * pages held about 100 MB of value text. 2,048 keeps the longest ordinary
 * structured secret whole (a 2048-bit PEM private key is about 1,675
 * characters; fixed-format tokens and connection strings are far shorter)
 * while bounding a site at the site cap to about 20M characters of value
 * text. Classification still sees the full value: only the stored record is
 * cut, and `length` keeps the full length, so a cut finding is still
 * reported, never skipped. The cut is surrogate-safe via clampItemString.
 */
export const STORED_VALUE_MAX_LENGTH = 2048;

function scanInto(
  found: FindingSink,
  content: string,
  location: ReportedLocation,
  sourceUrl: string | undefined,
  depth: number,
  source: ScanSource
): void {
  // Entities in HTML, `\u`/`\x` escapes in script text (#360): every pattern
  // below reads the decoded form, once. See secrets/decode.ts.
  content = decodeForLocation(content, location);
  // Offsets into the shortened page read as offsets into the fully blanked one (#1864).
  const toBlanked = source.blankCut
    ? blankedOffsets(content, source.blankCut, BLANK_KEEP)
    : null;
  const offsetIn = (at: number): number =>
    (toBlanked ? toBlanked(at) : at) + (source.offsetBase ?? 0);

  // What the value's own structure says (#361): a checksum that fails drops
  // the finding, a decoded claim moves it between tiers, and whatever else
  // decoded rides along as `extra` for the report. See secrets/confidence.ts.
  const build = (
    name: string,
    value: string,
    confidence: Confidence,
    publicByDesign: boolean,
    offset: number,
    length: number,
    before: () => string,
    after: () => string,
    known?: FindingExtra
  ): LeakedSecret | null => {
    const refined = refineFinding(name, value, Date.now(), { before, after });
    if (refined?.drop) return null;
    const adjustedOffset = offsetIn(offset);
    // The inline pass prepends a synthetic opening tag to preserve provider
    // context. Findings inside that tag belong to the HTML pass, not to the
    // script text whose offset this record describes.
    if (adjustedOffset < 0) return null;
    const extra =
      known || refined?.extra ? { ...known, ...refined?.extra } : undefined;
    const truncated = value.length > STORED_VALUE_MAX_LENGTH;
    const context = evidenceContext(content, offset, length, value);
    return {
      type: refined?.type ?? name,
      value: truncated
        ? clampItemString(value, STORED_VALUE_MAX_LENGTH)
        : value,
      ...(truncated ? { truncated: true } : {}),
      confidence: refined?.confidence ?? confidence,
      publicByDesign: refined?.publicByDesign ?? publicByDesign,
      location,
      length,
      offset: adjustedOffset,
      ...(source.scriptIndex !== undefined
        ? { scriptIndex: source.scriptIndex }
        : {}),
      sourceUrl,
      ...(source.framework ? { framework: source.framework } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(extra ? { extra } : {}),
    };
  };

  // A later (more generic) pattern re-matching a value an earlier (more
  // specific) pattern already classified — e.g. apiKey:"AIza…" catching the
  // AIza key the public-by-design tier reported — is a duplicate, not a new
  // finding. Specific patterns run first, so first classification wins.
  const seenValues = createSeenValues(content.length);

  // One pass over the content that lets both passes below skip every pattern
  // whose mandatory literals it does not contain (#1864). Null on short content,
  // where the index would cost more than the scans it saves, and then nothing is
  // skipped and behaviour is exactly as it was.
  const gramIndex = buildGramIndex(content);

  // Vendor identifiers in a script or link URL (#574): a match lying wholly
  // inside one is the vendor's public client identifier and is skipped. A host
  // the index proves absent is not searched for (#1864).
  const publicSpans = publicUrlIdentifierSpans(content, gramIndex);
  const insidePublicIdentifier = (start: number, length: number): boolean =>
    publicSpans.some(([from, to]) => start >= from && start + length <= to);

  // The lowercase copy locates the context tier's brand words, and the
  // public-tier check the generic assignments make. Built on first use.
  //
  // The index folds ASCII case, which over-approximates `content` but NOT
  // `content.toLowerCase()` — the keyword is looked for in the latter. Two
  // characters lowercase into ASCII the content does not itself contain, and on
  // a page carrying either of them the keyword tier runs unfiltered rather than
  // risk skipping a keyword the lowercased copy really has.
  let contentLower: string | null = null;
  const keywordFilter =
    gramIndex && !gramIndex.lowercaseAddsAscii ? gramIndex : null;

  // The keywords of the public-by-design context patterns, looked for within
  // the keyword gap before a generic assignment's value.
  //
  // The window is cut from the ORIGINAL content and lowercased on its own:
  // lowercasing the whole body can change its length (U+0130 becomes two
  // code units), and an index into one is not an index into the other.
  //
  // `<script id="shopify-features">{"accessToken":"…"}`: a block whose open
  // tag names a public keyword is that keyword's look-behind for its whole
  // body. The blocks are indexed once per body, on the first generic match.
  let scriptBlocks: Array<{ from: number; to: number; tag: string }> | null =
    null;
  const publicScriptBlocks = () => {
    if (scriptBlocks) return scriptBlocks;
    scriptBlocks = [];
    if (content.includes("<script") || content.includes("<SCRIPT")) {
      // Every open tag ends at a `>`, so none starts past the last one. Each
      // `<script` there would re-read the rest of the content looking for a
      // `>` that is not coming: thousands of them were quadratic.
      const head = content.slice(0, content.lastIndexOf(">") + 1);
      SCRIPT_OPEN_RE.lastIndex = 0;
      let open: RegExpExecArray | null;
      while ((open = SCRIPT_OPEN_RE.exec(head)) !== null) {
        // The same rule the context pass applies: the keyword has to sit in
        // a NAMING attribute (`id="shopify-features"`), not in a `src`.
        const tagText = open[0];
        const named = CLAIMING_CONTEXT.filter((p) =>
          tagNamesKeyword(tagText, p.keyword)
        ).map((p) => p.keyword);
        if (named.length === 0) continue;
        const from = open.index + tagText.length;
        scriptBlocks.push({
          from,
          to: scriptBlockEnd(content, from),
          tag: named.join(" "),
        });
      }
    }
    return scriptBlocks;
  };

  const publicContextClaims = (
    valueAt: number,
    body: string,
    key: string
  ): boolean => {
    if (CLAIMING_CONTEXT.length === 0) return false;
    if (
      keywordFilter &&
      !CLAIMING_CONTEXT.some((p) => mayContain(keywordFilter, p.keyword))
    )
      return false;
    const from = Math.max(
      0,
      valueAt - CONTEXT_KEYWORD_GAP - CLAIMING_KEYWORD_MAX
    );
    const window = content.slice(from, valueAt).toLowerCase();
    return CLAIMING_CONTEXT.some(({ keyword, whole, keyName }) => {
      if (!whole.test(body)) return false;
      // `algoliaAdminKey` is not the search-only key's, whatever its shape.
      if (keyName && !keyName(key)) return false;
      const at = window.lastIndexOf(keyword);
      if (
        at !== -1 &&
        window.length - (at + keyword.length) <= CONTEXT_KEYWORD_GAP
      )
        return true;
      return publicScriptBlocks().some(
        (b) => b.from <= valueAt && valueAt < b.to && b.tag.includes(keyword)
      );
    });
  };

  // The public brand a generic assignment sits under, if any: as the parent
  // key or anything else within the look-behind of the KEY, or as the name
  // of the enclosing tag.
  const publicBrandNear = (keyAt: number): string | undefined => {
    const from = Math.max(0, keyAt - CONTEXT_KEYWORD_GAP - PUBLIC_BRAND_MAX);
    const window = content.slice(from, keyAt).toLowerCase();
    let tagName: string | undefined;
    const tag = tagBoundsAround(content, keyAt);
    if (tag)
      tagName = /^<([A-Za-z][\w-]*)/
        .exec(content.slice(tag.start, Math.min(tag.end, tag.start + 80)))?.[1]
        ?.toLowerCase();
    for (const [brand, type] of PUBLIC_BRANDS) {
      const at = window.lastIndexOf(brand);
      if (
        at !== -1 &&
        window.length - (at + brand.length) <= CONTEXT_KEYWORD_GAP
      )
        return type;
      if (tagName?.includes(brand)) return type;
    }
    return undefined;
  };

  // The provider-prefix row a generic assignment's value belongs to, and
  // whether the provider is named in front of its key.
  const providerKeyOf = (matchAt: number, body: string) => {
    const rows = PROVIDER_KEY_PREFIXES.filter((row) => row.shape.test(body));
    if (rows.length === 0) return undefined;
    // The match can open part-way through its key (`ApiKey` of
    // `clientSideApiKey`); the distance is measured from the key's start.
    let keyAt = matchAt;
    while (
      keyAt > 0 &&
      matchAt - keyAt < 64 &&
      IDENT_CHAR_RE.test(content[keyAt - 1] ?? "")
    )
      keyAt--;
    // The name may also sit inside the key itself (`STATSIG_SERVER_SECRET`).
    const from = Math.max(
      0,
      keyAt - PROVIDER_CONTEXT_GAP - PROVIDER_KEYWORD_MAX
    );
    const window = content.slice(from, matchAt).toLowerCase();
    for (const row of rows) {
      const at = window.lastIndexOf(row.keyword);
      if (
        at !== -1 &&
        from + at + row.keyword.length >= keyAt - PROVIDER_CONTEXT_GAP
      ) {
        return { row, named: true };
      }
    }
    return { row: rows[0]!, named: false };
  };

  const platformSource = platformSourceOf(location, sourceUrl);
  const seedBudget = { left: SEED_SCAN_BUDGET };

  let shopifyPage: boolean | null = null;
  const page = source.pageLoadsShopify;
  const isShopifyPage = () =>
    (shopifyPage ??= page?.replacesOwn
      ? page.read()
      : pageLoadsFrom(content, SHOPIFY_CDN_HOST) || (page?.read() ?? false));

  // Pass 1: FAST patterns, gated twice — by the literals proven from each
  // regex (#1864) and by the keywords each pattern declares (#357). Both
  // gates read the gram index, so a body the index rules out costs nothing.
  for (const entry of PREFILTERED_FAST_PATTERNS) {
    const {
      name,
      pattern,
      confidence,
      publicByDesign,
      keyAnchored,
      generic,
      valuePosition,
      minTailEntropy,
      sharedPrefix,
      accept,
      literals,
    } = entry;
    if (!mayMatch(gramIndex, literals)) continue;
    if (!fastPatternMayFire(entry, gramIndex)) continue;

    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    // The JWT pattern takes the first three dotted `eyJ` segments, so decoy segments before a real token are matched with its
    // header and payload and the real token is lost (#1530). A sticky copy tries each next segment start in turn.
    const jwtRetry =
      name === "JSON Web Token" ? new RegExp(pattern.source, "y") : undefined;
    // The start of the last segment a failed chain reached: a later match that starts at or before it was already tried.
    let jwtTriedTo = -1;
    while ((match = pattern.exec(content)) !== null) {
      if (
        jwtRetry &&
        match.index > jwtTriedTo &&
        found.jwtRetries.left > 0 &&
        jwtMatchIsSuspect(match[0])
      ) {
        let current: RegExpExecArray = match;
        let real: RegExpExecArray | undefined;
        for (;;) {
          if (found.jwtRetries.left <= 0) {
            // out of retries: the match stays as found, and the page says that something on it was not read through
            if (!found.jwtRetries.reported) {
              found.jwtRetries.reported = true;
              found.omit(1);
            }
            break;
          }
          found.jwtRetries.left--;
          jwtRetry.lastIndex = current.index + current[0].indexOf(".") + 1;
          const next = jwtRetry.exec(content);
          // the real token starts inside the match it hides in; one that starts past it is another token
          if (!next || next.index >= current.index + current[0].length) break;
          current = next;
          if (!jwtMatchIsSuspect(next[0])) {
            real = next;
            break;
          }
        }
        if (real) {
          match = real;
          pattern.lastIndex = real.index + real[0].length;
        } else jwtTriedTo = current.index;
      }
      let value = match[0];
      let seedVerdict: SeedVerdict;

      // A prefix is a prefix only at the start of a token. `re_` inside
      // `_Care_Dry…`, `[0-9]{8,10}:` on the tail of a UUID and `fooghp_…`
      // were every high-tier finding on 776 real sites (#357). The generic
      // assignments are exempt: they anchor on a credential word that is
      // allowed to sit part-way through its key (`stripeApiKey`), and
      // startsInsideDigestKey reads that key instead.
      if (
        !keyAnchored &&
        isWordCharAt(content, match.index - 1) &&
        !endsPercentEscape(content, match.index)
      ) {
        continue;
      }

      // A shape that is only a credential next to something specific: a PEM
      // header with its key, a bearer that is not a payload's interior.
      if (accept && !accept(value, content, match.index)) continue;

      // …and a provider's format ends where the token does. A match that
      // stops short of the end of its token is not reported as that
      // provider's token, but it may still be a credential: fixed-length
      // formats grow, a key gets a `_PROD` suffix, and text with its markup
      // stripped runs a token into the next word. So the whole token stays
      // reviewable at medium with the provider left unknown, under the
      // shared prefix when the pattern has one, otherwise under the pattern
      // it resembles. Only the provider's own structure can rule it out: a
      // matched part that fails its decoder (a GitHub checksum) is dropped.
      let unattributed: string | null | undefined;
      if (!keyAnchored && !generic) {
        const matchEnd = match.index + value.length;
        // A match that ends on its own delimiter (Azure's `;`) is whole.
        const tokenEnd = isWordCharAt(content, matchEnd - 1)
          ? continuedTokenEnd(content, matchEnd)
          : matchEnd;
        if (tokenEnd !== matchEnd) {
          if (refineFinding(name, value)?.drop) continue;
          unattributed =
            sharedPrefix !== undefined && value.startsWith(sharedPrefix)
              ? sharedPrefix
              : null;
          value = content.slice(match.index, tokenEnd);
          pattern.lastIndex = tokenEnd;
        }
      }

      // A prefixed token that is followed by an image or font extension is
      // a hashed asset's file name, not a credential.
      // Only for the low-specificity prefixes that hashed asset names collide
      // with: a distinctive provider token (`sk-ant-`, `AIza`, `SG.`, a GitHub
      // token) followed by `.css` is a token followed by text.
      if (
        ASSET_NAMED_PATTERNS.has(name) &&
        endsInAssetExtension(content, match.index + value.length, match.index)
      ) {
        continue;
      }

      // A generic assignment can start part-way through a longer key, so the
      // words to its left decide too: `cache-api-key` is a cache key.
      if (keyAnchored && startsInsideDigestKey(content, match.index)) {
        continue;
      }

      // …and a credential word inside a ternary's branch is not a key at all.
      if (keyAnchored && startsInTernaryBranch(content, match.index)) {
        continue;
      }

      // …nor is the text of a label whose closing quote the match took for
      // the opening quote of a value (`children:"Password:"}),(0,r.jsx)(`).
      // The span it took may hold a real assignment, so the scan resumes
      // right after the label's key rather than after the whole span.
      if (keyAnchored && keyInsideStringLiteral(content, match.index, value)) {
        pattern.lastIndex = match.index + keyOf(value).length;
        continue;
      }

      // A value whose only distinctive mark is a separator has to have a
      // random tail: a decoder table is `<digits>:<digits>`.
      if (
        minTailEntropy !== undefined &&
        shannonEntropy(separatorTailOf(value)) < minTailEntropy
      ) {
        continue;
      }

      // A shape that is also a word counts only where a value goes.
      if (valuePosition && !isInValuePosition(content, value, match.index)) {
        continue;
      }

      // Assignments in Shopify's platform bundles, and the App Store's own
      // `api-key` attribute, are Shopify's public code and public keys.
      if (
        generic &&
        ((platformSource === "bundle" &&
          name === "Generic API Key Assignment") ||
          (platformSource === "app-store" &&
            APP_STORE_KEY_RE.test(completeKeyOf(content, match.index, value))))
      ) {
        continue;
      }

      // A bare shape the key gave meaning to has to look like a token:
      // `password: "Password confirmation"` is a label (#357). The // pragma: allowlist secret
      // placeholder list reads the same body, since the key is part of the
      // match and `apiKey:"YOUR_API_KEY…"` is a placeholder however keyed. // pragma: allowlist secret
      const body = generic ? genericValueOf(value) : value;
      if (generic) {
        const completeKey = completeKeyOf(content, match.index, value);
        // `searchKey` and `masterKey` are Meilisearch's names. Outside a
        // Meilisearch config the same words label unrelated catalogue data;
        // provider-prefixed `*_api_key` names still use the generic detector.
        if (
          name === "Generic API Key Assignment" &&
          isBareSearchScopeKey(completeKey) &&
          !hasMeilisearchContext(content, match.index, completeKey)
        ) {
          continue;
        }
        if (
          /\s/.test(body) ||
          shannonEntropy(body) < genericEntropyFloor(body.length)
        )
          continue;
        // `password:"Password"`, `passwd:"passwd"`: an i18n label whose value // pragma: allowlist secret
        // is its own key. And a URL-encoded sentence (`…ed%`, `%20`) is a
        // label too, however the encoding scattered its letters. // pragma: allowlist secret
        if (alnum(body) === alnum(completeKey)) continue;
        if (isPercentEncodedLabel(body)) continue;
        // A label in a script that does not space its words, a route path or
        // a catalogue key cannot be a credential whatever the key says.
        if (isNotACredentialValue(body, name)) continue;
        // A password in sample data the page renders (a seed table, a puzzle
        // level, a generator's output) is data, not configuration.
        // A sample is never dropped on that evidence alone: the structure cannot prove the value is not a working login, so
        // the match is kept and labelled (see the demo-login branch below).
        if (name === "Generic Secret Assignment") {
          seedVerdict = seedDataVerdict(
            content,
            match.index,
            completeKeyOf(content, match.index, value),
            seedBudget
          );
        }
        // WordPress's oEmbed nonce: `data-secret` on a wp-embedded-content
        // element, or a ten-character alphanumeric under `data-secret`.
        if (
          name === "Generic Secret Assignment" &&
          content
            .slice(Math.max(0, match.index - 5), match.index)
            .toLowerCase() === "data-" &&
          (WP_EMBED_NONCE_RE.test(body) ||
            (tagBoundsAround(content, match.index) !== undefined &&
              /\bwp-embedded-content\b/.test(
                content.slice(
                  tagBoundsAround(content, match.index)!.start,
                  match.index
                )
              )))
        ) {
          continue;
        }
        // A value the public tier claims under a brand keyword in front of
        // it (`storefrontAccessToken:"…"` after `shopify`) is that tier's:
        // the context pass reports it as informational, not as a leak.
        if (
          publicContextClaims(
            match.index + value.lastIndexOf(body),
            body,
            completeKeyOf(content, match.index, value)
          )
        )
          continue;
        // A Bearer whose value is a JWT that a JWT pattern already claimed
        // belongs to that pattern: the three-segment token is one credential,
        // and the Bearer match stops at its first dot. A JWT no pattern
        // recognises still reports here as an opaque bearer token.
        // A header-only JWT (no dot, no payload) is a truncated example, not a credential.
        if (
          name === "Bearer Token" &&
          isHeaderOnlyJwt(body, content, match.index + value.length)
        )
          continue;
        if (
          name === "Bearer Token" &&
          isJwtHead(body, content, match.index + value.length)
        ) {
          // The JWT pattern's value is head + "." + payload + "." + signature
          // (#361). Only THAT exact token, at this occurrence, counts as
          // claimed: every HS256 JWT shares the head, and a different one is
          // still an opaque bearer.
          const rest = /^\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+={0,2}))?/.exec(
            content.slice(
              match.index + value.length,
              match.index + value.length + 16384
            )
          );
          if (
            rest &&
            (seenValues.has(`${body}.${rest[1]}`) ||
              (rest[2] && seenValues.has(`${body}.${rest[1]}.${rest[2]}`)))
          )
            continue;
        }
        // The tail of a URL is not an assignment.
        if (insideUrlValue(content, match.index)) continue;
      }

      // Skip duplicates, overlapping rematches, and false positives
      if (
        seenValues.has(value) ||
        seenValues.overlaps(value) ||
        isLikelyFalsePositive(body)
      ) {
        continue;
      }

      if (insidePublicIdentifier(match.index, value.length)) continue;

      // A generic assignment under a public brand, or Shopify's own
      // accessToken on a Shopify page, is a public client key: reported
      // under the brand's name at the informational tier.
      let reportType = name;
      let reportPublic = publicByDesign ?? false;
      let reportConfidence: Confidence = confidence;
      let known: FindingExtra | undefined;
      // A provider that writes the key's kind into its prefix: a server
      // secret is a leak at high, a client SDK key is public. The same
      // secret prefix with no provider named stays reviewable, unattributed.
      const providerKey =
        generic && keyOf(value) !== ""
          ? providerKeyOf(match.index, body)
          : undefined;
      if (providerKey?.named) {
        const { row } = providerKey;
        reportType = row.type;
        reportPublic = row.kind === "client-sdk";
        reportConfidence = row.kind === "server-secret" ? "high" : "medium";
        known = {
          provider: row.provider,
          keyKind: row.kind,
          prefix: row.prefix,
          ...EXPOSURE_ONLY,
        };
      } else if (providerKey?.row.kind === "server-secret") {
        reportType = unattributedKeyType(providerKey.row.prefix);
        known = {
          prefix: providerKey.row.prefix,
          provider: "unknown",
          ...EXPOSURE_ONLY,
        };
      } else if (generic) {
        const brand = BRAND_CLAIMABLE_KEY_RE.test(keyOf(value))
          ? (publicBrandNear(match.index) ??
            sdkInitBrandOf(content, match.index))
          : undefined;
        if (brand) {
          reportType = brand;
          reportPublic = true;
        } else if (
          SHOPIFY_TOKEN_KEY_RE.test(keyOf(value)) &&
          SHOPIFY_TOKEN_RE.test(body) &&
          isShopifyPage()
        ) {
          reportType = "Shopify Storefront Access Token";
          reportPublic = true;
        } else if (
          BRAND_CLAIMABLE_KEY_RE.test(keyOf(value)) &&
          isVendorScriptDataAttribute(content, match.index, sourceUrl)
        ) {
          reportType = "Third-party Widget Key";
          reportPublic = true;
        } else if (
          name !== "Bearer Token" &&
          name !== "Basic Auth Header" &&
          isPublicKeyName(completeKeyOf(content, match.index, value)) &&
          !SECRET_VALUE_PREFIX_RE.test(body)
        ) {
          // A name is a claim, not proof, and it comes last: a brand, Shopify's
          // own token or a widget attribute has already said what the value is,
          // and a name must add a hint, never take a classification away.
          known = {
            ...known,
            hint: "the key name says this value is meant for the browser (NEXT_PUBLIC_, VITE_, PUBLIC_, public*, publishable*, client*Key); confirm the value is a client key and not a secret under a public name",
          };
        }
      }

      // `sk_live_` is Stripe's prefix and Paystack's and every widget vendor
      // that copied it. The tail's format tells them apart (#1283).
      if (
        sharedPrefix !== undefined &&
        unattributed === undefined &&
        value.startsWith(sharedPrefix)
      ) {
        const tail = value.slice(sharedPrefix.length);
        const mode = sharedPrefix === "sk_live_" ? "live" : "test";
        if (PAYSTACK_TAIL_RE.test(tail)) {
          reportType = `Paystack ${mode === "live" ? "Live" : "Test"} Secret Key`;
          known = { provider: "Paystack", kind: "secret", mode };
        } else if (HEX_TAIL_RE.test(tail)) {
          const widget = isWidgetKeyAttribute(
            content.slice(Math.max(0, match.index - 64), match.index)
          );
          reportType = unattributedKeyType(sharedPrefix);
          // Only a `data-*-key` attribute is a widget's client key; the same
          // shape anywhere else is a secret of some vendor, so it stays high.
          reportConfidence = widget ? "medium" : "high";
          known = {
            prefix: sharedPrefix,
            provider: "unknown",
            resembles: name,
            ...(widget
              ? { hint: "embeddable widget key (data-*-key attribute)" }
              : {}),
          };
        }
      }

      // Algolia and Typesense use the same 32-character shape for search and
      // admin keys. The variable name cannot prove scope, but an explicit
      // admin/master name is enough to rank the browser exposure above a
      // search-named value; a search name stays reviewable with a hint.
      if (generic && name === "Generic API Key Assignment" && !reportPublic) {
        const completeKey = completeKeyOf(content, match.index, value);
        if (isAdminSearchProviderKey(completeKey, body)) {
          reportConfidence = "high";
          known = {
            ...known,
            keyKind: "admin-named",
            hint: "the key name says admin or master: an admin key can write and delete an index, so a copy in a script that ships to browsers lets anyone change it",
          };
        } else if (isSearchKeyName(completeKey)) {
          known = {
            ...known,
            hint: "the key name says search; a search-only key is meant for browsers but an admin key under this name reads the same, so check which key this is",
          };
        }
      }

      if (seedVerdict === "demo-login" || seedVerdict === "skip") {
        reportType = "Possible Demo Login (seed data table)";
        reportConfidence = "medium";
        known = {
          hint:
            seedVerdict === "demo-login"
              ? "a row of a table of same-shaped records with real-domain emails: may be a working demo login"
              : "sample data (reserved-domain emails or sample markers around it): usually not a working login, but the structure cannot prove it",
        };
      }
      // A value that ends in an ellipsis is the visible start of something: reported, not dropped, at the informational tier.
      if (generic && seedVerdict === undefined && isElidedValue(body)) {
        reportType = PARTIAL_VALUE_TYPE;
        reportConfidence = "info";
        known = {
          hint: "the value ends in an ellipsis: it may be the visible start of a real secret, so check what the full value is and where it is built",
        };
      }

      // A token that only opens like the provider's: reviewable, at medium,
      // with the attribution saying what is and is not known.
      if (unattributed !== undefined) {
        reportType = unattributedKeyType(unattributed ?? undefined);
        reportConfidence = "medium";
        known = {
          ...(unattributed !== null ? { prefix: unattributed } : {}),
          provider: "unknown",
          resembles: name,
        };
      }

      seenValues.add(value);
      const finding = build(
        reportType,
        value,
        reportConfidence,
        reportPublic,
        match.index + (generic ? value.lastIndexOf(body) : 0),
        body.length,
        () => readKeyLookBack(content, match!.index).before,
        () =>
          content.slice(
            match!.index + value.length,
            match!.index + value.length + FORWARD_REACH
          ),
        known
      );
      if (
        finding &&
        finding.type === "AWS Access Key ID" &&
        finding.confidence !== "info" &&
        finding.confidence !== "medium"
      ) {
        const around = content.slice(
          Math.max(0, match.index - AWS_PAIR_REACH),
          match.index + value.length + AWS_PAIR_REACH
        );
        if (!AWS_SECRET_NEAR_RE.test(around)) {
          // The public half of the pair is low value alone, but stays in the
          // machine-readable output: the secret may be in another file.
          finding.confidence = "medium";
          finding.extra = {
            ...finding.extra,
            pair: `no 40-character secret-shaped value within ${AWS_PAIR_REACH} characters: probably the public half of the pair; the secret may sit elsewhere`,
          }; // pragma: allowlist secret
        }
      }
      if (finding) found.add(finding);
    }
  }

  // Pass 2: CONTEXT patterns, a bounded look-behind from each keyword (#357).
  //
  // A bare shape counts only when it STARTS within CONTEXT_KEYWORD_GAP
  // characters after a brand keyword and is word-bounded on both sides: the
  // keyword names the value (`togetherKey: "…"`), it does not merely share a
  // screen with it. A keyword after the value never counts. The key-context
  // gate (digest keys, value position, minified members) still applies.
  //
  // The lowercase copy is built the first time a keyword survives the index:
  // on a page where none does, the pass costs nothing and the megabyte-sized
  // allocation never happens.
  for (const {
    name,
    keyword,
    pattern,
    confidence,
    publicByDesign,
    keyName,
  } of CONTEXT_PATTERNS) {
    if (keywordFilter && !mayContain(keywordFilter, keyword)) continue;
    contentLower ??= content.toLowerCase();

    let pos = 0;
    while ((pos = contentLower.indexOf(keyword, pos)) !== -1) {
      const keywordAt = pos;
      pos = keywordAt + keyword.length;

      // The region the value may START in: the keyword gap after the
      // keyword, or, when the keyword is a naming attribute of a tag, the
      // whole tag in either direction.
      let from = pos;
      let limit = CONTEXT_KEYWORD_GAP;
      const tag = tagBoundsAround(content, keywordAt);
      if (tag && tagNamesKeyword(content.slice(tag.start, tag.end), keyword)) {
        from = tag.start;
        limit = tag.end - tag.start;
        // `<script id="shopify-features">`: the tag names its whole block.
        if (/^<script\b/i.test(content.slice(tag.start, tag.start + 8))) {
          limit = scriptBlockEnd(content, tag.end) - tag.start;
        }
      }
      const region = content.slice(
        from,
        from + Math.max(CONTEXT_SCAN_SPAN, limit)
      );

      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(region)) !== null) {
        if (match.index > limit) break;
        const value = match[0];
        const at = from + match.index;

        // Word-bounded: a 32-hex run inside a 64-hex digest is the digest's.
        if (
          isWordCharAt(content, at - 1) ||
          isWordCharAt(content, at + value.length)
        ) {
          continue;
        }

        // Skip duplicates, overlapping rematches, and false positives
        if (
          seenValues.has(value) ||
          seenValues.overlaps(value) ||
          isLikelyFalsePositive(value)
        ) {
          continue;
        }

        if (insidePublicIdentifier(at, value.length)) continue;

        // The key-context helpers read a bounded stretch either side.
        const lo = Math.max(0, at - CONTEXT_LOCAL_REACH);
        const local = content.slice(
          lo,
          at + value.length + CONTEXT_LOCAL_REACH
        );
        const localAt = at - lo;

        // A value whose structure decodes (an Algolia secured key's restriction
        // list, #361) is proven by that structure; the heuristics below exist
        // for bare shapes that nothing else vouches for.
        const structural = refineFinding(name, value)?.structural === true;

        // For context patterns, require the value to be in a value position
        // (assigned via = or :) to reduce false positives from array elements
        if (!structural && !isInValuePosition(local, value, localAt)) {
          continue;
        }

        // Bare-shape patterns are the shape of a SHA-256 digest, so the key in
        // front of the value decides: never report under sha256/integrity/
        // checksum/commit/cache, or with no assignment context at all.
        const back = readKeyLookBack(local, localAt);
        const keyContext = structural
          ? "credential"
          : classifyKeyContext(
              back.before,
              keyword,
              enclosingTag(local, localAt),
              back.cut
            );
        if (keyContext === "digest" || keyContext === "none") {
          continue;
        }

        // A provider with a public and a secret key of this one shape: the
        // key's name says which this is.
        if (
          keyName &&
          !keyName(assignedKeyName(back.before, enclosingTag(local, localAt)))
        )
          continue;

        // Skip values that look like code identifiers (function/variable
        // names): `apiKey: getSegmentKey` assigns a call, not a key. A QUOTED
        // string under a key that says credential is a literal and reads as
        // one however it is spelt — real Cloudflare tokens carry `_`, real
        // Sanity tokens open `skA…`, and a third of random alphanumeric keys
        // happen to start lowercase-then-uppercase (#357) — provided it has a
        // digit in it: `"paste_your_cloudflare_api_token_here_now"` is
        // quoted, under a credential key, and made of words.
        const literal =
          QUOTE_CHAR_RE.test(content[at - 1] ?? "") &&
          keyContext === "credential" &&
          /[0-9]/.test(value);
        if (!structural && !literal && looksLikeCodeIdentifier(value)) {
          continue;
        }

        seenValues.add(value);
        const finding = build(
          name,
          value,
          confidence,
          publicByDesign ?? false,
          at,
          value.length,
          () => back.before,
          () =>
            content.slice(at + value.length, at + value.length + FORWARD_REACH)
        );
        if (finding) found.add(finding);
      }
    }
  }

  // Pass 3: base64 blobs that decode to text (#360) — a config object handed
  // to the client as one string — scanned as content of their own, two
  // levels deep, reported with a ` (base64)` location suffix.
  // A decoded blob is scanned into a sink of its own, so the cap holds for it too and what it left out is counted here.
  const scanBlob = (
    text: string,
    blobLocation: ReportedLocation,
    url: string | undefined,
    blobDepth: number
  ): LeakedSecret[] => {
    const inner = found.child();
    scanInto(inner, text, blobLocation, url, blobDepth, {});
    found.omit(inner.omitted(), inner.omittedSerious());
    return inner.result();
  };
  for (const finding of scanBase64Blobs(
    content,
    location,
    sourceUrl,
    depth,
    scanBlob
  )) {
    const adjustedOffset = offsetIn(finding.offset);
    if (adjustedOffset < 0) continue;
    found.add({
      ...finding,
      offset: adjustedOffset,
      ...(source.scriptIndex !== undefined
        ? { scriptIndex: source.scriptIndex }
        : {}),
      ...(source.framework ? { framework: source.framework } : {}),
    });
  }
}

// ── Framework data payloads (#362) ──────────────────────────────────────────

/** The frameworks whose server-side data block an inline script can be. */
export type FrameworkPayload = "next" | "nuxt" | "remix" | "sveltekit";

/** How a report names each framework's payload and the loader that filled it, so the fix starts in the right file. */
export const FRAMEWORK_PAYLOADS: Readonly<
  Record<FrameworkPayload, { name: string; payload: string; loader: string }>
> = {
  next: {
    name: "Next.js",
    payload: "__NEXT_DATA__",
    loader: "getServerSideProps, getStaticProps or getInitialProps",
  },
  nuxt: {
    name: "Nuxt",
    payload: "__NUXT__",
    loader: "useAsyncData, useFetch, asyncData or runtimeConfig.public",
  },
  remix: {
    name: "Remix",
    payload: "__remixContext",
    loader: "a route loader",
  },
  sveltekit: {
    name: "SvelteKit",
    payload: "__sveltekit_*",
    loader: "a load function",
  },
};

/** How much of a script's start is read to recognise a payload: each one opens with its global. */
const PAYLOAD_HEAD = 512;
const NUXT_HEAD_RE = /(?:^|[;\s(])(?:window\.)?__NUXT__\s*=/;
const REMIX_HEAD_RE = /\bwindow\.__remixContext\s*=/;
const SVELTEKIT_HEAD_RE = /\b__sveltekit_[A-Za-z0-9]+\s*=/;

/**
 * The framework whose server-side data `script` carries, or undefined for any other inline script: Next.js's
 * `<script id="__NEXT_DATA__">`, Nuxt's `window.__NUXT__ =` (Nuxt 2) and `<script id="__NUXT_DATA__">` (Nuxt 3),
 * Remix's `window.__remixContext =`, and SvelteKit's `__sveltekit_<hash> =` boot script and its
 * `<script data-sveltekit-fetched>` blocks. These are props a server loader returned, serialised verbatim.
 */
export function frameworkPayloadOf(
  script: Element,
  text: string
): FrameworkPayload | undefined {
  const id = script.getAttribute("id");
  if (id === "__NEXT_DATA__") return "next";
  if (id === "__NUXT_DATA__") return "nuxt";
  if (script.hasAttribute("data-sveltekit-fetched")) return "sveltekit";
  const head = text.slice(0, PAYLOAD_HEAD);
  if (NUXT_HEAD_RE.test(head)) return "nuxt";
  if (REMIX_HEAD_RE.test(head)) return "remix";
  if (SVELTEKIT_HEAD_RE.test(head)) return "sveltekit";
  return undefined;
}

// ── HTML comments (#362) ────────────────────────────────────────────────────

const COMMENT_NODE = 8;
const ELEMENT_NODE_TYPE = 1;

/** Every comment node under `root`, in document order. Script and style bodies are text, never walked. */
function commentsOf(root: Node): Comment[] {
  const out: Comment[] = [];
  const stack: Node[] = [];
  for (let c = root.lastChild; c; c = c.previousSibling) stack.push(c);
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.nodeType === COMMENT_NODE) out.push(node as Comment);
    else if (node.nodeType === ELEMENT_NODE_TYPE)
      for (let c = node.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return out;
}

/**
 * Scan ONE page's live DOM for secrets — the full HTML serialization plus each
 * inline `<script>` — in the exact order the site rule's legacy loop produces.
 * Shared by the page-time collector (#1021 E-E2) and the rule's legacy
 * `site.pages` fallback so both yield a byte-identical per-page `LeakedSecret[]`.
 * Caller guarantees `doc` is non-null (page had a parseable document).
 */
/** `<script id="x" type="y">` rebuilt from the element's attributes. */
function openTagOf(el: Element): string {
  let tag = "<script";
  for (const attr of Array.from(el.attributes)) {
    tag += ` ${attr.name}="${attr.value.replace(/"/g, "&quot;")}"`;
  }
  return tag + ">";
}

/** `secret` with every string it carries copied out of the scanned text (see {@link detached}); the record is otherwise unchanged. */
function detachSecret(secret: LeakedSecret): LeakedSecret {
  const out: LeakedSecret = { ...secret, value: detached(secret.value) };
  // The evidence context is sliced from the page too (repo#2215): copy it out like the value.
  if (secret.context !== undefined) out.context = detached(secret.context);
  if (secret.extra) {
    const extra: Record<string, unknown> = { ...secret.extra };
    for (const [key, value] of Object.entries(extra))
      if (typeof value === "string") extra[key] = detached(value);
    out.extra = extra as FindingExtra;
  }
  return out;
}

/**
 * A page scan whose findings survive an interruption (#1556): the collector runs it under the rule's time budget, and a scan
 * that overruns is stopped at an arbitrary point. The sink is outside the stopped call, so what was found before the stop
 * is still there to keep; only the rest of the page is unscanned (and the page says so, see `timedOut`).
 */
export function startPageScan(
  doc: NonNullable<ParsedPage["document"]>,
  pageUrl: string
): {
  run(): void;
  result(): {
    secrets: LeakedSecret[];
    omitted: number;
    omittedSerious: boolean;
  };
} {
  const sink = createFindingSink();
  return {
    run: () => scanPageInto(sink, doc, pageUrl),
    // The records are kept for the whole crawl until the site rule runs: they must not keep the scanned page alive (#1552).
    result: () => ({
      secrets: sink.result().map(detachSecret),
      omitted: sink.omitted(),
      omittedSerious: sink.omittedSerious(),
    }),
  };
}

/**
 * One page's findings, at most {@link PAGE_FINDINGS_CAP} distinct values (the most serious first when there are more), and
 * the number of distinct values left out. The page's document pass and each of its inline scripts share ONE cap.
 */
export function scanPageBounded(
  doc: NonNullable<ParsedPage["document"]>,
  pageUrl: string
): { secrets: LeakedSecret[]; omitted: number; omittedSerious: boolean } {
  const scan = startPageScan(doc, pageUrl);
  scan.run();
  return scan.result();
}

function scanPageInto(
  sink: FindingSink,
  doc: NonNullable<ParsedPage["document"]>,
  pageUrl: string
): void {
  // Inline scripts first: the findings the most serious tier is made of (a server-only key shipped to the browser) are read
  // from a script, so a scan stopped at the time budget (#1556) has read them before the page's whole text. The sink keeps
  // the canonical order: the document's findings (phase 0) come before the scripts' (phase 1) in the result and in the dedupe.
  //
  // Each script's text is read ONCE (#1864). It is also inside the page's HTML, and on a script-heavy page it is most of
  // it: the whole-document pass used to scan every script a second time, and found nothing the inline pass had not, since
  // a value both passes saw is reported from the inline record (the later of equals) unless the HTML record was public.
  // So the HTML pass reads the page serialised with each scanned script's text replaced by spaces (nothing outside a
  // script moves, or comes any nearer anything else), and the one page-level fact a script value was judged by in the
  // HTML pass, whether the page loads from the Shopify CDN, is handed to the inline pass. The page is serialised up
  // front but still scanned last, so a scan stopped at the budget has read the scripts first, as before.
  const inline: Array<{
    script: Element;
    text: string;
    scriptIndex: number;
    framework: FrameworkPayload | undefined;
  }> = [];
  for (const [scriptIndex, script] of Array.from(
    doc.querySelectorAll("script")
  ).entries()) {
    if (script.hasAttribute("src")) continue;
    const text = script.textContent || "";
    if (text.trim())
      inline.push({
        script,
        text,
        scriptIndex,
        framework: frameworkPayloadOf(script, text),
      });
  }
  // Comments are read on their own as `html-comment` (#362) and blanked in the HTML pass like the scripts, each to
  // exactly as many spaces as its text (never cut, so no offset after one moves).
  const comments = commentsOf(doc).filter((c) => c.data.trim().length > 0);

  // A long body keeps BLANK_KEEP spaces and loses the rest (see BLANK_KEEP); `cut` records what each lost, in page order.
  const keep = " ".repeat(BLANK_KEEP);
  const serializeBlanked = (keepsText: (text: string) => boolean) => {
    const cut: number[] = [];
    const blanks = new Map<Node, string>();
    for (const comment of comments)
      blanks.set(comment, " ".repeat(comment.data.length));
    for (const { script, text } of inline) {
      // The inline pass decodes JS and percent escapes only; the HTML pass also decodes HTML entities. A script whose
      // text an entity decode would change keeps its text in the HTML pass, so a value visible only after that decode is
      // found.
      if (decodeHtmlEntities(text) !== text || keepsText(text)) continue;
      if (text.length <= BLANK_KEEP)
        blanks.set(script, " ".repeat(text.length));
      else {
        blanks.set(script, keep);
        cut.push(text.length - BLANK_KEEP);
      }
    }
    return { html: serializeChildren(doc, { replaceText: blanks }), cut };
  };
  // An AWS access key id is judged by whether a 40-character secret sits within AWS_PAIR_REACH of it, and the pair can
  // straddle a script's edge: the id in one script and the secret in the next, or in the markup beside it. Only the
  // HTML pass sees both sides, so on a page that holds an id anywhere, a script holding an id or a secret-shaped value
  // keeps its text there, and the id keeps the confidence the whole page gives it.
  const pairSide = (text: string) =>
    AWS_KEY_ID_SHAPE_RE.test(text) || AWS_SECRET_NEAR_RE.test(text);
  const scriptHasKeyId = inline.some(({ text }) =>
    AWS_KEY_ID_SHAPE_RE.test(text)
  );
  let { html, cut } = serializeBlanked(scriptHasKeyId ? pairSide : () => false);
  if (!scriptHasKeyId && AWS_KEY_ID_SHAPE_RE.test(html))
    ({ html, cut } = serializeBlanked(pairSide));

  // Whether the page loads from the Shopify CDN, as the whole-document pass always judged it: on the page's HTML,
  // scripts included. The markup is asked first, which on a Shopify page carries the CDN's stylesheets and script
  // sources, so the scripts are read again only on a page whose markup does not (and then exactly as before).
  let pageShopify: boolean | null = null;
  const readPageShopify = () =>
    (pageShopify ??=
      pageLoadsFrom(decodeForLocation(html, "html"), SHOPIFY_CDN_HOST) ||
      (inline.length > 0 &&
        pageLoadsFrom(
          decodeForLocation(doc.toString(), "html"),
          SHOPIFY_CDN_HOST
        )));

  sink.phase(1);
  for (const { script, text, scriptIndex, framework } of inline) {
    // The script's own open tag goes in front of its text, so the inline
    // pass classifies `<script id="shopify-features">{"accessToken":…}`
    // exactly as the whole-document pass does: the naming attribute is
    // the look-behind, and the value is public rather than a generic leak
    // that the rule's dedup then has to reconcile. Attributes carry no
    // findings of their own that the document pass has not already made.
    const openTag = openTagOf(script);
    scanInto(
      sink,
      `${openTag}${text}`,
      framework ? "framework-payload" : "inline-script",
      pageUrl,
      0,
      {
        offsetBase: -openTag.length,
        scriptIndex,
        pageLoadsShopify: { read: readPageShopify, replacesOwn: false },
        ...(framework ? { framework } : {}),
      }
    );
  }
  sink.phase(0);
  // Offsets in a comment are into the comment's text.
  for (const comment of comments)
    scanInto(sink, comment.data, "html-comment", pageUrl, 0, {});
  if (html) {
    scanInto(sink, html, "html", pageUrl, 0, {
      pageLoadsShopify: { read: readPageShopify, replacesOwn: true },
      ...(cut.length > 0 ? { blankCut: cut } : {}),
    });
  }
}

/** Every finding of a page, in scan order: no cap, no dedupe. The site rule and the collector read {@link scanPageBounded}. */
export function scanPageForSecrets(
  doc: NonNullable<ParsedPage["document"]>,
  pageUrl: string
): LeakedSecret[] {
  const sink = createListSink();
  scanPageInto(sink, doc, pageUrl);
  // Detached like the bounded scan's records: they outlive the page (#1552).
  return sink.result().map(detachSecret);
}

/**
 * Why a referenced script has no content, or null when it is simply gone (a 404 or 410: the file does not
 * exist, so there is nothing left to leak) (#1749).
 */
function unfetchedReason(script: ScriptContentData): string | null {
  if (script.status === 404 || script.status === 410) return null;
  // Read and empty: nothing in it to leak.
  if (script.content === "" && script.status !== null && script.status < 400)
    return null;
  if (script.fetchSkipReason) {
    return script.fetchSkipReason === "memory-cap"
      ? "not fetched (memory cap)"
      : "not fetched (time budget)";
  }
  if (script.wafBlocked) return "blocked by a WAF or bot challenge";
  if (script.rateLimited) return "rate limited";
  if (script.status === null)
    return script.error ? `request failed (${script.error})` : "not fetched";
  if (script.status >= 500) return `server error (${script.status})`;
  if (script.status >= 400) return `refused (${script.status})`;
  return "no content returned";
}

/** Pages and occurrences kept per value: a key on every page of a large site must not grow without bound (#1755). */
const ORIGIN_PAGES_CAP = 50;
const ORIGIN_OCCURRENCES_CAP = 20;

interface ValueOrigins {
  pages: Set<string>;
  /** More pages than {@link ORIGIN_PAGES_CAP} carried the value: `pages` is the first ones. */
  pagesTruncated: boolean;
  /**
   * One entry per distinct place: the page for html and inline-script, the body's URL for external-script, source-map
   * and config-endpoint.
   */
  occurrences: Map<
    string,
    { location: string; page?: string; script?: string; loadedBy?: number }
  >;
  occurrencesTruncated: boolean;
}

function noteOrigin(
  origins: Map<string, ValueOrigins>,
  finding: LeakedSecret,
  source: string,
  loadedBy: readonly string[] | undefined
): void {
  let entry = origins.get(finding.value);
  if (!entry) {
    entry = {
      pages: new Set(),
      pagesTruncated: false,
      occurrences: new Map(),
      occurrencesTruncated: false,
    };
    origins.set(finding.value, entry);
  }
  const addPage = (page: string): void => {
    if (entry.pages.has(page)) return;
    if (entry.pages.size >= ORIGIN_PAGES_CAP) entry.pagesTruncated = true;
    else entry.pages.add(page);
  };
  // A body other pages load (a script, a source map, a config endpoint) counts the pages that load it.
  const external = loadedBy !== undefined;
  if (external) for (const page of loadedBy ?? []) addPage(page);
  else addPage(source);
  const key = `${finding.location}\u0000${source}`;
  if (entry.occurrences.has(key)) return;
  if (entry.occurrences.size >= ORIGIN_OCCURRENCES_CAP) {
    entry.occurrencesTruncated = true;
    return;
  }
  entry.occurrences.set(
    key,
    external
      ? {
          location: finding.location,
          script: source,
          loadedBy: loadedBy?.length ?? 0,
        }
      : { location: finding.location, page: source }
  );
}

/** What a framework-payload finding's label adds (#362): whose payload, and which loader to fix. */
function frameworkNote(s: LeakedSecret): string {
  if (!s.framework) return "";
  const f = FRAMEWORK_PAYLOADS[s.framework];
  return `: the ${f.name} ${f.payload} payload, which serialises what ${f.loader} returned on the server`;
}

/** The `meta` for an item's places. Only URLs and counts, never the value. */
function occurrencesMeta(
  entry: ValueOrigins | undefined,
  redact: (url: string) => string
): Record<string, unknown> {
  if (!entry || entry.occurrences.size === 0) return {};
  return {
    occurrences: [...entry.occurrences.values()].map((o) => ({
      ...o,
      ...(o.page !== undefined ? { page: redact(o.page) } : {}),
      ...(o.script !== undefined ? { script: redact(o.script) } : {}),
    })),
    ...(entry.occurrencesTruncated || entry.pagesTruncated
      ? { occurrencesTruncated: true }
      : {}),
  };
}

/**
 * A secret found in a URL, shown with only a short prefix and suffix around an ellipsis (#2270): `sk_liv…tU7x`. It keeps
 * no more of the value than the item id's mask (see maskSecret) does.
 */
export function maskUrlSecret(value: string): string {
  if (value.length <= 12)
    return `${value.slice(0, Math.min(4, value.length - 1))}…`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

// `scheme://user:` and the password up to the `@` that ends the authority.
const USERINFO_PASSWORD_RE = /^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:)([^/?#@]*)@/i;

/**
 * Percent-decoded, or the text as it was when it is not valid percent-encoding. `plusIsSpace` reads `+` the way a form
 * query does; without it a literal `+` stays, as it does in a base64 secret.
 */
function decodeUrlPart(part: string, plusIsSpace = true): string {
  try {
    return decodeURIComponent(plusIsSpace ? part.replace(/\+/g, " ") : part);
  } catch {
    return part;
  }
}

/** The secret each finding in `text` points at: the matched value without the key or quotes a generic match carries. */
function secretsIn(text: string, into: Set<string>): void {
  if (text.length === 0) return;
  for (const s of scanContent(text, "external-script")) {
    const at = text.slice(s.offset, s.offset + s.length);
    const secret =
      at.length === s.length && at.length > 0 ? at : quotedBodyOf(s.value);
    if (secret.length > 0) into.add(secret);
  }
}

/** `k=v` pairs as the scanner reads an assignment: the value quoted, so the generic key patterns apply. */
function scanPairs(raw: string, into: Set<string>): void {
  for (const pair of raw.split(/[&;]/)) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq < 0 ? "" : pair.slice(0, eq);
    const rawValue = eq < 0 ? pair : pair.slice(eq + 1);
    // A `+` is a space in a form query but a literal character in a base64 secret (an AWS secret key often has one),
    // so the value is read both ways and a secret either reading finds is masked (#2270).
    const values = new Set([
      decodeUrlPart(rawValue),
      decodeUrlPart(rawValue, false),
    ]);
    const key = decodeUrlPart(rawKey);
    for (const value of values) {
      secretsIn(value, into);
      if (key.length > 0 && !/["'\s]/.test(key))
        secretsIn(`${key}="${value.replace(/"/g, "")}"`, into);
    }
  }
}

/**
 * `url` with every secret in it masked (#2270): a query or fragment value, a path segment or the password of its
 * credentials that the rule's own detector patterns call a secret becomes `prefix…suffix`. A URL with no secret in it
 * comes back unchanged, character for character. Text that is not a URL is scanned whole.
 */
export function redactSecretsInUrl(url: string): string {
  const secrets = new Set<string>();
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed) {
    secretsIn(decodeUrlPart(parsed.username), secrets);
    for (const segment of parsed.pathname.split("/"))
      secretsIn(decodeUrlPart(segment), secrets);
    if (parsed.search.length > 1) scanPairs(parsed.search.slice(1), secrets);
    if (parsed.hash.length > 1) scanPairs(parsed.hash.slice(1), secrets);
  } else {
    secretsIn(decodeUrlPart(url), secrets);
  }
  // A login's password is a credential whatever its shape, and may be short, so it is masked where it sits, never by
  // matching its text elsewhere in the URL.
  let out = parsed?.password
    ? url.replace(
        USERINFO_PASSWORD_RE,
        (_whole, head: string, password: string) =>
          `${head}${maskUrlSecret(decodeUrlPart(password))}@`
      )
    : url;
  if (secrets.size === 0) return out;
  // Longest first, so a secret that contains another is masked whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    const mask = maskUrlSecret(secret);
    const forms = new Set([
      secret,
      encodeURIComponent(secret),
      encodeURI(secret),
      encodeURIComponent(secret).replace(/%20/g, "+"),
    ]);
    for (const form of forms) out = out.split(form).join(mask);
  }
  return out;
}

export const leakedSecretsRule: Rule = {
  meta: {
    id: "security/leaked-secrets",
    name: "Leaked Secrets and API Keys",
    description:
      "Checks for exposed API keys, secrets, and credentials in HTML, comments, scripts, framework data payloads, same-origin source maps and config endpoints",
    solution:
      "API keys and secrets exposed in client-side code can be harvested by attackers to access your services, " +
      "incur charges, or steal data. Move sensitive credentials to server-side code and use environment variables " +
      "that are NOT exposed to the browser. For frontend apps, use a backend proxy to make authenticated API calls. " +
      "Rotate any exposed credentials immediately. Consider using secret scanning tools like Gitleaks or TruffleHog " +
      "in your CI/CD pipeline to prevent future leaks.",
    category: "security",
    scope: "site",
    findingScope: "resource",
    severity: "error",
    weight: 10,
    // Check names by outcome class (#1741).
    checks: [
      { name: "leaked-secrets-critical", outcome: "problem" },
      { name: "leaked-secrets-high", outcome: "problem" },
      { name: "leaked-secrets-medium", outcome: "problem" },
      { name: "leaked-secrets-public", outcome: "problem" },
      { name: "leaked-secrets-info", outcome: "problem" },
      { name: "leaked-secrets-omitted", outcome: "problem" },
      { name: "leaked-secrets-partial", outcome: "problem" },
      {
        name: "leaked-secrets",
        outcome: "clean",
        clears: [
          "leaked-secrets-critical",
          "leaked-secrets-high",
          "leaked-secrets-medium",
          "leaked-secrets-public",
          "leaked-secrets-info",
          "leaked-secrets-omitted",
          "leaked-secrets-partial",
        ],
      },
      { name: "leaked-secrets-unscanned", outcome: "skipped" },
      { name: "leaked-secrets-unfetched", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const leakedSecrets: LeakedSecret[] = [];
    // Findings found and not kept, by the per-page cap (see PAGE_FINDINGS_CAP), and the pages that lost some.
    let omittedFindings = 0;
    const omittedPages: Array<{ url: string; omitted: number }> = [];
    // Appended one at a time: spreading a large array into `push` throws RangeError past the engine's argument limit
    // (#1554), and the whole site's result went with it.
    // Where each value was seen (#1755): the dedupe below keeps one record per value, so the pages and scripts it sat on are
    // collected here, bounded, and read back by `item`. Pages a script loads count as pages of the finding in that script.
    const origins = new Map<string, ValueOrigins>();
    // Every URL the result shows goes through this (#2270): a secret in a page or script URL is masked there too, not
    // repeated in plain text next to the finding that warns about it. One scan per distinct URL.
    const redactedUrls = new Map<string, string>();
    const redact = (url: string): string => {
      let shown = redactedUrls.get(url);
      if (shown === undefined) {
        shown = redactSecretsInUrl(url);
        redactedUrls.set(url, shown);
      }
      return shown;
    };
    const append = (
      found: readonly LeakedSecret[],
      page: string,
      loadedBy?: readonly string[]
    ): void => {
      for (const finding of found) {
        leakedSecrets.push(finding);
        noteOrigin(origins, finding, page, loadedBy);
      }
    };
    // Pages the collector kept were already admitted by the crawl's budget (see `createSiteFindingBudget`). The legacy page
    // path and the external scripts, which are scanned here, go through THE SAME budget when the collector handed it over,
    // so a site has one cap; without one (a caller that built the records itself) they get one of their own.
    const budget =
      ctx.collectedSignals?.secretsBudget ?? createSiteFindingBudget();
    let omittedSerious = false;
    const admitted = (
      found: readonly LeakedSecret[],
      omitted: number,
      serious: boolean
    ): {
      secrets: readonly LeakedSecret[];
      omitted: number;
      serious: boolean;
    } => {
      const result = budget.admit(found);
      return {
        secrets: result.secrets,
        omitted: omitted + result.omitted,
        serious: serious || result.omittedSerious,
      };
    };
    const noteOmitted = (
      url: string,
      omitted: number,
      serious: boolean
    ): void => {
      if (omitted <= 0) return;
      omittedFindings += omitted;
      if (serious) omittedSerious = true;
      omittedPages.push({ url, omitted });
    };

    // Scan all pages' HTML and inline scripts. Streaming (#1021): the per-page
    // scan already ran at page-time — read the collected results in page order.
    // v1: scan each live `site.pages` document. Both go through scanPageBounded,
    // so the per-page secret list and its order are byte-identical.
    if (ctx.collectedSignals) {
      for (const rec of ctx.collectedSignals.pages) {
        append(rec.secrets, rec.url);
        noteOmitted(
          rec.url,
          rec.secretsOmitted ?? 0,
          rec.secretsOmittedSerious ?? true
        );
      }
    } else if (ctx.site?.pages) {
      for (const page of ctx.site.pages) {
        const doc = page.parsed.document;
        if (!doc) continue;
        const scanned = scanPageBounded(doc, page.url);
        const kept = admitted(
          scanned.secrets,
          scanned.omitted,
          scanned.omittedSerious
        );
        append(kept.secrets, page.url);
        noteOmitted(page.url, kept.omitted, kept.serious);
      }
    }

    // Scan external JavaScript files
    // Scripts the audit referenced but could not read (#1749): a secret in one is unknown, not absent.
    const unfetchedScripts: Array<{ url: string; reason: string }> = [];
    if (ctx.site?.scripts) {
      for (const script of ctx.site.scripts) {
        if (script.content) {
          const scanned = scanContentBounded(
            script.content,
            "external-script",
            script.url
          );
          const kept = admitted(
            scanned.secrets,
            scanned.omitted,
            scanned.omittedSerious
          );
          append(kept.secrets, script.url, script.sourcePages);
          noteOmitted(script.url, kept.omitted, kept.serious);
        } else {
          const reason = unfetchedReason(script);
          if (reason) unfetchedScripts.push({ url: script.url, reason });
        }
      }
    }
    // The bodies those scripts point at that a repository scanner never sees (#362): a same-origin source map's
    // original sources and a same-origin config endpoint a bundle fetches. The engine requested at most
    // SECRET_SOURCE_FETCH_LIMITS.MAX_FETCHES of them on the asset budget; a body it could not read is simply not
    // scanned (it is a derived source: the script that names it was scanned, and is reported if it was not).
    for (const source of ctx.site?.secretSources ?? []) {
      if (source.content === null || source.content === "") continue;
      let scanned: ReturnType<typeof scanTextsBounded> | null = null;
      if (source.kind === "source-map") {
        const sources = sourceMapSources(source.content);
        if (sources && sources.length > 0)
          scanned = scanTextsBounded(sources, "source-map", source.url);
      } else if (!isHtmlBody(source.contentType, source.content)) {
        scanned = scanContentBounded(
          source.content,
          "config-endpoint",
          source.url
        );
      }
      if (!scanned) continue;
      const kept = admitted(
        scanned.secrets,
        scanned.omitted,
        scanned.omittedSerious
      );
      append(kept.secrets, source.url, source.sourcePages);
      noteOmitted(source.url, kept.omitted, kept.serious);
    }
    // Scripts the asset fetch caps never requested: counted, not named (the crawl dropped them before they had a record).
    const capDropped = ctx.site?.assetCapDropped?.scripts ?? 0;
    // Scripts a `store_scripts` run fetched for storage but the script rule limit kept from this rule (#1757).
    const heldBackUrls = ctx.site?.scriptsNotReadUrls ?? [];

    // Deduplicate by value (same secret may appear in multiple places).
    // The same value can be classified twice — the whole-document scan sees
    // the `<script id="shopify-features">` tag and the cdn.shopify.com link
    // that make a token public, the inline-script scan of the same text does
    // not — and the classification with more context wins: public over a
    // generic leak, otherwise the last record.
    const byValue = new Map<string, LeakedSecret>();
    for (const s of leakedSecrets) {
      const prior = byValue.get(s.value);
      if (prior?.publicByDesign && !s.publicByDesign) continue;
      // A later page's plain HTML hit must not hide the script hit that makes
      // a server-only secret critical.
      if (
        prior &&
        isShippedServerSecret(prior) &&
        !isShippedServerSecret(s) &&
        !s.publicByDesign
      )
        continue;
      byValue.set(s.value, s);
    }
    // A generic assignment's value carries its key (`accessToken":"…"`), so
    // it never equals the bare token another scan classified as public, and
    // a public record that was itself a re-typed generic carries ITS key
    // (`access-token":"…"`). Both sides are compared by the quoted body.
    // Exact equality, by Set: containment would let a public username hide
    // the database URL it sits in.
    const publicBodies = new Set(
      Array.from(byValue.values())
        .filter((s) => s.publicByDesign)
        .map((s) => quotedBodyOf(s.value))
    );
    const uniqueSecrets = Array.from(byValue.values()).filter(
      (s) =>
        s.publicByDesign ||
        !s.type.startsWith("Generic ") ||
        !publicBodies.has(quotedBodyOf(s.value))
    );

    // Public-by-design client keys are informational only — never leaks
    const publicKeys = uniqueSecrets.filter((s) => s.publicByDesign);
    // Expired tokens and session tokens: shown, never counted (#361)
    const informationalAll = uniqueSecrets.filter(
      (s) => !s.publicByDesign && s.confidence === "info"
    );
    // A value cut short by an ellipsis is not an expired or session token: it has its own check.
    const partialValues = informationalAll.filter(
      (s) => s.type === PARTIAL_VALUE_TYPE
    );
    const informational = informationalAll.filter(
      (s) => s.type !== PARTIAL_VALUE_TYPE
    );
    const realSecrets = uniqueSecrets.filter(
      (s) => !s.publicByDesign && s.confidence !== "info"
    );

    // Separate by confidence
    // Server-only secrets read from a browser-served script move out of the
    // high and medium checks into their own: same hit, higher severity.
    const critical = realSecrets.filter(isShippedServerSecret);
    const rest = realSecrets.filter((s) => !isShippedServerSecret(s));
    const highConfidence = rest.filter((s) => s.confidence === "high");
    const mediumConfidence = rest.filter((s) => s.confidence === "medium");

    // One item per finding: the pattern and masked value as the id, where it
    // was read as the label, and whatever its structure decoded to (#361) as
    // `meta`, which the JSON, LLM and XML renderers carry through verbatim.
    const item = (s: LeakedSecret): CheckItem => ({
      id: `${s.type}: ${maskSecret(s.value)}`,
      label: `Found in ${s.location}${s.sourceUrl ? ` (${redact(s.sourceUrl)})` : ""}${frameworkNote(s)}`,
      // Each page the value sat on, whether in its HTML or inline script or through a script it loads.
      ...(origins.get(s.value)?.pages.size
        ? { sourcePages: [...origins.get(s.value)!.pages].map(redact) }
        : {}),
      meta: {
        ...(s.extra ?? {}),
        ...(s.framework
          ? { framework: FRAMEWORK_PAYLOADS[s.framework].name }
          : {}),
        ...occurrencesMeta(origins.get(s.value), redact),
        length: s.length,
        offset: s.offset,
        ...(s.context !== undefined ? { context: s.context } : {}),
        ...(s.scriptIndex !== undefined ? { scriptIndex: s.scriptIndex } : {}),
        ...(s.truncated ? { truncated: true } : {}),
      },
    });

    // The report keeps `maxItemsPerCheck` items of a check and rolls the rest into `details.additional`: the rule does the
    // same, so a check never carries more than the report would (a 10 MB page of key shapes was a 107 MB result).
    const listed = (
      list: LeakedSecret[]
    ): { items: CheckItem[]; extra: { additional?: number } } => {
      const shown =
        list.length > PAGE_FINDINGS_CAP
          ? list.slice(0, PAGE_FINDINGS_CAP)
          : list;
      return {
        items: shown.map(item),
        extra:
          list.length > shown.length
            ? { additional: list.length - shown.length }
            : {},
      };
    };

    if (critical.length > 0) {
      const { items, extra } = listed(critical);
      checks.push({
        name: "leaked-secrets-critical",
        status: "fail",
        message: `${critical.length} critical server-only secret(s) shipped to every visitor in browser-served scripts (rotate now)`,
        details: { severity: "critical", ...extra },
        items,
      });
    }

    if (highConfidence.length > 0) {
      const { items, extra } = listed(highConfidence);
      checks.push({
        name: "leaked-secrets-high",
        status: "fail",
        message: `${highConfidence.length} high-confidence leaked secret(s) detected`,
        ...(extra.additional !== undefined ? { details: extra } : {}),
        items,
      });
    }

    if (mediumConfidence.length > 0) {
      const { items, extra } = listed(mediumConfidence);
      checks.push({
        name: "leaked-secrets-medium",
        status: "warn",
        message: `${mediumConfidence.length} potential secret(s) detected (verify manually)`,
        ...(extra.additional !== undefined ? { details: extra } : {}),
        items,
      });
    }

    if (publicKeys.length > 0) {
      const { items, extra } = listed(publicKeys);
      checks.push({
        name: "leaked-secrets-public",
        status: "info",
        message: `${publicKeys.length} public client-side key(s) found (public by design, verify usage restrictions are configured)`,
        ...(extra.additional !== undefined ? { details: extra } : {}),
        items,
      });
    }

    if (informational.length > 0) {
      const { items, extra } = listed(informational);
      checks.push({
        name: "leaked-secrets-info",
        status: "info",
        message: `${informational.length} expired, session-scoped or signature-bound token(s) found (informational, not counted as a leak)`,
        ...(extra.additional !== undefined ? { details: extra } : {}),
        items,
      });
    }

    // Findings the per-page cap left out are COUNTED, never dropped in silence: the pages that lost some are listed, so a
    // page that was cut does not read as one with only what is shown.
    if (omittedFindings > 0) {
      checks.push({
        name: "leaked-secrets-omitted",
        // Only public-by-design or informational findings left out: nothing to act on, so no warning on a clean site.
        status: omittedSerious ? "warn" : "info",
        message: `At least ${omittedFindings} more secret-shaped finding(s) on ${omittedPages.length} source(s) were not kept (a value left out on several pages counts on each): a page or script keeps at most ${PAGE_FINDINGS_CAP} and a site ${SITE_FINDINGS_CAP} in all, most serious first, so what is listed is not all of it`,
        details: {
          omitted: omittedFindings,
          perPageCap: PAGE_FINDINGS_CAP,
          siteCap: SITE_FINDINGS_CAP,
          atLeast: true,
        },
        items: omittedPages.slice(0, 20).map((p) => ({
          id: redact(p.url),
          label: `${p.omitted} finding(s) not kept`,
        })),
      });
    }

    if (partialValues.length > 0) {
      checks.push({
        name: "leaked-secrets-partial",
        status: "info",
        message: `${partialValues.length} value(s) under a password or secret key end in an ellipsis (the visible start of a secret, or a placeholder: check the full value)`,
        items: partialValues.map(item),
      });
    }

    // Pages whose page-time scan ran past the rule time budget were not scanned:
    // their empty secret list is "unknown", never "clean". The runner records the
    // timeout itself as a skipped `-error` check; this keeps the rule from also saying
    // nothing was found.
    const unscanned = (ctx.collectedSignals?.pages ?? []).filter((p) =>
      p.timedOut?.ruleIds.includes("security/leaked-secrets")
    );
    if (unscanned.length > 0) {
      checks.push({
        name: "leaked-secrets-unscanned",
        status: "info",
        message: `${unscanned.length} page(s) were not fully scanned for secrets because the scan exceeded its time budget (what was found before it stopped is kept), so no finding on them is not a clean result`,
        items: unscanned
          .slice(0, 20)
          .map((p) => ({ id: redact(p.url), label: "Not fully scanned" })),
      });
    }

    if (unfetchedScripts.length > 0 || capDropped > 0) {
      const named = unfetchedScripts.length;
      const parts: string[] = [];
      if (named > 0) parts.push(`${named} script(s) could not be read`);
      if (capDropped > 0)
        parts.push(
          `${capDropped} script(s) were not scanned because the script limit or the asset fetch cap was reached`
        );
      checks.push({
        name: "leaked-secrets-unfetched",
        status: "info",
        message: `${parts.join(" and ")}, so a secret in them would not be found: no finding there is not a clean result`,
        details: { unfetched: named, capDropped },
        items: [
          ...unfetchedScripts.map((u) => ({
            id: redact(u.url),
            label: u.reason,
          })),
          ...heldBackUrls.map((url) => ({
            id: redact(url),
            label: "not scanned (script limit)",
          })),
        ].slice(0, 20),
      });
    }

    if (
      realSecrets.length === 0 &&
      unscanned.length === 0 &&
      unfetchedScripts.length === 0 &&
      capDropped === 0
    ) {
      checks.push({
        name: "leaked-secrets",
        status: "pass",
        message: "No leaked API keys or secrets detected",
      });
    }

    return { checks };
  },
};
