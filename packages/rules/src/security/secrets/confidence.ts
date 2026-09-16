// security/leaked-secrets — token decoders (#361).
//
// Several credential formats carry enough structure to confirm or downgrade a
// match without asking anyone: a checksum, an encoded account id, a claims
// payload, a restriction list. Every decoder here is pure and offline. Nothing
// in this file may ever contact a provider: verifying a third party's
// credential against its issuer from a website audit is not ours to do, and a
// test asserts that no `fetch` happens anywhere in the scan.
//
// The scanner calls `refineFinding` once per finding it is about to build. A
// refinement can rename the finding, move it between tiers, attach `extra`
// fields for the report, or drop it.

/** What a decoder learned about a value, for the report to show. */
export type FindingExtra = Record<string, string | number | boolean>;

export type Confidence = "high" | "medium" | "info";

export interface Refinement {
  /** The value fails a check its own format defines: not a credential. */
  drop?: boolean;
  /** A more precise name than the pattern's. */
  type?: string;
  confidence?: Confidence;
  publicByDesign?: boolean;
  extra?: FindingExtra;
  /**
   * The value's structure decoded, so the shape is proven: the bare-shape
   * heuristics (identifier test, value position, key context) that guard the
   * keyword tier against hashes and nonces do not apply.
   */
  structural?: boolean;
}

// ── AWS access key id ───────────────────────────────────────────────────────

// The 16 characters after the four-letter prefix are base32 (RFC 4648
// alphabet, `A–Z2–7`). The account id is encoded in the first 6 decoded bytes:
// read them as a big-endian integer, mask with 0x7fffffffff80 and shift right
// 7. Reference: Tal Be'ery, "A short note on AWS KEY ID" (2024),
// https://medium.com/@TalBeerySec/a-short-note-on-aws-key-id-f88cc4317489 —
// the same derivation `aws sts get-access-key-info` performs server-side, and
// Aidan Steele's earlier write-up of the format,
// https://awsteele.com/blog/2020/09/26/aws-access-key-format.html.
//
// A suffix carrying `0`, `1`, `8` or `9` is outside the alphabet and cannot be
// a key AWS issued: `AKIA` followed by sixteen arbitrary capitals and digits is
// a product code or a random identifier, not a credential. The 40 bits the
// mask leaves also reach past the largest 12-digit account id, so a decode
// above that is not an id either.
const AWS_B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // pragma: allowlist secret
const AWS_ACCOUNT_MASK = 0x7fffffffff80n;
const AWS_MAX_ACCOUNT_ID = 999_999_999_999n;

/** The 12-digit account id an AWS access key id encodes, or null if it cannot. */
export function decodeAwsAccountId(keyId: string): string | null {
  if (keyId.length !== 20) return null;
  const suffix = keyId.slice(4);
  let bits = 0n;
  for (const ch of suffix) {
    const v = AWS_B32.indexOf(ch);
    if (v === -1) return null;
    bits = (bits << 5n) | BigInt(v);
  }
  // 16 characters are 80 bits; the account lives in the top 48.
  const top48 = bits >> 32n;
  const account = (top48 & AWS_ACCOUNT_MASK) >> 7n;
  if (account > AWS_MAX_ACCOUNT_ID) return null;
  return account.toString().padStart(12, "0");
}

// A presigned S3 URL carries the key id in the clear, as the first field of
// `X-Amz-Credential` (SigV4) or as `AWSAccessKeyId` (the older SigV2). That is
// the public half of the signature, and the key id on its own grants nothing.
//
// What makes it harmless is the rest of the URL, so the rest of the URL has to
// be there: a signature derived from the secret key, and an expiry that bounds
// it. A value sitting under a credential-shaped query name with neither of
// those beside it is not a presigned URL, and downgrading it on the name alone
// would hide a key id someone pasted into a query string. Shown, never counted
// (#2213).
const PRESIGNED_LEAD_RE = /(?:x-amz-credential|awsaccesskeyid)=$/i;
const PRESIGNED_SIGNATURE_RE = /[?&](?:x-amz-)?signature=[^&\s]/i;
const PRESIGNED_EXPIRY_RE = /[?&](?:x-amz-expires|expires)=\d/i;

function isPresigned(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || !PRESIGNED_LEAD_RE.test(before)) return false;
  const around = before + (after ?? "");
  return PRESIGNED_SIGNATURE_RE.test(around) && PRESIGNED_EXPIRY_RE.test(around);
}

function refineAwsAccessKeyId(
  value: string,
  before: string | undefined,
  after: string | undefined,
): Refinement {
  const accountId = decodeAwsAccountId(value);
  const presigned = isPresigned(before, after);
  const extra: FindingExtra = {
    accountId: accountId ?? "undecodable",
    prefix: value.slice(0, 4),
  };
  if (presigned) extra.presigned = true;
  if (accountId === null) return { confidence: presigned ? "info" : "medium", extra };
  return { confidence: presigned ? "info" : "high", extra };
}

const CONNECTION_STRING_TYPES = new Set([
  "MongoDB Connection String",
  "PostgreSQL Connection String",
  "MySQL Connection String",
  "Redis Connection String",
]);

// A driver will take the password from the query string as readily as from
// the authority: `postgresql://app@host/db?password=…` is what libpq documents,
// JDBC spells it the same way, and a value there is every bit as leaked as one
// before the `@`. The names below are the ones the common drivers accept.
const CREDENTIAL_QUERY_RE =
  /[?&](?:password|passwd|pwd|secret|token|auth|api[_-]?key|sslpassword)=[^&\s]/i;

// `%3A` is a colon the userinfo escaped (`mongodb://app%3Asecret@host`). Only
// that one escape is undone, and only inside the userinfo: a password may
// carry an escaped `@` of its own, so the authority's separator has to be
// found on the raw text first.
const ESCAPED_COLON_RE = /%3a/gi;

/**
 * What a connection string leaks is the credential in it. A docs snippet
 * writes the shape without one — `postgresql://…`, `redis://…`, or a
 * `mongodb+srv://user:` whose rest an email obfuscator replaced — and a string
 * carrying no credential has no credential to leak (#2218).
 *
 * The credential can sit in either of two places, and the first version of
 * this check read only the first of them, which silenced a real leak: a URI
 * whose password is a query parameter, and one whose userinfo colon is
 * percent-encoded, both reported on main and reported nothing here. So the
 * whole URI is read, and the finding is dropped only when NEITHER place holds
 * a credential. The host it names may still be one a site would rather not
 * publish, but that is a different finding from this one.
 */
function refineConnectionString(value: string): Refinement {
  const scheme = value.indexOf("://");
  if (scheme === -1) return { drop: true };
  const rest = value.slice(scheme + 3);
  const authority = rest.split(/[/?#]/, 1)[0] ?? "";
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    const userinfo = authority.slice(0, at).replace(ESCAPED_COLON_RE, ":");
    const colon = userinfo.indexOf(":");
    if (colon !== -1 && colon !== userinfo.length - 1) return {};
  }
  if (CREDENTIAL_QUERY_RE.test(rest)) return {};
  return { drop: true };
}

// ── GitHub tokens ───────────────────────────────────────────────────────────

// `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` + 30 random characters + 6 checksum
// characters. The checksum is CRC32 (IEEE, as zlib computes it) of the 30
// random characters, base62-encoded with the alphabet `0–9A–Za–z` and
// left-padded with `0` to six characters. Documented in GitHub's announcement
// of the format, "Behind GitHub's new authentication token formats" (2021),
// https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/
// ("We start the implementation with a CRC32 algorithm … encode the result
// with a Base62 implementation, using leading zeros for padding"), and
// confirmed against a published, expired token.
//
// Fine-grained `github_pat_` tokens use a different, undocumented layout and
// are not checked here; the scanner has no pattern for them either.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 (IEEE 802.3, the zlib polynomial) of an ASCII string. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i++) {
    crc = CRC32_TABLE[(crc ^ text.charCodeAt(i)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `n` in base62, left-padded with `0` to `width`. */
export function base62(n: number, width: number): string {
  let out = "";
  let rest = n;
  do {
    out = BASE62[rest % 62] + out;
    rest = Math.floor(rest / 62);
  } while (rest > 0);
  return out.padStart(width, "0");
}

/** The six-character checksum GitHub appends to a 30-character token body. */
export function githubChecksum(body: string): string {
  return base62(crc32(body), 6);
}

/** Does this 40-character GitHub token carry the checksum its body implies? */
export function githubChecksumValid(token: string): boolean {
  if (token.length !== 40) return false;
  return githubChecksum(token.slice(4, 34)) === token.slice(34);
}

function refineGithubToken(value: string): Refinement {
  if (!githubChecksumValid(value)) return { drop: true };
  return { confidence: "high", extra: { checksum: "valid" } };
}

// ── JSON Web Tokens ─────────────────────────────────────────────────────────

// A payload longer than this is not a session token; skip rather than parse.
const JWT_MAX_PART_CHARS = 8192;

function decodeJwtPart(part: string): Record<string, unknown> | null {
  if (part.length === 0 || part.length > JWT_MAX_PART_CHARS) return null;
  try {
    const json = Buffer.from(part, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Header and payload of a JWT, decoded; null when either is not JSON. */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | null {
  const [head, body] = token.split(".");
  if (!head || !body) return null;
  const header = decodeJwtPart(head);
  const payload = decodeJwtPart(body);
  return header && payload ? { header, payload } : null;
}

const ADMIN_WORD_RE = /\badmin\b|\bsuperuser\b|\bservice_role\b/i;

// Issuers whose tokens are credentials the site holds as a CLIENT of the
// service: a token from one of these on a page is something someone embedded,
// not the visitor's own session, however short-lived it looks.
const THIRD_PARTY_ISSUER_RE = /auth0|clerk|firebase|securetoken\.google|cognito|okta|supabase/i;

// A Supabase project's own auth issuer: the project ref as the host label,
// under supabase.co or supabase.in, on the auth path. Anchored at both ends.
const SUPABASE_AUTH_ISSUER_RE = /^https:\/\/[a-z0-9-]+\.supabase\.(?:co|in)\/auth\/v1\/?$/i;

// The longest a token can live and still read as a session. A crawler is an
// anonymous visitor, and what it sees is at most its own session.
const SESSION_MAX_SECONDS = 30 * 24 * 60 * 60;

// Text before the token that says it is being SENT as a credential, or is
// held under a key that calls it one: `Authorization: "Bearer <jwt>"` in any
// quoting (an RSC flight payload spells it `\\"Authorization\\":\\"Bearer `), or
// `apiKey:`, `secret:`, `auth:`. A session-shaped payload in such a place is
// still a credential the page is handing out. `token`, `jwt`, `session` and
// cookie-looking keys are what a standalone session token sits under and do
// not count.
const AUTH_LITERAL_RE = /authorization|bearer/i;
const CREDENTIAL_KEY_WORDS = new Set([
  "apikey",
  "key",
  "keys",
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
const PRECEDING_KEY_RE = /["'`]?([A-Za-z_$][A-Za-z0-9_$.-]*)(?:["'`]\s*\]|["'`]?)\s*(?:[:=]|\|\|=?|\?\?=?)\s*["'`]?\s*$/;

/** Does the look-behind put the token in an Authorization literal or under a credential key? */
export function heldAsCredential(before: string): boolean {
  if (AUTH_LITERAL_RE.test(before)) return true;
  const key = PRECEDING_KEY_RE.exec(before)?.[1];
  if (!key) return false;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words.some((w) => CREDENTIAL_KEY_WORDS.has(w));
}

/** Does the payload name a subject the way a session token does? */
function hasSessionSubject(payload: Record<string, unknown>): boolean {
  for (const key of ["sub", "sid", "session_id", "user_id", "userId", "uid", "email"]) {
    const claim = payload[key];
    if (typeof claim === "string" ? claim.length > 0 : typeof claim === "number") return true;
  }
  return false;
}

/** Does any scope-like claim grant admin rights? */
function hasAdminScope(payload: Record<string, unknown>): boolean {
  for (const key of ["scope", "scopes", "roles", "permissions", "role"]) {
    const claim = payload[key];
    const text = Array.isArray(claim) ? claim.filter((c) => typeof c === "string").join(" ") : claim;
    if (typeof text === "string" && ADMIN_WORD_RE.test(text)) return true;
  }
  return false;
}

function refineJwt(value: string, now: number, before: (() => string) | undefined): Refinement {
  const decoded = decodeJwt(value);
  if (!decoded) {
    // The header matched but the payload is not JSON: not a token anyone
    // issued. Reported as a generic JWT-shaped string, never as Supabase's.
    return { type: "JSON Web Token", confidence: "medium", publicByDesign: false };
  }
  const { payload } = decoded;
  const role = typeof payload.role === "string" ? payload.role : undefined;
  const iss = typeof payload.iss === "string" ? payload.iss : undefined;
  const ref = typeof payload.ref === "string" ? payload.ref : undefined;
  // A claim past what `Date` can represent (8.64e12 seconds) is not an expiry
  // anyone set; read it as absent rather than let toISOString throw below.
  const exp =
    typeof payload.exp === "number" && Number.isFinite(payload.exp) && Math.abs(payload.exp) <= 8.64e12
      ? payload.exp
      : undefined;
  const iat =
    typeof payload.iat === "number" && Number.isFinite(payload.iat) && Math.abs(payload.iat) <= 8.64e12
      ? payload.iat
      : undefined;
  const expired = exp !== undefined && exp * 1000 < now;
  // Supabase signs its API keys with `iss: "supabase"` and names the project
  // in `ref`; its user sessions carry the project's own auth URL. Anything
  // else is some other issuer's token, whatever its role says: an issuer that
  // merely MENTIONS supabase (`https://evil.test/supabase`) must not be able
  // to talk its way into the public anon tier.
  const supabase = iss === "supabase" || (iss !== undefined && SUPABASE_AUTH_ISSUER_RE.test(iss));

  const extra: FindingExtra = {};
  if (iss !== undefined) extra.issuer = iss;
  if (role !== undefined) extra.role = role;
  if (ref !== undefined) extra.projectRef = ref;
  if (exp !== undefined) {
    extra.expiresAt = new Date(exp * 1000).toISOString();
    extra.expired = expired;
  }

  if (expired) {
    return {
      type: supabase ? "Supabase JWT (expired)" : "JSON Web Token (expired)",
      confidence: "info",
      publicByDesign: false,
      extra,
    };
  }
  // Shopify's boot code embeds a storefront JWT on every page of a Shopify
  // shop, issued by the shop's own `*.myshopify.com` domain: public by design,
  // the same tier as the storefront access token.
  if (iss !== undefined && /\.myshopify\.com$/i.test(iss)) {
    return { type: "Shopify Storefront JWT", confidence: "medium", publicByDesign: true, extra };
  }
  if (supabase) {
    if (role === "service_role") {
      return { type: "Supabase Service Role JWT", confidence: "high", publicByDesign: false, extra };
    }
    if (role === "anon") {
      return { type: "Supabase Anon Key", confidence: "medium", publicByDesign: true, extra };
    }
    return { type: "Supabase JWT", confidence: "medium", publicByDesign: false, extra };
  }
  if (hasAdminScope(payload)) {
    return { type: "JSON Web Token (admin scope)", confidence: "high", publicByDesign: false, extra };
  }
  if (role === "anon") {
    return { type: "JSON Web Token (anon role)", confidence: "medium", publicByDesign: true, extra };
  }

  // A session token: it expires within 30 days of when it was issued (or of
  // now) and it is not from a service the site is a client of. A page served
  // to an anonymous crawler cannot hand a secret that expires in a week to
  // every visitor, so a short-lived token that STANDS ALONE is information,
  // not a leak, whether or not it names a subject (a per-visitor feed token
  // does not). A token with no `exp`, or one living longer than a session,
  // is a credential someone embedded and stays medium.
  const shortLived =
    exp !== undefined &&
    ((iat !== undefined && exp - iat <= SESSION_MAX_SECONDS) || exp - now / 1000 <= SESSION_MAX_SECONDS);
  const thirdParty = iss !== undefined && THIRD_PARTY_ISSUER_RE.test(iss);
  // Only a token that stands alone is "the visitor's own session": one being
  // sent in an Authorization header, or held under a key that calls it a
  // credential, is a credential the page hands out, minimum medium. That
  // rule needs the look-behind; without one, the subject claim has to vouch.
  const standalone = before !== undefined && !heldAsCredential(before());
  const sessionShaped = standalone || (before === undefined && hasSessionSubject(payload));
  if (sessionShaped && shortLived && !thirdParty) {
    return {
      type: "Session Token (JWT)",
      confidence: "info",
      publicByDesign: false,
      extra: { ...extra, kind: "session" },
    };
  }
  return { type: "JSON Web Token", confidence: "medium", publicByDesign: false, extra };
}

// ── Algolia ─────────────────────────────────────────────────────────────────

// A secured API key is base64 of `hmac_sha256_hex(parentKey, params) + params`,
// where `params` is a URL query string of restrictions (`restrictIndices=…`,
// `validUntil=…`, `filters=…`). Decoding it shows exactly what the key may do.
// Reference: https://www.algolia.com/doc/guides/security/api-keys/how-to/user-restricted-access-to-data/
const ALGOLIA_SECURED_RE = /^([a-f0-9]{64})(.*)$/s;
const ALGOLIA_RESTRICTION_KEYS = new Set([
  "restrictIndices",
  "validUntil",
  "filters",
  "restrictSources",
  "userToken",
  "hitsPerPage",
  "attributesToRetrieve",
  "restrictSearchableAttributes",
  "referers",
  "queryLanguages",
]);

/** The restrictions an Algolia secured key encodes, or null if it is not one. */
export function decodeAlgoliaSecuredKey(value: string): Record<string, string> | null {
  if (value.length > JWT_MAX_PART_CHARS) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
  const match = ALGOLIA_SECURED_RE.exec(decoded);
  if (!match) return null;
  const params = match[2] ?? "";
  if (params.includes("�")) return null;
  const restrictions: Record<string, string> = {};
  if (params.length === 0) return restrictions;
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(params);
  } catch {
    return null;
  }
  for (const [key, val] of query) {
    if (!ALGOLIA_RESTRICTION_KEYS.has(key)) continue;
    restrictions[key] = val.length > 200 ? `${val.slice(0, 200)}…` : val;
  }
  return restrictions;
}

function refineAlgoliaSecuredKey(value: string): Refinement {
  const restrictions = decodeAlgoliaSecuredKey(value);
  if (restrictions === null) return { drop: true };
  const keys = Object.keys(restrictions);
  const extra: FindingExtra = { keyType: "secured" };
  for (const key of keys) extra[key] = restrictions[key]!;
  if (keys.length === 0) {
    // Secured, but with nothing restricted: it can do whatever its parent can.
    return { structural: true, confidence: "medium", publicByDesign: false, extra: { ...extra, restrictions: "none" } };
  }
  return { structural: true, confidence: "medium", publicByDesign: true, extra };
}

function refineAlgoliaHexKey(): Refinement {
  // 32 hex is the shape of both the admin key and a search-only key; nothing
  // in the value says which. The keyword window said "algolia", the key
  // context said "credential", and that is as far as an offline read goes.
  return { extra: { keyType: "admin-or-search-shaped", restrictions: "unknown" } };
}

// ── Stripe, Slack, Sentry ───────────────────────────────────────────────────

function refineStripeKey(value: string): Refinement {
  const kind = value.startsWith("sk_") ? "secret" : value.startsWith("rk_") ? "restricted" : "publishable";
  const mode = value.slice(3, 8) === "live_" ? "live" : "test";
  return { extra: { kind, mode } };
}

const SLACK_KINDS: Record<string, string> = {
  b: "bot",
  p: "user",
  a: "app-level",
  r: "refresh",
  s: "signing-secret",
};

function refineSlackToken(value: string): Refinement {
  const kind = SLACK_KINDS[value[3] ?? ""] ?? "unknown";
  const segments = value.slice(5).split("-");
  // Every issued token opens with the numeric workspace and user/bot ids;
  // `xoxb-abcdefghijkl` is a placeholder or a docs example.
  const numericLead = /^\d+$/.test(segments[0] ?? "");
  const extra: FindingExtra = { kind, segments: segments.length };
  if (!numericLead) {
    return { confidence: "medium", extra: { ...extra, structure: "no numeric workspace id" } };
  }
  return { confidence: "high", extra };
}

const SENTRY_DSN_RE = /^https:\/\/[a-f0-9]+@([a-z0-9]+)\.ingest\.sentry\.io\/([0-9]+)$/i;

function refineSentryDsn(value: string): Refinement {
  const match = SENTRY_DSN_RE.exec(value);
  if (!match) return {};
  return { extra: { org: match[1]!, projectId: match[2]! } };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const GITHUB_TYPES = new Set([
  "GitHub Personal Access Token",
  "GitHub OAuth Token",
  "GitHub App Token",
  "GitHub Refresh Token",
]);

const STRIPE_TYPES = new Set(["Stripe Live Key", "Stripe Test Key", "Stripe Publishable Key", "Clerk Secret Key"]);

/** What the scanner knows about where the value sits. */
export interface FindingContext {
  /** The bounded look-behind before the value, computed only if asked for. */
  before?: () => string;
  /** The bounded text AFTER the value: a signature sits past the key it signs. */
  after?: () => string;
}

/**
 * What the value's own structure says about the finding the scanner is about
 * to build for it. `null` when the format carries nothing to decode.
 *
 * `now` is injectable so a test can pin an expiry on either side of it.
 */
export function refineFinding(
  type: string,
  value: string,
  now: number = Date.now(),
  context: FindingContext = {},
): Refinement | null {
  try {
    if (type === "AWS Access Key ID")
      return refineAwsAccessKeyId(value, context.before?.(), context.after?.());
    if (CONNECTION_STRING_TYPES.has(type)) return refineConnectionString(value);
    if (GITHUB_TYPES.has(type)) return refineGithubToken(value);
    if (type === "JSON Web Token" || type === "Supabase Anon Key") return refineJwt(value, now, context.before);
    if (type === "Algolia Secured API Key") return refineAlgoliaSecuredKey(value);
    if (type === "Algolia API Key") return refineAlgoliaHexKey();
    if (STRIPE_TYPES.has(type)) return refineStripeKey(value);
    if (type === "Slack Token") return refineSlackToken(value);
    if (type === "Sentry DSN") return refineSentryDsn(value);
    return null;
  } catch {
    // A decoder that throws on some input leaves the finding as the pattern
    // built it. Decoding only ever refines; it never gates.
    return null;
  }
}
