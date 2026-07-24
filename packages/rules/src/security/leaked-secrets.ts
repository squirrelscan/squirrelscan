// security/leaked-secrets - Detect leaked API keys and secrets in HTML/JS

import type { Rule, RuleContext, RuleResult, CheckResult, ParsedPage } from "../types";

import { SECRET_CONTEXT_WINDOW_SIZE } from "@squirrelscan/utils/constants";

// Secret detection patterns with service names
// Sources: secrets-patterns-db, secret-regex-list, gitleaks patterns

// Type for fast patterns (distinctive prefixes, run on all content)
type FastPattern = {
  name: string;
  pattern: RegExp;
  confidence: "high" | "medium";
  /**
   * Keys that are designed to ship in client-side code (Stripe pk_*,
   * Google browser keys, OAuth client IDs, Sentry DSNs…). Reported as an
   * informational check, never as a leak — flagging them as errors is a
   * false positive that erodes trust in the security category.
   */
  publicByDesign?: boolean;
};

// Type for context patterns (generic patterns, only run if keyword present)
// These avoid catastrophic backtracking from (?=.*keyword) lookaheads
type ContextPattern = {
  name: string;
  keyword: string; // Lowercase keyword to check via includes() first
  pattern: RegExp; // Pattern WITHOUT lookahead
  confidence: "high" | "medium";
};

// Fast patterns - have distinctive prefixes, safe to run on all content
const FAST_PATTERNS: FastPattern[] = [
  // AI/ML Services
  {
    name: "OpenAI API Key",
    pattern: /sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}/g,
    confidence: "high",
  },
  {
    name: "OpenAI API Key (proj)",
    pattern: /sk-proj-[a-zA-Z0-9_-]{80,}/g,
    confidence: "high",
  },
  {
    name: "OpenAI API Key (legacy)",
    pattern: /sk-[a-zA-Z0-9]{32,}/g,
    confidence: "medium",
  },
  {
    name: "Anthropic API Key",
    pattern: /sk-ant-[a-zA-Z0-9_-]{80,}/g,
    confidence: "high",
  },
  { name: "Groq API Key", pattern: /gsk_[a-zA-Z0-9]{52}/g, confidence: "high" },
  {
    name: "xAI (Grok) API Key",
    pattern: /xai-[a-zA-Z0-9]{48,}/g,
    confidence: "high",
  },
  {
    name: "HuggingFace Token",
    pattern: /hf_[a-zA-Z0-9]{34}/g,
    confidence: "high",
  },
  {
    name: "Replicate API Token",
    pattern: /r8_[a-zA-Z0-9]{37}/g,
    confidence: "high",
  },
  {
    name: "Perplexity API Key",
    pattern: /pplx-[a-zA-Z0-9]{48}/g,
    confidence: "high",
  },

  // Database/Backend Services
  {
    // Anon keys are public by design — Row Level Security is the guard
    name: "Supabase Anon Key",
    pattern: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]{100,}/g,
    confidence: "medium",
    publicByDesign: true,
  },
  {
    name: "Supabase Service Role Key",
    pattern: /sbp_[a-f0-9]{40}/g,
    confidence: "high",
  },
  {
    name: "MongoDB Connection String",
    pattern: /mongodb(\+srv)?:\/\/[^\s"'<>]+/gi,
    confidence: "high",
  },
  {
    name: "PostgreSQL Connection String",
    pattern: /postgres(ql)?:\/\/[^\s"'<>]+/gi,
    confidence: "high",
  },
  {
    name: "MySQL Connection String",
    pattern: /mysql:\/\/[^\s"'<>]+/gi,
    confidence: "high",
  },
  {
    name: "Redis Connection String",
    pattern: /redis(s)?:\/\/[^\s"'<>]+/gi,
    confidence: "high",
  },
  {
    name: "PlanetScale Token",
    pattern: /pscale_tkn_[a-zA-Z0-9_-]{32,}/g,
    confidence: "high",
  },
  {
    name: "Neon Database Token",
    pattern: /neon_[a-zA-Z0-9_-]{32,}/g,
    confidence: "high",
  },

  // Payment Services
  {
    name: "Stripe Live Key",
    pattern: /sk_live_[0-9a-zA-Z]{24,}/g,
    confidence: "high",
  },
  {
    name: "Stripe Test Key",
    pattern: /sk_test_[0-9a-zA-Z]{24,}/g,
    confidence: "high",
  },
  {
    // pk_live_/pk_test_ are public by design (Stripe docs)
    name: "Stripe Publishable Key",
    pattern: /pk_live_[0-9a-zA-Z]{24,}/g,
    confidence: "medium",
    publicByDesign: true,
  },
  {
    // OAuth client IDs are public identifiers, not secrets
    name: "PayPal Client ID",
    pattern: /[Aa][Zz][Aa-zZ0-9-_]{60,}/g,
    confidence: "medium",
    publicByDesign: true,
  },
  {
    name: "Square Access Token",
    pattern: /sq0atp-[0-9A-Za-z_-]{22}/g,
    confidence: "high",
  },
  {
    name: "Square OAuth Secret",
    pattern: /sq0csp-[0-9A-Za-z_-]{43}/g,
    confidence: "high",
  },

  // Cloud Providers
  {
    name: "AWS Access Key ID",
    pattern: /(A3T[A-Z0-9]|AKIA|AGPA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
    confidence: "high",
  },
  {
    name: "AWS Secret Access Key",
    // Require at least "aws" or "secret" keyword before the value
    pattern:
      /(?:aws[_-]?(?:secret)?[_-]?(?:access)?[_-]?key|secret[_-]?access[_-]?key)['"]?\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi,
    confidence: "medium",
  },
  {
    // AIza… keys in frontend code are Maps/Firebase browser keys — meant to
    // be embedded; protection comes from referrer/API restrictions, not
    // secrecy (Firebase docs say these are not secrets)
    name: "Google API Key (browser)",
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    confidence: "high",
    publicByDesign: true,
  },
  {
    // OAuth client IDs are public identifiers, not secrets
    name: "Google OAuth Client ID",
    pattern: /[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com/g,
    confidence: "high",
    publicByDesign: true,
  },
  {
    name: "Google OAuth Access Token",
    pattern: /ya29\.[0-9A-Za-z_-]+/g,
    confidence: "high",
  },
  {
    name: "Azure Storage Key",
    pattern:
      /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+;/gi,
    confidence: "high",
  },
  {
    name: "DigitalOcean Token",
    pattern: /dop_v1_[a-f0-9]{64}/g,
    confidence: "high",
  },
  {
    name: "DigitalOcean Spaces Key",
    pattern: /DO[A-Z0-9]{20,}/g,
    confidence: "medium",
  },

  // Hosting/Deployment
  {
    name: "Vercel Token",
    pattern: /vercel_[a-zA-Z0-9]{24}/gi,
    confidence: "high",
  },
  {
    name: "Netlify Token",
    pattern: /nfp_[a-zA-Z0-9]{40,}/g,
    confidence: "high",
  },
  {
    name: "Render API Key",
    pattern: /rnd_[a-zA-Z0-9]{32,}/g,
    confidence: "high",
  },
  {
    name: "Railway Token",
    pattern: /railway_[a-zA-Z0-9_-]{32,}/g,
    confidence: "high",
  },

  // Version Control
  {
    name: "GitHub Personal Access Token",
    pattern: /ghp_[0-9a-zA-Z]{36}/g,
    confidence: "high",
  },
  {
    name: "GitHub OAuth Token",
    pattern: /gho_[0-9a-zA-Z]{36}/g,
    confidence: "high",
  },
  {
    name: "GitHub App Token",
    pattern: /ghu_[0-9a-zA-Z]{36}/g,
    confidence: "high",
  },
  {
    name: "GitHub Refresh Token",
    pattern: /ghr_[0-9a-zA-Z]{36}/g,
    confidence: "high",
  },
  {
    name: "GitLab Personal Access Token",
    pattern: /glpat-[a-zA-Z0-9_-]{20,}/g,
    confidence: "high",
  },
  {
    name: "GitLab Pipeline Token",
    pattern: /glptt-[a-f0-9]{40}/g,
    confidence: "high",
  },
  {
    name: "Bitbucket App Password",
    pattern: /ATBB[a-zA-Z0-9]{32}/g,
    confidence: "high",
  },

  // Communication
  {
    name: "Slack Token",
    pattern: /xox[baprs]-[0-9a-zA-Z-]{10,72}/g,
    confidence: "high",
  },
  {
    name: "Slack Webhook",
    pattern:
      /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9_]+\/B[a-zA-Z0-9_]+\/[a-zA-Z0-9_]+/g,
    confidence: "high",
  },
  {
    name: "Discord Webhook",
    pattern:
      /https:\/\/discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
    confidence: "high",
  },
  {
    name: "Discord Bot Token",
    pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/g,
    confidence: "high",
  },
  {
    name: "Telegram Bot Token",
    pattern: /[0-9]{8,10}:[a-zA-Z0-9_-]{35}/g,
    confidence: "high",
  },

  // Email Services
  {
    name: "Twilio Account SID",
    pattern: /AC[0-9a-f]{32}/g,
    confidence: "high",
  },
  {
    name: "SendGrid API Key",
    pattern: /SG\.[a-zA-Z0-9_-]{20,24}\.[a-zA-Z0-9_-]{39,50}/g,
    confidence: "high",
  },
  {
    name: "Mailgun API Key",
    pattern: /key-[0-9a-zA-Z]{32}/g,
    confidence: "high",
  },
  {
    name: "Mailchimp API Key",
    pattern: /[0-9a-f]{32}-us[0-9]{1,2}/g,
    confidence: "high",
  },
  {
    name: "Resend API Key",
    pattern: /re_[a-zA-Z0-9]{32,}/g,
    confidence: "high",
  },

  // Analytics/Monitoring
  {
    // DSNs are designed for client-side error reporting
    name: "Sentry DSN",
    pattern: /https:\/\/[a-f0-9]+@[a-z0-9]+\.ingest\.sentry\.io\/[0-9]+/gi,
    confidence: "high",
    publicByDesign: true,
  },
  {
    name: "New Relic License Key",
    pattern: /[A-Z0-9]{40}NRAL/g,
    confidence: "high",
  },

  // Auth Services
  {
    name: "Clerk Secret Key",
    pattern: /sk_live_[a-zA-Z0-9]{40,}/g,
    confidence: "high",
  },

  // Maps/Location
  {
    // pk.* tokens are Mapbox public tokens (sk.* are the secret ones)
    name: "Mapbox Access Token",
    pattern: /pk\.[a-zA-Z0-9]{60,}/g,
    confidence: "high",
    publicByDesign: true,
  },
  {
    name: "Mapbox Secret Token",
    pattern: /sk\.[a-zA-Z0-9]{60,}/g,
    confidence: "high",
  },

  // CMS/Services
  {
    name: "Sanity Token",
    pattern: /sk[a-zA-Z0-9]{30,}/g,
    confidence: "medium",
  },

  // Crypto Keys
  {
    name: "Private Key (RSA)",
    pattern: /-----BEGIN RSA PRIVATE KEY-----/g,
    confidence: "high",
  },
  {
    name: "Private Key (DSA)",
    pattern: /-----BEGIN DSA PRIVATE KEY-----/g,
    confidence: "high",
  },
  {
    name: "Private Key (EC)",
    pattern: /-----BEGIN EC PRIVATE KEY-----/g,
    confidence: "high",
  },
  {
    name: "Private Key (OpenSSH)",
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g,
    confidence: "high",
  },
  {
    name: "Private Key (PGP)",
    pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
    confidence: "high",
  },

  // Social/OAuth
  {
    name: "Facebook Access Token",
    pattern: /EAACEdEose0cBA[0-9A-Za-z]+/g,
    confidence: "high",
  },
  {
    name: "Twitter Bearer Token",
    pattern: /AAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+/g,
    confidence: "high",
  },

  // Generic patterns (lower confidence, check context)
  {
    name: "Generic API Key Assignment",
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/gi,
    confidence: "medium",
  },
  {
    name: "Generic Secret Assignment",
    pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    confidence: "medium",
  },
  {
    name: "Generic Token Assignment",
    pattern:
      /(?:access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/gi,
    confidence: "medium",
  },
  {
    name: "Bearer Token",
    pattern: /Bearer\s+[a-zA-Z0-9_-]{20,}/g,
    confidence: "medium",
  },
  {
    name: "Basic Auth Header",
    pattern: /Basic\s+[A-Za-z0-9+/=]{20,}/g,
    confidence: "medium",
  },
];

// Context patterns - generic patterns that need keyword presence check first
// These previously used (?=.*keyword) lookaheads which caused O(n²) backtracking
// Now we check for keyword via fast includes() before running the regex
const CONTEXT_PATTERNS: ContextPattern[] = [
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
    name: "Mixpanel Token",
    keyword: "mixpanel",
    pattern: /[a-f0-9]{32}/gi,
    confidence: "medium",
  },
  {
    name: "Amplitude API Key",
    keyword: "amplitude",
    pattern: /[a-f0-9]{32}/gi,
    confidence: "medium",
  },
  {
    name: "LogRocket App ID",
    keyword: "logrocket",
    pattern: /[a-z0-9]{6}\/[a-z0-9-]+/gi,
    confidence: "medium",
  },

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
];

// False positive filters - common non-sensitive patterns
const FALSE_POSITIVE_PATTERNS = [
  // Google tag IDs (GTM containers, GA4/UA measurement IDs, Ads/DC tags)
  // are public identifiers — never secrets, whatever pattern caught them
  /^(GTM|G|UA|AW|DC)-[A-Z0-9-]+$/i,
  /example\.com/i,
  /placeholder/i,
  /your[_-]?api[_-]?key/i,
  /xxx+/i,
  /test[_-]?key/i,
  /demo[_-]?key/i,
  /sample/i,
  /dummy/i,
  /fake/i,
  /0{16,}/,
  /1{16,}/,
  /a{16,}/i,
];

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

  return false;
}

export interface LeakedSecret {
  type: string;
  value: string;
  confidence: "high" | "medium";
  publicByDesign: boolean;
  location: "html" | "inline-script" | "external-script";
  sourceUrl?: string; // URL of the script file or page
}

function isLikelyFalsePositive(value: string): boolean {
  return FALSE_POSITIVE_PATTERNS.some((pattern) => pattern.test(value));
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

// Extract windows around all keyword occurrences
function extractKeywordWindows(
  content: string,
  contentLower: string,
  keyword: string
): string[] {
  const windows: string[] = [];
  let pos = 0;

  while ((pos = contentLower.indexOf(keyword, pos)) !== -1) {
    const start = Math.max(0, pos - SECRET_CONTEXT_WINDOW_SIZE);
    const end = Math.min(
      content.length,
      pos + keyword.length + SECRET_CONTEXT_WINDOW_SIZE
    );
    windows.push(content.slice(start, end));
    pos += keyword.length;
  }

  return windows;
}

export function scanContent(
  content: string,
  location: "html" | "inline-script" | "external-script",
  sourceUrl?: string
): LeakedSecret[] {
  const found: LeakedSecret[] = [];
  const seenValues = new Set<string>();

  // A later (more generic) pattern re-matching a value an earlier (more
  // specific) pattern already classified — e.g. apiKey:"AIza…" catching the
  // AIza key the public-by-design tier reported — is a duplicate, not a new
  // finding. Specific patterns run first, so first classification wins.
  const overlapsSeenValue = (value: string): boolean => {
    for (const seen of seenValues) {
      if (value.includes(seen) || seen.includes(value)) {
        return true;
      }
    }
    return false;
  };

  // Helper to process regex matches on given text
  const processMatches = (
    text: string,
    name: string,
    pattern: RegExp,
    confidence: "high" | "medium",
    publicByDesign: boolean
  ) => {
    // Reset pattern state for global regex
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[0];

      // Skip duplicates, overlapping rematches, and false positives
      if (
        seenValues.has(value) ||
        overlapsSeenValue(value) ||
        isLikelyFalsePositive(value)
      ) {
        continue;
      }

      seenValues.add(value);
      found.push({
        type: name,
        value,
        confidence,
        publicByDesign,
        location,
        sourceUrl,
      });
    }
  };

  // Pass 1: Run all fast patterns (distinctive prefixes, O(n) safe)
  for (const { name, pattern, confidence, publicByDesign } of FAST_PATTERNS) {
    processMatches(content, name, pattern, confidence, publicByDesign ?? false);
  }

  // Pass 2: Run context patterns only on windows around keyword occurrences
  // This avoids scanning the entire content with generic patterns like /[a-f0-9]{32}/
  // Additional filtering: require assignment context and filter code identifiers
  const contentLower = content.toLowerCase();
  for (const { name, keyword, pattern, confidence } of CONTEXT_PATTERNS) {
    // Extract small windows around each keyword occurrence
    const windows = extractKeywordWindows(content, contentLower, keyword);
    if (windows.length === 0) continue;

    // Only scan the windows, not the entire content
    for (const window of windows) {
      // Reset pattern state for global regex
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(window)) !== null) {
        const value = match[0];

        // Skip duplicates, overlapping rematches, and false positives
        if (
          seenValues.has(value) ||
          overlapsSeenValue(value) ||
          isLikelyFalsePositive(value)
        ) {
          continue;
        }

        // Skip values that look like code identifiers (function/variable names)
        if (looksLikeCodeIdentifier(value)) {
          continue;
        }

        // For context patterns, require the value to be in a value position
        // (assigned via = or :) to reduce false positives from array elements
        if (!isInValuePosition(window, value, match.index)) {
          continue;
        }

        seenValues.add(value);
        found.push({
          type: name,
          value,
          confidence,
          publicByDesign: false,
          location,
          sourceUrl,
        });
      }
    }
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
      found.push(...scanContent(scriptContent, "inline-script", pageUrl));
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

    // Deduplicate by value (same secret may appear in multiple places)
    const uniqueSecrets = Array.from(
      new Map(leakedSecrets.map((s) => [s.value, s])).values()
    );

    // Public-by-design client keys are informational only — never leaks
    const publicKeys = uniqueSecrets.filter((s) => s.publicByDesign);
    const realSecrets = uniqueSecrets.filter((s) => !s.publicByDesign);

    // Separate by confidence
    const highConfidence = realSecrets.filter((s) => s.confidence === "high");
    const mediumConfidence = realSecrets.filter(
      (s) => s.confidence === "medium"
    );

    if (highConfidence.length > 0) {
      checks.push({
        name: "leaked-secrets-high",
        status: "fail",
        message: `${highConfidence.length} high-confidence leaked secret(s) detected`,
        items: highConfidence.map((s) => ({
          id: `${s.type}: ${maskSecret(s.value)}`,
          label: `Found in ${s.location}${s.sourceUrl ? ` (${s.sourceUrl})` : ""}`,
        })),
      });
    }

    if (mediumConfidence.length > 0) {
      checks.push({
        name: "leaked-secrets-medium",
        status: "warn",
        message: `${mediumConfidence.length} potential secret(s) detected (verify manually)`,
        items: mediumConfidence.map((s) => ({
          id: `${s.type}: ${maskSecret(s.value)}`,
          label: `Found in ${s.location}${s.sourceUrl ? ` (${s.sourceUrl})` : ""}`,
        })),
      });
    }

    if (publicKeys.length > 0) {
      checks.push({
        name: "leaked-secrets-public",
        status: "info",
        message: `${publicKeys.length} public client-side key(s) found (public by design — verify usage restrictions are configured)`,
        items: publicKeys.map((s) => ({
          id: `${s.type}: ${maskSecret(s.value)}`,
          label: `Found in ${s.location}${s.sourceUrl ? ` (${s.sourceUrl})` : ""}`,
        })),
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
