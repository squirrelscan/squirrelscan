// security/leaked-secrets - Detect leaked API keys and secrets in HTML/JS

import type {
  Rule,
  RuleContext,
  RuleResult,
  CheckItem,
  CheckResult,
  ParsedPage,
} from "../types";

import { SECRET_KEY_LOOKBEHIND_SIZE } from "@squirrelscan/utils/constants";

import { shannonEntropy } from "../integrity/signals";
import {
  buildGramIndex,
  mayContain,
  mayMatch,
  withPrefilter,
  type GramIndex,
} from "../shared/literal-prefilter";
import { refineFinding, type Confidence, type FindingExtra } from "./secrets/confidence";
import { decodeForLocation, scanBase64Blobs, type ReportedLocation } from "./secrets/decode";

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

  // Database/Backend Services
  {
    // Any JWT, whatever its `alg`: header, payload and signature, the first
    // two of them base64url JSON (`eyJ` is `{"`). Which token it is comes
    // from the decoded claims (secrets/confidence.ts, #361): a Supabase anon
    // key reports as public, a service_role key as high, an expired one or a
    // first-party session token as info, anything else medium.
    name: "JSON Web Token",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}={0,2}/g,
    keywords: ["eyj"],
    confidence: "medium",
  },
  {
    name: "Supabase Service Role Key",
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
  },
  {
    name: "Stripe Test Key",
    pattern: /sk_test_[0-9a-zA-Z]{24,}/g,
    keywords: ["sk_test_"],
    confidence: "high",
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
    name: "AWS Access Key ID",
    pattern: /(A3T[A-Z0-9]|AKIA|AGPA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
    keywords: ["a3t","akia","agpa","aroa","aipa","anpa","anva","asia"],
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
    // OAuth client IDs are public identifiers, not secrets
    name: "Google OAuth Client ID",
    pattern: /[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com/g,
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
  },

  // Auth Services
  {
    name: "Clerk Secret Key",
    pattern: /sk_live_[a-zA-Z0-9]{40,}/g,
    keywords: ["sk_live_"],
    confidence: "high",
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

  // Crypto Keys
  {
    name: "Private Key (RSA)",
    pattern: /-----BEGIN RSA PRIVATE KEY-----/g,
    keywords: ["-----begin rsa private key-----"],
    confidence: "high",
  },
  {
    name: "Private Key (DSA)",
    pattern: /-----BEGIN DSA PRIVATE KEY-----/g,
    keywords: ["-----begin dsa private key-----"],
    confidence: "high",
  },
  {
    name: "Private Key (EC)",
    pattern: /-----BEGIN EC PRIVATE KEY-----/g,
    keywords: ["-----begin ec private key-----"],
    confidence: "high",
  },
  {
    name: "Private Key (OpenSSH)",
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g,
    keywords: ["-----begin openssh private key-----"],
    confidence: "high",
  },
  {
    name: "Private Key (PGP)",
    pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
    keywords: ["-----begin pgp private key block-----"],
    confidence: "high",
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
    pattern: /storefrontAccessToken['"]?\s*(?:[:=]|\|\|=?|\?\?=?)\s*['"][a-f0-9]{32}['"]/g,
    keywords: ["storefrontaccesstoken"],
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
      /(?:api[_-]?key|apikey)(?:['"]\s*\]|['"]?)\s*(?:[:=]|\|\|=?|\?\?=?)\s*['"][a-zA-Z0-9_-]{20,}['"]/gi,
    confidence: "medium",
    keyAnchored: true,
    generic: true,
    keywords: ["api_key", "api-key", "apikey"],
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
    keywords: ["access_token", "access-token", "accesstoken", "auth_token", "auth-token", "authtoken"],
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
  "placeholder|your[_-]?api[_-]?key|test[_-]?key|demo[_-]?key|sample|dummy|fake|redacted";
const FALSE_POSITIVE_PATTERNS = [
  // Google tag IDs (GTM containers, GA4/UA measurement IDs, Ads/DC tags)
  // are public identifiers — never secrets, whatever pattern caught them
  /^(GTM|G|UA|AW|DC)-[A-Z0-9-]+$/i,
  // A host, so anywhere: a connection string to example.com is a placeholder
  /example\.com/i,
  new RegExp(`^[^A-Za-z0-9]{0,2}[A-Za-z0-9]{0,12}[_.-]?(?:${PLACEHOLDER_WORDS})`, "i"),
  new RegExp(`(?:${PLACEHOLDER_WORDS})[_.-]?[A-Za-z0-9]{0,4}$`, "i"),
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
  for (let i = value.length - 1; i >= 0 && (value.charCodeAt(i) | 0x20) === last; i--) run++;
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
  return { before: text.slice(start, index), cut: opensOnKeyChar && !reachedEdge };
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
const PRECEDING_KEY_RE =
  /["'`]?([A-Za-z_$][A-Za-z0-9_$.-]*)(?:["'`]\s*\]|["'`]?)\s*(?:[:=]|\|\|=?|\?\?=?)\s*["'`]?\s*$/;

// The same, written as a bracket access: `cfg["apiKey"] = "`, `cfg['sha256'] =`
const BRACKET_KEY_RE =
  /\[\s*["'`]([^"'`\]]{1,64})["'`]\s*\]\s*(?:[:=]|\|\|=?|\?\?=?)\s*["'`]?\s*$/;

// Anything at all in value position, whatever the key turned out to be
const ASSIGNMENT_RE = /[:=]\s*["'`]?\s*$/;

// SRI and prefixed-digest values: integrity="sha384-…", `sha256-…`, `md5:…`
const DIGEST_PREFIX_RE = /(?:sha-?(?:1|256|384|512)|md5)\s*[-:]\s*[\w+/=-]*$/i;

// An HTML integrity attribute, whatever the algorithm prefix looks like
const INTEGRITY_ATTR_RE = /\bintegrity\s*=\s*["'][^"']*$/i;

// Header-style credentials: `Authorization: Bearer <value>`, `Basic <value>`
const AUTH_SCHEME_RE = /\b(?:bearer|basic)\s+$/i;

// Attributes that name the value carried by a sibling attribute of the same
// tag, in either order: `<meta name="algolia-api-key" content="…">` and
// `<meta content="…" name="algolia-api-key">` say the same thing.
const TAG_NAMING_ATTR_RE =
  /\b(?:name|id|itemprop|property)\s*=\s*["']([^"']{1,64})["']/gi;
const TAG_DATA_ATTR_RE = /\b(data-[A-Za-z0-9_-]{1,64})\s*=/g;

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
function tagBoundsAround(text: string, index: number): { start: number; end: number } | undefined {
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
  while (runStart > floor && KEY_SEGMENT_CHAR_RE.test(text[runStart - 1] ?? "")) {
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
  const readable = key && !wordsAreWhole(match) ? key.replace(/^[A-Za-z0-9]+/, "") : key;

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
  /** `info`: expired, or a session token the crawl itself was issued. Never a leak. */
  confidence: Confidence;
  publicByDesign: boolean;
  /** Where it was read, with ` (base64)` when it sat inside a decoded blob. */
  location: ReportedLocation;
  sourceUrl?: string; // URL of the script file or page
  /** What the value's own structure decoded to (#361): account id, role… */
  extra?: FindingExtra;
}

function isLikelyFalsePositive(value: string): boolean {
  return endsInRepeatedChar(value) || FALSE_POSITIVE_PATTERNS.some((pattern) => pattern.test(value));
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
  const segments = body.split("/").filter((segment, i) => !(i === 0 && segment === ""));
  if (segments.length === 0) return false;
  if (!segments.every((segment) => PATH_SEGMENT_RE.test(segment))) return false;
  return rooted || segments.length > 1;
}

/** `login.err.weakPassword`: a catalogue key, not a secret. */
function isDottedIdentifier(body: string): boolean {
  if (!body.includes(".") || body.length > DOTTED_MAX) return false;
  const segments = body.split(".");
  return segments.length > 1 && segments.every((segment) => DOTTED_SEGMENT_RE.test(segment));
}

/** Could this body be a credential at all? */
function isNotACredentialValue(body: string): boolean {
  return isNonAsciiText(body) || isLocationValue(body) || isDottedIdentifier(body);
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
  if (text.slice(Math.max(0, index - 5), index).toLowerCase() !== "data-") return false;
  const tag = tagBoundsAround(text, index);
  if (!tag) return false;
  const open = text.slice(tag.start, tag.end);
  if (!/^<script\b/i.test(open)) return false;
  const src = SCRIPT_SRC_ATTR_RE.exec(open)?.[1];
  return src !== undefined && isCrossOriginScript(src, pageUrl);
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
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
  );
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
    const parts = body.slice(0, end).split(/[\s:=]+/).filter(Boolean);
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
function fastPatternMayFire(pattern: { keywords?: string[] }, index: GramIndex | null): boolean {
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
const PUBLIC_CONTEXT = CONTEXT_PATTERNS.filter((p) => p.publicByDesign).map((p) => ({
  keyword: p.keyword,
  whole: new RegExp(`^(?:${p.pattern.source})$`, p.pattern.flags.replace("g", "")),
}));
const PUBLIC_KEYWORD_MAX = Math.max(0, ...PUBLIC_CONTEXT.map((p) => p.keyword.length));

/**
 * Client SDKs whose configuration object or custom element carries a key
 * that is public by design. A generic assignment under one of these — the
 * brand as the parent key (`raygun:{apiKey:"…"}`), as the tag name
 * (`<builder-component api-key="…">`) or within the look-behind — reports at
 * the public tier under the brand's name (#357 r3). Deliberately short; the
 * rest of the brands are pub#359's job.
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
const URL_CANDIDATE_RE = /(?:https?:)?\/\/[^\s"'<>]+/g;
const URL_CANDIDATE_CAP = 2000;

/** Does the page reference `hostname` by URL? Parsed, never matched. */
function pageLoadsFrom(text: string, hostname: string): boolean {
  URL_CANDIDATE_RE.lastIndex = 0;
  let seen = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_CANDIDATE_RE.exec(text)) !== null && seen++ < URL_CANDIDATE_CAP) {
    try {
      if (new URL(m[0], "https://page.invalid/").hostname === hostname) return true;
    } catch {
      // not a URL after all
    }
  }
  return false;
}

// A `<script …>` open tag, for the blocks whose attributes name a public
// keyword (`<script id="shopify-features">`): the whole block is that
// keyword's look-behind.
const SCRIPT_OPEN_RE = /<script\b([^>]*)>/gi;
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

// The generic keys a public brand may claim: an API key or an access token
// is the SDK's client credential, a password, secret or auth token is not,
// whatever object it sits in (`sentry:{authToken:"sntrys_…"}` is a server
// token).
const BRAND_CLAIMABLE_KEY_RE = /^(?:api[_-]?key|apikey|access[_-]?token|accesstoken)$/i;

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
  return body.includes("%20") || (body.endsWith("%") && /^[A-Za-z%]+$/.test(body));
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
  return /^eyJ[A-Za-z0-9_-]+$/.test(body) && text.charCodeAt(end) === 46 && isWordCharAt(text, end + 1);
}

/**
 * The FAST patterns the keyword prefilter selects for this content, by name.
 * Exported for the corpus meta-test, which asserts that every positive's
 * input selects the pattern it expects and a corrupted keyword deselects it.
 * Content too short to index selects everything, exactly as scanContent does.
 */
export function selectFastPatterns(content: string): string[] {
  const index = buildGramIndex(content);
  return FAST_PATTERNS.filter((p) => fastPatternMayFire(p, index)).map((p) => p.name);
}

/**
 * How much text after a value a decoder may read. A signature sits PAST the
 * key it signs, so a presigned S3 URL cannot be recognised from the
 * look-behind alone; one kilobyte covers the query string of one.
 */
const FORWARD_REACH = 1024;

export function scanContent(
  content: string,
  location: ReportedLocation,
  sourceUrl?: string,
  depth = 0
): LeakedSecret[] {
  const found: LeakedSecret[] = [];

  // Entities in HTML, `\u`/`\x` escapes in script text (#360): every pattern
  // below reads the decoded form, once. See secrets/decode.ts.
  content = decodeForLocation(content, location);

  // What the value's own structure says (#361): a checksum that fails drops
  // the finding, a decoded claim moves it between tiers, and whatever else
  // decoded rides along as `extra` for the report. See secrets/confidence.ts.
  const build = (
    name: string,
    value: string,
    confidence: Confidence,
    publicByDesign: boolean,
    before: () => string,
    after: () => string
  ): LeakedSecret | null => {
    const refined = refineFinding(name, value, Date.now(), { before, after });
    if (refined?.drop) return null;
    return {
      type: refined?.type ?? name,
      value,
      confidence: refined?.confidence ?? confidence,
      publicByDesign: refined?.publicByDesign ?? publicByDesign,
      location,
      sourceUrl,
      ...(refined?.extra ? { extra: refined.extra } : {}),
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

  // The lowercase copy locates the context tier's brand words, and the
  // public-tier check the generic assignments make. Built on first use.
  //
  // The index folds ASCII case, which over-approximates `content` but NOT
  // `content.toLowerCase()` — the keyword is looked for in the latter. Two
  // characters lowercase into ASCII the content does not itself contain, and on
  // a page carrying either of them the keyword tier runs unfiltered rather than
  // risk skipping a keyword the lowercased copy really has.
  let contentLower: string | null = null;
  const keywordFilter = gramIndex && !gramIndex.lowercaseAddsAscii ? gramIndex : null;

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
  let scriptBlocks: Array<{ from: number; to: number; tag: string }> | null = null;
  const publicScriptBlocks = () => {
    if (scriptBlocks) return scriptBlocks;
    scriptBlocks = [];
    if (content.includes("<script") || content.includes("<SCRIPT")) {
      SCRIPT_OPEN_RE.lastIndex = 0;
      let open: RegExpExecArray | null;
      while ((open = SCRIPT_OPEN_RE.exec(content)) !== null) {
        // The same rule the context pass applies: the keyword has to sit in
        // a NAMING attribute (`id="shopify-features"`), not in a `src`.
        const tagText = open[0];
        const named = PUBLIC_CONTEXT.filter((p) => tagNamesKeyword(tagText, p.keyword)).map((p) => p.keyword);
        if (named.length === 0) continue;
        const from = open.index + tagText.length;
        scriptBlocks.push({ from, to: scriptBlockEnd(content, from), tag: named.join(" ") });
      }
    }
    return scriptBlocks;
  };

  const publicContextClaims = (valueAt: number, body: string): boolean => {
    if (PUBLIC_CONTEXT.length === 0) return false;
    if (keywordFilter && !PUBLIC_CONTEXT.some((p) => mayContain(keywordFilter, p.keyword))) return false;
    const from = Math.max(0, valueAt - CONTEXT_KEYWORD_GAP - PUBLIC_KEYWORD_MAX);
    const window = content.slice(from, valueAt).toLowerCase();
    return PUBLIC_CONTEXT.some(({ keyword, whole }) => {
      if (!whole.test(body)) return false;
      const at = window.lastIndexOf(keyword);
      if (at !== -1 && window.length - (at + keyword.length) <= CONTEXT_KEYWORD_GAP) return true;
      return publicScriptBlocks().some((b) => b.from <= valueAt && valueAt < b.to && b.tag.includes(keyword));
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
    if (tag) tagName = /^<([A-Za-z][\w-]*)/.exec(content.slice(tag.start, Math.min(tag.end, tag.start + 80)))?.[1]?.toLowerCase();
    for (const [brand, type] of PUBLIC_BRANDS) {
      const at = window.lastIndexOf(brand);
      if (at !== -1 && window.length - (at + brand.length) <= CONTEXT_KEYWORD_GAP) return type;
      if (tagName?.includes(brand)) return type;
    }
    return undefined;
  };

  let shopifyPage: boolean | null = null;
  const isShopifyPage = () => (shopifyPage ??= pageLoadsFrom(content, SHOPIFY_CDN_HOST));

  // Pass 1: FAST patterns, gated twice — by the literals proven from each
  // regex (#1864) and by the keywords each pattern declares (#357). Both
  // gates read the gram index, so a body the index rules out costs nothing.
  for (const entry of PREFILTERED_FAST_PATTERNS) {
    const { name, pattern, confidence, publicByDesign, keyAnchored, generic, valuePosition, minTailEntropy, literals } =
      entry;
    if (!mayMatch(gramIndex, literals)) continue;
    if (!fastPatternMayFire(entry, gramIndex)) continue;

    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[0];

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

      // A generic assignment can start part-way through a longer key, so the
      // words to its left decide too: `cache-api-key` is a cache key.
      if (keyAnchored && startsInsideDigestKey(content, match.index)) {
        continue;
      }

      // …and a credential word inside a ternary's branch is not a key at all.
      if (keyAnchored && startsInTernaryBranch(content, match.index)) {
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

      // A bare shape the key gave meaning to has to look like a token:
      // `password: "Password confirmation"` is a label (#357). The // pragma: allowlist secret
      // placeholder list reads the same body, since the key is part of the
      // match and `apiKey:"YOUR_API_KEY…"` is a placeholder however keyed. // pragma: allowlist secret
      const body = generic ? genericValueOf(value) : value;
      if (generic) {
        if (/\s/.test(body) || shannonEntropy(body) < genericEntropyFloor(body.length)) continue;
        // `password:"Password"`, `passwd:"passwd"`: an i18n label whose value // pragma: allowlist secret
        // is its own key. And a URL-encoded sentence (`…ed%`, `%20`) is a
        // label too, however the encoding scattered its letters. // pragma: allowlist secret
        if (alnum(body) === alnum(keyOf(value))) continue;
        if (isPercentEncodedLabel(body)) continue;
        // A label in a script that does not space its words, a route path or
        // a catalogue key cannot be a credential whatever the key says.
        if (isNotACredentialValue(body)) continue;
        // WordPress's oEmbed nonce: `data-secret` on a wp-embedded-content
        // element, or a ten-character alphanumeric under `data-secret`.
        if (
          name === "Generic Secret Assignment" &&
          content.slice(Math.max(0, match.index - 5), match.index).toLowerCase() === "data-" &&
          (WP_EMBED_NONCE_RE.test(body) ||
            (tagBoundsAround(content, match.index) !== undefined &&
              /\bwp-embedded-content\b/.test(content.slice(tagBoundsAround(content, match.index)!.start, match.index))))
        ) {
          continue;
        }
        // A value the public tier claims under a brand keyword in front of
        // it (`storefrontAccessToken:"…"` after `shopify`) is that tier's:
        // the context pass reports it as informational, not as a leak.
        if (publicContextClaims(match.index + value.lastIndexOf(body), body)) continue;
        // A Bearer whose value is a JWT that a JWT pattern already claimed
        // belongs to that pattern: the three-segment token is one credential,
        // and the Bearer match stops at its first dot. A JWT no pattern
        // recognises still reports here as an opaque bearer token.
        if (name === "Bearer Token" && isJwtHead(body, content, match.index + value.length)) {
          // The JWT pattern's value is head + "." + payload + "." + signature
          // (#361). Only THAT exact token, at this occurrence, counts as
          // claimed: every HS256 JWT shares the head, and a different one is
          // still an opaque bearer.
          const rest = /^\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+={0,2}))?/.exec(
            content.slice(match.index + value.length, match.index + value.length + 16384)
          );
          if (rest && (seenValues.has(`${body}.${rest[1]}`) || (rest[2] && seenValues.has(`${body}.${rest[1]}.${rest[2]}`)))) continue;
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

      // A generic assignment under a public brand, or Shopify's own
      // accessToken on a Shopify page, is a public client key: reported
      // under the brand's name at the informational tier.
      let reportType = name;
      let reportPublic = publicByDesign ?? false;
      if (generic) {
        const brand = BRAND_CLAIMABLE_KEY_RE.test(keyOf(value)) ? publicBrandNear(match.index) : undefined;
        if (brand) {
          reportType = brand;
          reportPublic = true;
        } else if (SHOPIFY_TOKEN_KEY_RE.test(keyOf(value)) && SHOPIFY_TOKEN_RE.test(body) && isShopifyPage()) {
          reportType = "Shopify Storefront Access Token";
          reportPublic = true;
        } else if (
          BRAND_CLAIMABLE_KEY_RE.test(keyOf(value)) &&
          isVendorScriptDataAttribute(content, match.index, sourceUrl)
        ) {
          reportType = "Third-party Widget Key";
          reportPublic = true;
        }
      }

      seenValues.add(value);
      const finding = build(
        reportType,
        value,
        confidence,
        reportPublic,
        () => readKeyLookBack(content, match!.index).before,
        () => content.slice(match!.index + value.length, match!.index + value.length + FORWARD_REACH)
      );
      if (finding) found.push(finding);
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
  for (const { name, keyword, pattern, confidence, publicByDesign } of CONTEXT_PATTERNS) {
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
      const region = content.slice(from, from + Math.max(CONTEXT_SCAN_SPAN, limit));

      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(region)) !== null) {
        if (match.index > limit) break;
        const value = match[0];
        const at = from + match.index;

        // Word-bounded: a 32-hex run inside a 64-hex digest is the digest's.
        if (isWordCharAt(content, at - 1) || isWordCharAt(content, at + value.length)) {
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

        // The key-context helpers read a bounded stretch either side.
        const lo = Math.max(0, at - CONTEXT_LOCAL_REACH);
        const local = content.slice(lo, at + value.length + CONTEXT_LOCAL_REACH);
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
          : classifyKeyContext(back.before, keyword, enclosingTag(local, localAt), back.cut);
        if (keyContext === "digest" || keyContext === "none") {
          continue;
        }

        // Skip values that look like code identifiers (function/variable
        // names): `apiKey: getSegmentKey` assigns a call, not a key. A QUOTED
        // string under a key that says credential is a literal and reads as
        // one however it is spelt — real Cloudflare tokens carry `_`, real
        // Sanity tokens open `skA…`, and a third of random alphanumeric keys
        // happen to start lowercase-then-uppercase (#357) — provided it has a
        // digit in it: `"paste_your_cloudflare_api_token_here_now"` is
        // quoted, under a credential key, and made of words.
        const literal =
          QUOTE_CHAR_RE.test(content[at - 1] ?? "") && keyContext === "credential" && /[0-9]/.test(value);
        if (!structural && !literal && looksLikeCodeIdentifier(value)) {
          continue;
        }

        seenValues.add(value);
        const finding = build(
          name,
          value,
          confidence,
          publicByDesign ?? false,
          () => back.before,
          () => content.slice(at + value.length, at + value.length + FORWARD_REACH)
        );
        if (finding) found.push(finding);
      }
    }
  }

  // Pass 3: base64 blobs that decode to text (#360) — a config object handed
  // to the client as one string — scanned as content of their own, two
  // levels deep, reported with a ` (base64)` location suffix.
  for (const finding of scanBase64Blobs(content, location, sourceUrl, depth, scanContent)) {
    found.push(finding);
  }

  return found;
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

export function scanPageForSecrets(
  doc: NonNullable<ParsedPage["document"]>,
  pageUrl: string
): LeakedSecret[] {
  const found: LeakedSecret[] = [];
  const html = doc.toString();
  if (html) {
    found.push(...scanContent(html, "html", pageUrl));
  }
  for (const script of doc.querySelectorAll("script:not([src])")) {
    const scriptContent = script.textContent || "";
    if (scriptContent.trim()) {
      // The script's own open tag goes in front of its text, so the inline
      // pass classifies `<script id="shopify-features">{"accessToken":…}`
      // exactly as the whole-document pass does: the naming attribute is
      // the look-behind, and the value is public rather than a generic leak
      // that the rule's dedup then has to reconcile. Attributes carry no
      // findings of their own that the document pass has not already made.
      found.push(...scanContent(`${openTagOf(script)}${scriptContent}`, "inline-script", pageUrl));
    }
  }
  return found;
}

export const leakedSecretsRule: Rule = {
  meta: {
    id: "security/leaked-secrets",
    name: "Leaked Environment Variables",
    description:
      "Checks for exposed API keys, secrets, and credentials in HTML/JS",
    solution:
      "API keys and secrets exposed in client-side code can be harvested by attackers to access your services, " +
      "incur charges, or steal data. Move sensitive credentials to server-side code and use environment variables " +
      "that are NOT exposed to the browser. For frontend apps, use a backend proxy to make authenticated API calls. " +
      "Rotate any exposed credentials immediately. Consider using secret scanning tools like Gitleaks or TruffleHog " +
      "in your CI/CD pipeline to prevent future leaks.",
    category: "security",
    scope: "site",
    severity: "error",
    weight: 10,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const leakedSecrets: LeakedSecret[] = [];

    // Scan all pages' HTML and inline scripts. Streaming (#1021): the per-page
    // scan already ran at page-time — read the collected results in page order.
    // v1: scan each live `site.pages` document. Both go through scanPageForSecrets,
    // so the per-page secret list and its order are byte-identical.
    if (ctx.collectedSignals) {
      for (const rec of ctx.collectedSignals.pages) {
        leakedSecrets.push(...rec.secrets);
      }
    } else if (ctx.site?.pages) {
      for (const page of ctx.site.pages) {
        const doc = page.parsed.document;
        if (!doc) continue;
        leakedSecrets.push(...scanPageForSecrets(doc, page.url));
      }
    }

    // Scan external JavaScript files
    if (ctx.site?.scripts) {
      for (const script of ctx.site.scripts) {
        if (script.content) {
          leakedSecrets.push(
            ...scanContent(script.content, "external-script", script.url)
          );
        }
      }
    }

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
      (s) => s.publicByDesign || !s.type.startsWith("Generic ") || !publicBodies.has(quotedBodyOf(s.value))
    );

    // Public-by-design client keys are informational only — never leaks
    const publicKeys = uniqueSecrets.filter((s) => s.publicByDesign);
    // Expired tokens and session tokens: shown, never counted (#361)
    const informational = uniqueSecrets.filter(
      (s) => !s.publicByDesign && s.confidence === "info"
    );
    const realSecrets = uniqueSecrets.filter(
      (s) => !s.publicByDesign && s.confidence !== "info"
    );

    // Separate by confidence
    const highConfidence = realSecrets.filter((s) => s.confidence === "high");
    const mediumConfidence = realSecrets.filter(
      (s) => s.confidence === "medium"
    );

    // One item per finding: the pattern and masked value as the id, where it
    // was read as the label, and whatever its structure decoded to (#361) as
    // `meta`, which the JSON, LLM and XML renderers carry through verbatim.
    const item = (s: LeakedSecret): CheckItem => ({
      id: `${s.type}: ${maskSecret(s.value)}`,
      label: `Found in ${s.location}${s.sourceUrl ? ` (${s.sourceUrl})` : ""}`,
      ...(s.extra ? { meta: s.extra } : {}),
    });

    if (highConfidence.length > 0) {
      checks.push({
        name: "leaked-secrets-high",
        status: "fail",
        message: `${highConfidence.length} high-confidence leaked secret(s) detected`,
        items: highConfidence.map(item),
      });
    }

    if (mediumConfidence.length > 0) {
      checks.push({
        name: "leaked-secrets-medium",
        status: "warn",
        message: `${mediumConfidence.length} potential secret(s) detected (verify manually)`,
        items: mediumConfidence.map(item),
      });
    }

    if (publicKeys.length > 0) {
      checks.push({
        name: "leaked-secrets-public",
        status: "info",
        message: `${publicKeys.length} public client-side key(s) found (public by design — verify usage restrictions are configured)`,
        items: publicKeys.map(item),
      });
    }

    if (informational.length > 0) {
      checks.push({
        name: "leaked-secrets-info",
        status: "info",
        message: `${informational.length} expired, session-scoped or signature-bound token(s) found (informational, not counted as a leak)`,
        items: informational.map(item),
      });
    }

    if (realSecrets.length === 0) {
      checks.push({
        name: "leaked-secrets",
        status: "pass",
        message: "No leaked API keys or secrets detected",
      });
    }

    return { checks };
  },
};
