// security/serialized-account-data - account records serialised into framework data
//
// A server-rendered page hands its state to the browser as JSON or script
// (`__NEXT_DATA__`, `window.__NUXT__`, Qwik state, Astro island props). When a
// page passes a whole database row through, the record can carry the account's
// password hash, a one-time code, an API key or a session reference next to the
// fields the page really shows. Visitors, caches and crawlers all read it.
//
// Passive: the rule parses payloads already in the page HTML and sends nothing.
//
// What is flagged, by the key a string or number sits under and the record
// around it:
//  - password hash: a value in a password-hash format (bcrypt, argon2, scrypt,
//    PBKDF2, crypt) under any key, or a long value under a hash-named key.
//  - plaintext password: a password-named key in a record that has an identity
//    field (email, username, id).
//  - API key or access token: a secret-named key holding a token-shaped value
//    in a record with an identity field. Browser keys that are public by
//    design are not flagged: Google keys (`AIza...`) and keys in a client
//    config record (Firebase or Algolia: `appId`, `authDomain`, `projectId`).
//  - one-time code: an OTP-named key in a record with an identity field. A
//    sibling expiry in the past marks it expired. An OTP secret (TOTP seed) is
//    its own kind and is never "expired".
//  - session reference: a session id or token key in a record with an identity
//    field. It is a reference to server-side state; the rule cannot show it
//    works as a bearer token, and does not say so.
//
// Not flagged: labels and form definitions (`label: "Password"`), values that
// are placeholders or documented examples, and anything under a path segment
// named example, sample, demo, mock or fixture.
//
// Values never reach the report. An item holds the JSON field path and a kind.
// Only allowlisted path keys are printed: role and container names (`user`,
// `account`, `props`) and the credential field names the rule looks for. Any
// other key could be a username or an email keying a map, so it folds to
// `[*]`; array indices fold to `[]`.

import type { CheckItem } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import {
  frameworkPayloadSources,
  type FrameworkPayloadSource,
} from "../shared/framework-payload";
import { passwordHashShape } from "./json-sensitive-fields";

export const SERIALIZED_ACCOUNT_DATA_RULE_ID =
  "security/serialized-account-data";

const CHECK = "serialized-account-data";

const MAX_NODES = 50_000;
const MAX_DEPTH = 40;
const MAX_ITEMS = 20;
const MAX_PATH_CHARS = 160;
const MAX_VALUE_CHARS = 512;

export type AccountDataKind =
  | "password-hash"
  | "plaintext-password"
  | "api-key"
  | "otp"
  | "otp-expired"
  | "otp-secret"
  | "session-reference";

export const KIND_LABEL: Record<AccountDataKind, string> = {
  "password-hash": "password hash",
  "plaintext-password": "plaintext password",
  "api-key": "API key or access token",
  otp: "one-time code (not shown to be expired)",
  "otp-expired": "expired one-time code",
  "otp-secret": "one-time-code secret",
  "session-reference": "session reference",
};

/** Kinds that fail the check; the rest warn. */
const SEVERE: ReadonlySet<AccountDataKind> = new Set([
  "password-hash",
  "plaintext-password",
  "api-key",
  "otp",
  "otp-secret",
]);

export interface AccountDataFinding {
  /** Field path, indices folded to `[]`. Never contains a value. */
  path: string;
  kind: AccountDataKind;
  /** Records it was seen in. */
  count: number;
}

const norm = (key: string): string =>
  key.toLowerCase().replace(/[^a-z0-9]/g, "");

const IDENTITY_KEYS = new Set([
  "email",
  "emailaddress",
  "username",
  "userid",
  "uid",
  "id",
  "login",
  "phone",
  "accountid",
  "customerid",
  "memberid",
  "handle",
]);
const HASH_KEYS = new Set([
  "passwordhash",
  "hashedpassword",
  "passhash",
  "pwhash",
  "passwordsalt",
  "passworddigest",
  "encryptedpassword",
  "passwdhash",
]);
const PASSWORD_KEYS = new Set([
  "password",
  "passwd",
  "pwd",
  "plainpassword",
  "plaintextpassword",
  "userpassword",
  "rawpassword",
]);
const API_KEY_KEYS = new Set([
  "apikey",
  "apisecret",
  "secret",
  "secretkey",
  "clientsecret",
  "privatekey",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "servicekey",
]);
const OTP_KEYS = new Set([
  "otp",
  "otpcode",
  "onetimepassword",
  "onetimecode",
  "verificationcode",
  "mfacode",
  "twofactorcode",
  "smscode",
  "emailcode",
  "resetcode",
  "confirmationcode",
  "totpcode",
]);
const OTP_SECRET_KEYS = new Set([
  "totpsecret",
  "otpsecret",
  "mfasecret",
  "twofactorsecret",
]);
const SESSION_KEYS = new Set([
  "sessionid",
  "sessiontoken",
  "sessionref",
  "sessionkey",
  "sid",
  "sessionsecret",
]);
const EXPIRY_KEYS = new Set([
  "otpexpiresat",
  "otpexpiry",
  "codeexpiresat",
  "codeexpiry",
  "expiresat",
  "expires",
  "expiry",
  "expiration",
  "expirationdate",
  "validuntil",
  "verificationcodeexpiresat",
  "resetcodeexpiresat",
  "otpexpires",
]);
/** Keys of a browser client config (Firebase, Algolia), whose API key is public by design. */
const PUBLIC_CONFIG_KEYS = new Set([
  "appid",
  "applicationid",
  "authdomain",
  "projectid",
  "messagingsenderid",
  "storagebucket",
  "measurementid",
]);
/** Google browser API keys (Maps, Firebase) are public and restricted by referrer. */
const GOOGLE_BROWSER_KEY_RE = /^AIza/;
/** Path segments that mark documentation or test data. */
const EXAMPLE_SEGMENT =
  /^(?:examples?|samples?|demos?|mocks?|fixtures?|docs?)$/i;

const PLACEHOLDER_RE =
  /^(?:\*+|x+|•+|\.+|-+|0+|null|none|undefined|n\/a|true|false)$|redacted|filtered|hidden|masked|removed|placeholder|example|changeme|your[_ -]|^<.*>$|^\{\{.*\}\}$|^\$\{.*\}$/i;
/** Values documentation uses for a password. */
const DOC_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "hunter2",
  "secret",
  "p@ssw0rd",
  "correcthorsebatterystaple",
  "letmein",
  "12345678",
  "qwerty",
]);
/** Well-known hashes that appear in library documentation. */
const DOC_HASHES = new Set(
  [
    "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
    "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
  ].map((h) => h.toLowerCase())
);
/** A label or sentence about a password, not a password. */
const LABEL_RE =
  /^(?:your |enter |confirm |new |current |old |forgot |reset )?(?:password|passwort|contrase[nñ]a|mot de passe)\b/i;
const PUBLIC_KEY_RE = /^(?:pk[_.]|public|anon)/i;
const TOKEN_SHAPE_RE = /^[A-Za-z0-9_\-.~+/=:]{16,512}$/;
const OTP_VALUE_RE = /^(?:\d{4,10}|[A-Z0-9]{6,8})$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasIdentity(obj: Record<string, unknown>): boolean {
  for (const k of Object.keys(obj)) {
    if (!IDENTITY_KEYS.has(norm(k))) continue;
    const v = obj[k];
    if (
      (typeof v === "string" && v.length > 0) ||
      (typeof v === "number" && Number.isFinite(v))
    )
      return true;
  }
  return false;
}

/** Role and container names, printed in a path when they do not equal the record's own identity. */
const RECORD_ROLE_KEYS = new Set([
  "user",
  "users",
  "currentuser",
  "authuser",
  "sessionuser",
  "loggedinuser",
  "me",
  "viewer",
  "account",
  "accounts",
  "currentaccount",
  "profile",
  "userprofile",
  "customer",
  "customers",
  "member",
  "members",
  "owner",
  "author",
  "creator",
  "admin",
  "data",
  "props",
  "pageprops",
  "initialprops",
  "state",
  "initialstate",
  "session",
  "auth",
  "identity",
  "principal",
  "record",
  "row",
  "result",
  "item",
  "node",
  "entity",
  "payload",
  "contact",
  "person",
  "dehydratedstate",
  "queries",
  "fallback",
  "initialdata",
]);

/** Credential field names the rule classifies, safe to print as the last path segment. */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  ...HASH_KEYS,
  ...PASSWORD_KEYS,
  ...API_KEY_KEYS,
  ...OTP_KEYS,
  ...OTP_SECRET_KEYS,
  ...SESSION_KEYS,
  "hash",
  "salt",
  "digest",
]);

/** True when `key` equals an identity value of the record it holds (a username named `admin`). */
function namesOwnRecord(k: string, child: unknown): boolean {
  if (!isPlainObject(child)) return false;
  for (const ck of Object.keys(child)) {
    if (!IDENTITY_KEYS.has(norm(ck))) continue;
    const v = child[ck];
    if (typeof v === "string" && norm(v) === k) return true;
  }
  return false;
}

/**
 * The printed segment for `key`. Any key outside the allowlist can be personal
 * data (a username or email keying a map), so it folds to `[*]`.
 */
function pathSegment(
  key: string,
  child: unknown,
  allow: ReadonlySet<string>
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(key)) return "[*]";
  const k = norm(key);
  if (!allow.has(k) || namesOwnRecord(k, child)) return "[*]";
  return `.${key}`;
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value.trim());
}

/** Epoch seconds or milliseconds, or a date string, as milliseconds; null if neither. */
function toMillis(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v < 1e11 ? v * 1000 : v;
  }
  if (typeof v === "string" && v.length > 0 && v.length <= 64) {
    if (/^\d{9,13}$/.test(v)) return toMillis(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function siblingExpiry(obj: Record<string, unknown>): number | null {
  for (const k of Object.keys(obj)) {
    if (EXPIRY_KEYS.has(norm(k))) {
      const t = toMillis(obj[k]);
      if (t !== null) return t;
    }
  }
  return null;
}

/** Facts about the record a field sits in, computed once per record. */
export interface RecordFacts {
  /** The record has a non-empty identity field (email, username, id). */
  identity: boolean;
  /** A sibling expiry as milliseconds, or null. */
  expiry: number | null;
  /** The record is a browser client config (Firebase, Algolia) whose key is public. */
  publicConfig: boolean;
}

/** Scan a record's keys once. Per-field rescans are quadratic in the key count. */
export function recordFacts(record: Record<string, unknown>): RecordFacts {
  let publicConfig = false;
  for (const k of Object.keys(record)) {
    if (PUBLIC_CONFIG_KEYS.has(norm(k))) {
      publicConfig = true;
      break;
    }
  }
  return {
    identity: hasIdentity(record),
    expiry: siblingExpiry(record),
    publicConfig,
  };
}

/** The kind of value under `key` in a record with `facts`, or null. `now` is milliseconds. */
export function classifyField(
  key: string,
  value: unknown,
  facts: RecordFacts,
  now: number
): AccountDataKind | null {
  const k = norm(key);
  if (typeof value === "string") {
    if (value.length === 0 || value.length > MAX_VALUE_CHARS) return null;
    if (isPlaceholder(value)) return null;
    const hash = passwordHashShape(value);
    if (hash)
      return DOC_HASHES.has(value.toLowerCase()) ? null : "password-hash";
    if (HASH_KEYS.has(k)) return value.length >= 20 ? "password-hash" : null;
    if (PASSWORD_KEYS.has(k)) {
      if (!facts.identity) return null;
      if (LABEL_RE.test(value) || DOC_PASSWORDS.has(value.toLowerCase()))
        return null;
      return "plaintext-password";
    }
    if (API_KEY_KEYS.has(k)) {
      // A key outside an account record is site config, and a client config
      // key is public by design: leaked-secrets judges those by provider.
      if (!facts.identity || facts.publicConfig) return null;
      if (PUBLIC_KEY_RE.test(value) || GOOGLE_BROWSER_KEY_RE.test(value))
        return null;
      return TOKEN_SHAPE_RE.test(value) ? "api-key" : null;
    }
    if (OTP_SECRET_KEYS.has(k)) {
      return /^[A-Za-z2-7=]{16,128}$/.test(value) ? "otp-secret" : null;
    }
  }
  if (
    OTP_KEYS.has(k) &&
    (typeof value === "string" || typeof value === "number")
  ) {
    const text = String(value);
    if (!OTP_VALUE_RE.test(text) || isPlaceholder(text)) return null;
    if (!facts.identity) return null;
    return facts.expiry !== null && facts.expiry < now ? "otp-expired" : "otp";
  }
  if (typeof value === "string" && SESSION_KEYS.has(k)) {
    if (value.length < 16 || value.length > MAX_VALUE_CHARS) return null;
    if (isPlaceholder(value) || !TOKEN_SHAPE_RE.test(value)) return null;
    return facts.identity ? "session-reference" : null;
  }
  return null;
}

/** Walk a parsed payload. Pure, bounded, and keeps no value: paths and kinds only. */
export function scanAccountData(
  root: unknown,
  now: number = Date.now()
): { findings: AccountDataFinding[]; truncated: boolean } {
  const found = new Map<string, AccountDataFinding>();
  let nodes = 0;
  let truncated = false;
  // Frames carry the printed path and whether a path segment marks example data.
  const stack: Array<{
    value: unknown;
    path: string;
    depth: number;
    example: boolean;
  }> = [{ value: root, path: "$", depth: 0, example: false }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (++nodes > MAX_NODES || frame.depth > MAX_DEPTH) {
      truncated = true;
      break;
    }
    const { value, path, depth, example } = frame;
    if (Array.isArray(value)) {
      for (const item of value)
        stack.push({
          value: item,
          path: `${path}[]`,
          depth: depth + 1,
          example,
        });
      continue;
    }
    if (!isPlainObject(value)) continue;

    const facts = recordFacts(value);
    for (const key of Object.keys(value)) {
      const child = value[key];
      const childExample = example || EXAMPLE_SEGMENT.test(key);
      if (typeof child === "object" && child !== null) {
        stack.push({
          value: child,
          path: `${path}${pathSegment(key, child, RECORD_ROLE_KEYS)}`,
          depth: depth + 1,
          example: childExample,
        });
        continue;
      }
      if (example) continue;
      const kind = classifyField(key, child, facts, now);
      if (!kind) continue;
      const printed = `${path}${pathSegment(key, child, CREDENTIAL_KEYS)}`;
      const id = `${printed}\u0000${kind}`;
      const prior = found.get(id);
      if (prior) prior.count++;
      else
        found.set(id, {
          path:
            printed.length > MAX_PATH_CHARS
              ? `${printed.slice(0, MAX_PATH_CHARS - 1)}…`
              : printed,
          kind,
          count: 1,
        });
    }
  }
  return { findings: [...found.values()], truncated };
}

/** Parse a payload's text to a value, or null when it is not JSON. */
export function parsePayload(source: FrameworkPayloadSource): unknown {
  let text = source.text.trim();
  if (source.assignment) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    text = text.slice(start, end + 1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface LabelledFinding extends AccountDataFinding {
  source: string;
}

function problemCheck(found: LabelledFinding[]): CheckResult {
  const items: CheckItem[] = found.slice(0, MAX_ITEMS).map((f) => ({
    id: `${f.source}: ${f.path} (${f.kind})`,
    label: `${f.path} in ${f.source}: ${KIND_LABEL[f.kind]}`,
    meta: {
      source: f.source,
      path: f.path,
      kind: f.kind,
      records: f.count,
    },
  }));
  const severe = found.some((f) => SEVERE.has(f.kind));
  const first = found[0]!;
  const kinds = [...new Set(found.map((f) => KIND_LABEL[f.kind]))];
  return {
    name: CHECK,
    status: severe ? "fail" : "warn",
    message: `Account data serialised into the page: ${found.length} field(s), first ${first.path} in ${first.source} (${KIND_LABEL[first.kind]}). Kinds: ${kinds.join(", ")}. Values are never shown in the report. Serialise an explicit list of public fields, and purge cached copies of the page`,
    value: found.length,
    items,
    details: {
      note: "Values are never reported.",
      sessionReferenceNote:
        "A session reference points to server-side state; the audit does not show that it works as a bearer token.",
      ...(found.length > MAX_ITEMS
        ? { additional: found.length - MAX_ITEMS }
        : {}),
    },
  };
}

export const serializedAccountDataRule: Rule = {
  meta: {
    id: "security/serialized-account-data",
    name: "Serialized Account Data in Framework Data",
    description:
      "Flags password hashes, passwords, one-time codes, API keys and session references serialised into __NEXT_DATA__, __NUXT__ and similar framework data",
    solution:
      "A page that passes a whole database row to the browser publishes every column of it. Serialise an explicit allowlist of public fields (a view model or DTO) instead of the record, and select only those columns in the query. Then purge the cached copies: clear the CDN and server-render caches that held the page, and ask search engines and archives to drop it where you can. Rotating keys and forcing password resets for the accounts that were exposed follows from that, but does not stop the next page leaking the same field.",
    category: "security",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 8,
    skipOnSoft404: true,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CHECK, outcome: "clean", clears: [CHECK] },
      { name: CHECK, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) {
      return {
        checks: [
          {
            name: CHECK,
            status: "skipped",
            message: "No document available",
            skipReason: "Parse error",
          },
        ],
      };
    }
    const found: LabelledFinding[] = [];
    const seen = new Set<string>();
    const now = Date.now();
    for (const source of frameworkPayloadSources(doc)) {
      const value = parsePayload(source);
      if (value === null) continue;
      for (const f of scanAccountData(value, now).findings) {
        const id = `${source.label}\u0000${f.path}\u0000${f.kind}`;
        if (seen.has(id)) continue;
        seen.add(id);
        found.push({ ...f, source: source.label });
      }
    }
    if (found.length > 0) return { checks: [problemCheck(found)] };
    return {
      checks: [
        {
          name: CHECK,
          status: "pass",
          message: "No serialised account records found in framework data",
        },
      ],
    };
  },
};
