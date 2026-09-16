// One generator per pattern in security/leaked-secrets. Every value is built at
// runtime from parts and a seeded RNG: nothing in this file is a whole
// credential-shaped literal, so neither GitHub push protection nor the
// detect-secrets CI gate has anything to trip on, and nothing here is a real
// key. Provider "EXAMPLE" keys are deliberately NOT used: the detector's
// false-positive list suppresses them, so they would prove nothing.
//
// Three tiers, because the patterns want three different things from a page:
//
// - `prefixed`   the value carries its own marker (`ghp_`, `AKIA`, a PEM
//                header, a URL host). It fires wherever it appears.
// - `keyed`      a bare shape (`[a-f0-9]{32}`) that only fires inside a window
//                around a brand keyword AND under a key that says credential.
//                The generator's `keyName` is that key; contexts spell it in
//                their own syntax (`cohereKey`, `COHERE_KEY`, `cohere-key`).
// - `assignment` the pattern includes the key in its own match (`apiKey:"…"`,
//                `aws_secret_access_key = "…"`, `Bearer …`). The generator
//                emits the whole JSON entry `"key":"value"`; contexts that hold
//                object entries drop it in as-is.

export type Tier = "prefixed" | "keyed" | "assignment";

export interface Generated {
  /** The text a context embeds. For `assignment` this is a JSON entry. */
  text: string;
  /** The sensitive core. The masked report must never contain this. */
  secret: string;
}

export interface Generator {
  /** Exact `name` of the FAST_PATTERNS / CONTEXT_PATTERNS entry. */
  pattern: string;
  tier: Tier;
  /** Object key a `keyed` value is assigned to. Ignored for the other tiers. */
  keyName?: string;
  /**
   * Context ids this value never realistically appears in: a connection
   * string is not a Bearer token and a PEM block is not a sourcemap query
   * parameter. Such pairings are interaction probes, not positives.
   */
  notIn?: string[];
  make: (r: Rng) => Generated;
}

export type Rng = () => number;

/** mulberry32: small, seedable, good enough for shapes. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT = "0123456789";
const HEX = "0123456789abcdef";
const ALNUM = LOWER + UPPER + DIGIT;
const B64 = ALNUM + "+/";
const B64URL = ALNUM + "-_";

export function runOf(r: Rng, alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(r() * alphabet.length)];
  return out;
}

/**
 * Mixed-case alphanumerics with an uppercase B–Y guaranteed every 8th
 * character. Two patterns run EARLY and greedily over exactly this shape:
 * PayPal's `[Aa][Zz][Aa-zZ0-9-_]{60,}` (whose class omits B–Y) and DigitalOcean
 * Spaces' `DO[A-Z0-9]{20,}`. A long run without a B–Y letter lets PayPal claim
 * a substring of a later, more specific key, and the overlap filter then drops
 * the real one. Real base64 has B–Y letters constantly, so this is the
 * realistic shape; the gap is pinned separately in cases.ts.
 */
export function mixedRun(r: Rng, n: number, alphabet = ALNUM): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out +=
      i % 8 === 3
        ? UPPER[1 + Math.floor(r() * 24)] // B..Y
        : alphabet[Math.floor(r() * alphabet.length)];
  }
  return out;
}

/**
 * A `keyed` value that survives looksLikeCodeIdentifier: a leading digit
 * (defeats the `^(get|set|is|on|…)` and `^[a-z]+[A-Z]` tests) and no `_`
 * next to a lowercase letter (defeats the snake_case test). The values that
 * FAIL those tests are real-looking too, and cases.ts pins them as known gaps.
 */
function keyedRun(r: Rng, alphabet: string, n: number): string {
  return runOf(r, DIGIT, 1) + runOf(r, alphabet.replace(/[_-]/g, ""), n - 1);
}

function upperNoDo(r: Rng, n: number): string {
  // `DO` opens the DigitalOcean Spaces pattern, which runs before New Relic.
  let out = runOf(r, UPPER + DIGIT, n);
  while (out.includes("DO")) out = out.replace("DO", "D" + runOf(r, "ABCEFGHJKLMNPQRSTUVWXYZ", 1));
  return out;
}

/** A UUID v4: version nibble 4, variant nibble 8–b. */
function uuid(r: Rng): string {
  const [a, b, c, d, e] = [8, 4, 3, 3, 12].map((n) => runOf(r, HEX, n));
  return `${a}-${b}-4${c}-${runOf(r, "89ab", 1)}${d}-${e}`;
}

function bytes(r: Rng, n: number): Buffer {
  return Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256)));
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** A structurally valid HS256 JWT: real header, JSON payload, random signature. */
function jwt(r: Rng, payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${b64url(bytes(r, 32))}`;
}

/** Supabase's JWT claims. `role` is the only thing telling anon from service_role. */
export function supabaseJwt(r: Rng, role: "anon" | "service_role"): string {
  return jwt(r, { iss: "supabase", ref: runOf(r, LOWER, 20), role, iat: 1700000000, exp: 2000000000 });
}

/**
 * A Mapbox token: `pk.` or `sk.` + base64url JSON claims + `.` + signature.
 * The detector wants 60 alphanumerics after the dot, and base64url of JSON can
 * carry `-`/`_`; the claims are re-drawn until the encoding is plain
 * alphanumeric, which a real token's encoding usually is at this length.
 */
function mapboxToken(r: Rng, kind: "pk" | "sk"): string {
  for (;;) {
    const claims = b64url(JSON.stringify({ u: "acme-maps", a: `cm${runOf(r, LOWER + DIGIT, 24)}` }));
    if (/^[a-zA-Z0-9]{60,}$/.test(claims)) return `${kind}.${claims}.${runOf(r, B64URL, 22)}`;
  }
}

const NOT_A_BEARER = ["fetch-bearer-header", "sourcemap-comment"];

const value = (secret: string, text = secret): Generated => ({ text, secret });
const entry = (key: string, secret: string, wrap = (s: string) => s): Generated => ({
  text: `${JSON.stringify(key)}:${JSON.stringify(wrap(secret))}`,
  secret,
});

// Prefixes are split so no line of this file reads as a whole token.
const P = {
  sk: ["s", "k-"].join(""),
  skProj: ["s", "k-pr", "oj-"].join(""),
  skAnt: ["s", "k-a", "nt-"].join(""),
  gsk: ["g", "sk_"].join(""),
  hf: ["h", "f_"].join(""),
  r8: ["r", "8_"].join(""),
  pplx: ["pp", "lx-"].join(""),
  sbp: ["sb", "p_"].join(""),
  pscale: ["psca", "le_tkn_"].join(""),
  skLive: ["s", "k_li", "ve_"].join(""),
  skTest: ["s", "k_te", "st_"].join(""),
  pkLive: ["p", "k_li", "ve_"].join(""),
  sq0atp: ["sq0", "atp-"].join(""),
  sq0csp: ["sq0", "csp-"].join(""),
  akia: ["AK", "IA"].join(""),
  aiza: ["AI", "za"].join(""),
  ya29: ["ya", "29."].join(""),
  dopV1: ["do", "p_v1_"].join(""),
  nfp: ["nf", "p_"].join(""),
  rnd: ["rn", "d_"].join(""),
  ghp: ["gh", "p_"].join(""),
  gho: ["gh", "o_"].join(""),
  ghu: ["gh", "u_"].join(""),
  ghr: ["gh", "r_"].join(""),
  glpat: ["glp", "at-"].join(""),
  glptt: ["glp", "tt-"].join(""),
  atbb: ["AT", "BB"].join(""),
  xoxb: ["xo", "xb-"].join(""),
  sg: ["S", "G."].join(""),
  mailgun: ["ke", "y-"].join(""),
  re: ["r", "e_"].join(""),
  nral: ["NR", "AL"].join(""),
  eaac: ["EAACEd", "Eose0cBA"].join(""),
  pem: (kind: string, suffix = "") => ["-----BEGIN ", kind, " PRIVATE KEY", suffix, "-----"].join(""),
};

/**
 * The detector's FALSE_POSITIVE_PATTERNS, mirrored. They are substring tests
 * over the whole matched value, so a random key that happens to contain `xxx`
 * or `fake` is dropped; a generator that produced one would make a positive
 * case silently empty. cases.ts redraws such values and pins the behaviour
 * itself as a probe.
 */
export const FALSE_POSITIVE_MIRROR: Array<(value: string) => boolean> = [
  (v) => /^(GTM|G|UA|AW|DC)-[A-Z0-9-]+$/i.test(v),
  // The detector's `/example\.com/i` is a substring test, not a host check.
  (v) => v.toLowerCase().includes("example.com"),
  ...[
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
  ].map((re) => (v: string) => re.test(v)),
];

export const tripsFalsePositiveFilter = (value: string) =>
  FALSE_POSITIVE_MIRROR.some((test) => test(value));

export const GENERATORS: Generator[] = [
  // ── AI/ML ──────────────────────────────────────────────────────────────
  {
    pattern: "OpenAI API Key",
    tier: "prefixed",
    make: (r) => value(P.sk + runOf(r, ALNUM, 20) + "T3BlbkFJ" + runOf(r, ALNUM, 20)),
  },
  {
    pattern: "OpenAI API Key (proj)",
    tier: "prefixed",
    make: (r) => value(P.skProj + mixedRun(r, 96, B64URL)),
  },
  {
    pattern: "OpenAI API Key (legacy)",
    tier: "prefixed",
    make: (r) => value(P.sk + runOf(r, ALNUM, 48)),
  },
  {
    pattern: "Anthropic API Key",
    tier: "prefixed",
    make: (r) => value(P.skAnt + "api03-" + mixedRun(r, 90, B64URL) + "AA"),
  },
  { pattern: "Groq API Key", tier: "prefixed", make: (r) => value(P.gsk + runOf(r, ALNUM, 52)) },
  {
    pattern: "xAI (Grok) API Key",
    tier: "prefixed",
    make: (r) => value("xai-" + runOf(r, ALNUM, 80)),
  },
  { pattern: "HuggingFace Token", tier: "prefixed", make: (r) => value(P.hf + runOf(r, ALNUM, 34)) },
  {
    pattern: "Replicate API Token",
    tier: "prefixed",
    make: (r) => value(P.r8 + runOf(r, ALNUM, 37)),
  },
  {
    pattern: "Perplexity API Key",
    tier: "prefixed",
    make: (r) => value(P.pplx + runOf(r, ALNUM, 48)),
  },

  // ── Database / backend ────────────────────────────────────────────────
  {
    pattern: "Supabase Anon Key",
    tier: "prefixed",
    make: (r) => value(supabaseJwt(r, "anon")),
  },
  {
    // The detector's `sbp_` shape is a Supabase personal access token, not the
    // service-role key (which is a JWT with role=service_role; see the probe
    // in cases.ts). Kept under the detector's own name.
    pattern: "Supabase Service Role Key",
    tier: "prefixed",
    make: (r) => value(P.sbp + runOf(r, HEX, 40)),
  },
  {
    pattern: "MongoDB Connection String",
    tier: "prefixed",
    notIn: NOT_A_BEARER,
    make: (r) => {
      const pw = runOf(r, ALNUM, 18);
      return value(pw, `mongodb+srv://app_user:${pw}@cluster0.${runOf(r, LOWER, 5)}.mongodb.net/prod?retryWrites=true`);
    },
  },
  {
    pattern: "PostgreSQL Connection String",
    tier: "prefixed",
    notIn: NOT_A_BEARER,
    make: (r) => {
      const pw = runOf(r, ALNUM, 18);
      return value(pw, `postgresql://app:${pw}@db-${runOf(r, LOWER, 6)}.internal:5432/app`);
    },
  },
  {
    pattern: "MySQL Connection String",
    tier: "prefixed",
    notIn: NOT_A_BEARER,
    make: (r) => {
      const pw = runOf(r, ALNUM, 18);
      return value(pw, `mysql://root:${pw}@10.0.${Math.floor(r() * 250)}.12:3306/shop`);
    },
  },
  {
    pattern: "Redis Connection String",
    tier: "prefixed",
    notIn: NOT_A_BEARER,
    make: (r) => {
      const pw = runOf(r, ALNUM, 24);
      return value(pw, `rediss://default:${pw}@redis-${runOf(r, DIGIT, 5)}.upstash.io:6379`);
    },
  },
  {
    pattern: "PlanetScale Token",
    tier: "prefixed",
    make: (r) => value(P.pscale + mixedRun(r, 43, B64URL)),
  },
  {
    pattern: "Neon Database Token",
    tier: "prefixed",
    make: (r) => value("neon_" + mixedRun(r, 40, B64URL)),
  },

  // ── Payments ──────────────────────────────────────────────────────────
  {
    pattern: "Stripe Live Key",
    tier: "prefixed",
    make: (r) => value(P.skLive + runOf(r, ALNUM, 24)),
  },
  {
    pattern: "Stripe Test Key",
    tier: "prefixed",
    // A leading digit keeps `test_` from being followed by `key`, which the
    // false-positive list would otherwise read as a test key.
    make: (r) => value(P.skTest + runOf(r, DIGIT, 1) + runOf(r, ALNUM, 23)),
  },
  {
    pattern: "Stripe Publishable Key",
    tier: "prefixed",
    make: (r) => value(P.pkLive + runOf(r, ALNUM, 24)),
  },
  {
    pattern: "PayPal Client ID",
    tier: "prefixed",
    // Real PayPal client ids are mixed case. The pattern's character class
    // omits B–Y, so a faithful one never fires; this one is shaped to fire and
    // the faithful one is pinned as a gap in cases.ts.
    make: (r) => value("AZ" + runOf(r, LOWER + DIGIT + "_-", 78)),
  },
  {
    pattern: "Square Access Token",
    tier: "prefixed",
    make: (r) => value(P.sq0atp + runOf(r, B64URL, 22)),
  },
  {
    pattern: "Square OAuth Secret",
    tier: "prefixed",
    make: (r) => value(P.sq0csp + runOf(r, B64URL, 43)),
  },

  // ── Cloud ─────────────────────────────────────────────────────────────
  {
    pattern: "AWS Access Key ID",
    tier: "prefixed",
    make: (r) => value(P.akia + upperNoDo(r, 16)),
  },
  {
    pattern: "AWS Secret Access Key",
    tier: "assignment",
    make: (r) => entry("aws_secret_access_key", mixedRun(r, 40, B64)),
  },
  {
    pattern: "Google API Key (browser)",
    tier: "prefixed",
    make: (r) => value(P.aiza + runOf(r, B64URL, 35)),
  },
  {
    pattern: "Google OAuth Client ID",
    tier: "prefixed",
    notIn: NOT_A_BEARER,
    make: (r) =>
      value(`${runOf(r, DIGIT, 12)}-${runOf(r, LOWER + DIGIT, 32)}.apps.googleusercontent.com`),
  },
  {
    pattern: "Google OAuth Access Token",
    tier: "prefixed",
    make: (r) => value(P.ya29 + mixedRun(r, 120, B64URL)),
  },
  {
    pattern: "Azure Storage Key",
    tier: "prefixed",
    notIn: NOT_A_BEARER,
    make: (r) => {
      const key = bytes(r, 64).toString("base64"); // 88 chars, canonical `==`
      return value(
        key,
        `DefaultEndpointsProtocol=https;AccountName=${runOf(r, LOWER, 10)};AccountKey=${key};EndpointSuffix=core.windows.net`,
      );
    },
  },
  {
    pattern: "DigitalOcean Token",
    tier: "prefixed",
    make: (r) => value(P.dopV1 + runOf(r, HEX, 64)),
  },
  {
    pattern: "DigitalOcean Spaces Key",
    tier: "prefixed",
    make: (r) => value("DO" + upperNoDo(r, 20)),
  },

  // ── Hosting ───────────────────────────────────────────────────────────
  { pattern: "Vercel Token", tier: "prefixed", make: (r) => value("vercel_" + runOf(r, ALNUM, 24)) },
  { pattern: "Netlify Token", tier: "prefixed", make: (r) => value(P.nfp + runOf(r, ALNUM, 43)) },
  { pattern: "Render API Key", tier: "prefixed", make: (r) => value(P.rnd + runOf(r, ALNUM, 36)) },
  {
    pattern: "Railway Token",
    tier: "prefixed",
    make: (r) => value("railway_" + uuid(r).replace(/-/g, "") + runOf(r, HEX, 4)),
  },

  // ── Version control ───────────────────────────────────────────────────
  {
    pattern: "GitHub Personal Access Token",
    tier: "prefixed",
    make: (r) => value(P.ghp + runOf(r, ALNUM, 36)),
  },
  { pattern: "GitHub OAuth Token", tier: "prefixed", make: (r) => value(P.gho + runOf(r, ALNUM, 36)) },
  { pattern: "GitHub App Token", tier: "prefixed", make: (r) => value(P.ghu + runOf(r, ALNUM, 36)) },
  {
    pattern: "GitHub Refresh Token",
    tier: "prefixed",
    make: (r) => value(P.ghr + runOf(r, ALNUM, 36)),
  },
  {
    pattern: "GitLab Personal Access Token",
    tier: "prefixed",
    make: (r) => value(P.glpat + mixedRun(r, 20, B64URL)),
  },
  {
    pattern: "GitLab Pipeline Token",
    tier: "prefixed",
    make: (r) => value(P.glptt + runOf(r, HEX, 40)),
  },
  {
    pattern: "Bitbucket App Password",
    tier: "prefixed",
    make: (r) => value(P.atbb + runOf(r, ALNUM, 32)),
  },

  // ── Communication ─────────────────────────────────────────────────────
  {
    pattern: "Slack Token",
    tier: "prefixed",
    make: (r) =>
      value(`${P.xoxb}${runOf(r, DIGIT, 12)}-${runOf(r, DIGIT, 13)}-${runOf(r, ALNUM, 24)}`),
  },
  {
    pattern: "Slack Webhook",
    tier: "prefixed",
    notIn: NOT_A_BEARER,
    make: (r) =>
      value(
        `https://hooks.slack.com/services/T${runOf(r, UPPER + DIGIT, 8)}/B${runOf(r, UPPER + DIGIT, 10)}/${runOf(r, ALNUM, 24)}`,
      ),
  },
  {
    pattern: "Discord Webhook",
    tier: "prefixed",
    notIn: NOT_A_BEARER,
    make: (r) =>
      value(`https://discord.com/api/webhooks/${runOf(r, DIGIT, 19)}/${mixedRun(r, 68, B64URL)}`),
  },
  {
    pattern: "Discord Bot Token",
    tier: "prefixed",
    // base64url(user snowflake).base64url(timestamp).hmac — the first part of
    // a real one decodes to a decimal id, which is what puts the `M` there.
    make: (r) => value(`${b64url(`1${runOf(r, DIGIT, 17)}`)}.${runOf(r, B64URL, 6)}.${runOf(r, B64URL, 27)}`),
  },
  {
    pattern: "Telegram Bot Token",
    tier: "prefixed",
    make: (r) => value(`${runOf(r, "123456789", 1)}${runOf(r, DIGIT, 9)}:${runOf(r, B64URL, 35)}`),
  },

  // ── Email ─────────────────────────────────────────────────────────────
  { pattern: "Twilio Account SID", tier: "prefixed", make: (r) => value("AC" + runOf(r, HEX, 32)) },
  {
    pattern: "SendGrid API Key",
    tier: "prefixed",
    make: (r) => value(`${P.sg}${runOf(r, B64URL, 22)}.${runOf(r, B64URL, 43)}`),
  },
  {
    pattern: "Mailgun API Key",
    tier: "prefixed",
    make: (r) => value(P.mailgun + runOf(r, LOWER + DIGIT, 32)),
  },
  {
    pattern: "Mailchimp API Key",
    tier: "prefixed",
    make: (r) => value(`${runOf(r, HEX, 32)}-us${1 + Math.floor(r() * 20)}`),
  },
  { pattern: "Resend API Key", tier: "prefixed", make: (r) => value(P.re + runOf(r, ALNUM, 32)) },

  // ── Analytics / monitoring ────────────────────────────────────────────
  {
    pattern: "Sentry DSN",
    tier: "prefixed",
    notIn: NOT_A_BEARER,
    make: (r) =>
      value(`https://${runOf(r, HEX, 32)}@o${runOf(r, DIGIT, 6)}.ingest.sentry.io/${runOf(r, DIGIT, 7)}`),
  },
  {
    pattern: "New Relic License Key",
    tier: "prefixed",
    make: (r) => value(upperNoDo(r, 40) + P.nral),
  },

  // ── Auth ──────────────────────────────────────────────────────────────
  {
    pattern: "Clerk Secret Key",
    tier: "prefixed",
    // Same prefix as Stripe Live, 40+ chars. Stripe runs first and claims it;
    // cases.ts expects "Stripe Live Key" and records the gap.
    make: (r) => value(P.skLive + runOf(r, ALNUM, 44)),
  },

  // ── Maps ──────────────────────────────────────────────────────────────
  {
    pattern: "Mapbox Access Token",
    tier: "prefixed",
    make: (r) => value(mapboxToken(r, "pk")),
  },
  {
    pattern: "Mapbox Secret Token",
    tier: "prefixed",
    make: (r) => value(mapboxToken(r, "sk")),
  },

  // ── CMS ───────────────────────────────────────────────────────────────
  {
    pattern: "Sanity Token",
    tier: "prefixed",
    make: (r) => value("sk" + runOf(r, ALNUM, 48)),
  },

  // ── Private keys ──────────────────────────────────────────────────────
  ...(["RSA", "DSA", "EC", "OpenSSH", "PGP"] as const).map(
    (kind): Generator => ({
      pattern: `Private Key (${kind})`,
      tier: "prefixed",
      notIn: NOT_A_BEARER,
      // Header-only probes: the detector matches the armour line, so the body
      // is base64 of random bytes with real newlines, not a valid key encoding.
      make: (r) => {
        const header = kind === "PGP" ? P.pem("PGP", " BLOCK") : P.pem(kind.toUpperCase());
        const trailer = header.replace("BEGIN", "END");
        return {
          text: `${header}\n${bytes(r, 48).toString("base64")}\n${bytes(r, 48).toString("base64")}\n${trailer}`,
          secret: header,
        };
      },
    }),
  ),

  // ── Social ────────────────────────────────────────────────────────────
  {
    pattern: "Facebook Access Token",
    tier: "prefixed",
    make: (r) => value(P.eaac + runOf(r, ALNUM, 120)),
  },
  {
    pattern: "Twitter Bearer Token",
    tier: "prefixed",
    // Real ones open with 19 `A`s and are URL-encoded. The false-positive list
    // drops any value with 16+ `a`s, so this can never fire: pinned as a gap.
    make: (r) => value("A".repeat(19) + runOf(r, ALNUM, 12) + "%3D" + runOf(r, ALNUM, 60)),
  },

  // ── Generic assignments ───────────────────────────────────────────────
  {
    pattern: "Generic API Key Assignment",
    tier: "assignment",
    make: (r) => entry("apiKey", runOf(r, ALNUM, 32)),
  },
  {
    pattern: "Generic Secret Assignment",
    tier: "assignment",
    make: (r) => entry("password", runOf(r, ALNUM + "!#%", 16)),
  },
  {
    pattern: "Generic Token Assignment",
    tier: "assignment",
    make: (r) => entry("access_token", runOf(r, ALNUM, 40)),
  },
  {
    pattern: "Bearer Token",
    tier: "assignment",
    make: (r) => entry("authorization", mixedRun(r, 48, B64) + "=", (s) => `Bearer ${s}`),
  },
  {
    pattern: "Basic Auth Header",
    tier: "assignment",
    make: (r) => entry("authorization", Buffer.from(`svc_dashboard:${runOf(r, ALNUM, 20)}`).toString("base64"), (s) => `Basic ${s}`),
  },

  // ── Context tier (keyword window + credential key) ────────────────────
  { pattern: "Cohere API Key", tier: "keyed", keyName: "cohereKey", make: (r) => value(keyedRun(r, ALNUM, 40)) },
  { pattern: "Together AI Key", tier: "keyed", keyName: "togetherKey", make: (r) => value(keyedRun(r, HEX, 64)) },
  { pattern: "Mistral API Key", tier: "keyed", keyName: "mistralKey", make: (r) => value(keyedRun(r, ALNUM, 32)) },
  { pattern: "Pinecone API Key", tier: "keyed", keyName: "pineconeKey", make: (r) => value(uuid(r)) },
  { pattern: "Cloudflare API Token", tier: "keyed", keyName: "cloudflareToken", make: (r) => value(keyedRun(r, ALNUM, 40)) },
  { pattern: "Heroku API Key", tier: "keyed", keyName: "herokuKey", make: (r) => value(uuid(r)) },
  { pattern: "Twilio Auth Token", tier: "keyed", keyName: "twilioAuth", make: (r) => value(keyedRun(r, HEX, 32)) },
  { pattern: "Postmark Server Token", tier: "keyed", keyName: "postmarkToken", make: (r) => value(uuid(r)) },
  { pattern: "Datadog API Key", tier: "keyed", keyName: "datadogKey", make: (r) => value(keyedRun(r, HEX, 32)) },
  { pattern: "Segment Write Key", tier: "keyed", keyName: "segmentKey", make: (r) => value(keyedRun(r, ALNUM, 32)) },
  { pattern: "Mixpanel Token", tier: "keyed", keyName: "mixpanelToken", make: (r) => value(keyedRun(r, HEX, 32)) },
  { pattern: "Amplitude API Key", tier: "keyed", keyName: "amplitudeKey", make: (r) => value(keyedRun(r, HEX, 32)) },
  { pattern: "Auth0 Client Secret", tier: "keyed", keyName: "auth0Credential", make: (r) => value(keyedRun(r, ALNUM, 64)) },
  { pattern: "Okta API Token", tier: "keyed", keyName: "oktaToken", make: (r) => value("00" + runOf(r, DIGIT, 1) + runOf(r, ALNUM, 39)) },
  { pattern: "Contentful Access Token", tier: "keyed", keyName: "contentfulToken", make: (r) => value(keyedRun(r, ALNUM, 43)) },
  { pattern: "Algolia API Key", tier: "keyed", keyName: "algoliaKey", make: (r) => value(keyedRun(r, HEX, 32)) },
  { pattern: "LinkedIn Client Secret", tier: "keyed", keyName: "linkedinCredential", make: (r) => value(keyedRun(r, ALNUM, 16)) },
];

export const GENERATORS_BY_PATTERN = new Map(GENERATORS.map((g) => [g.pattern, g]));
