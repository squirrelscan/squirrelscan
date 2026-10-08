// security/token-storage - Auth tokens written to localStorage or sessionStorage.
//
// Anything in web storage is readable by every script on the origin, so a single
// XSS (or one compromised third-party script) turns a stored JWT or session token
// into an account takeover. An httpOnly cookie is not readable from script, which
// is why it is the safer place for a credential.
//
// Passive: the rule only reads script text the crawl already fetched, the inline
// `<script>` blocks of the page and the external files in `ctx.site.scripts`. It
// makes no request. An external script is scanned once per run and reported on every
// page that loads it, with a check that depends on the script alone, so the copies
// fold into one issue and no finding hangs on one page being evaluated.
//
// A finding names the script, the storage and the key, and NEVER the value: the
// value is a live credential on a real site, and a report is shared and stored.

import type { CheckItem, ScriptContentData } from "@squirrelscan/core-contracts";
import { getDomain } from "tldts";

import { sharedRegex } from "../shared-regex";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export type StorageKind = "localStorage" | "sessionStorage";

/** Why a write was flagged. */
export type TokenStorageReason = "key-name" | "jwt-value";

export interface TokenStorageWrite {
  storage: StorageKind;
  /** The literal key, or null when it is computed at runtime. Never a value. */
  key: string | null;
  reason: TokenStorageReason;
}

/* -------------------------------------------------------------------------- */
/* Key classification                                                         */
/* -------------------------------------------------------------------------- */

// A key is split into lowercase segments at punctuation and at camelCase
// boundaries (`accessToken` -> access, token). Segments, not substrings, decide:
// `tokenizer` and `authority` are not tokens, `session_theme` is not a session.

/** A key with one of these is a credential on its own: `token`, `access_token`, `jwt`. */
const STRONG_SEGMENTS = new Set(["token", "tokens", "jwt", "bearer"]);

/** `auth` and `session` are only credentials alone or beside one of COMPANIONS. */
const WEAK_SEGMENTS = new Set(["auth", "authorization", "session", "sessions"]);

/** Words that keep a weak segment a credential: `session_id`, `auth_user`, `authData`. */
const COMPANIONS = new Set([
  "id",
  "key",
  "data",
  "user",
  "info",
  "state",
  "sid",
  "cookie",
  "header",
  "storage",
  "credentials",
  "credential",
  "current",
  "login",
  "access",
  "refresh",
]);

/**
 * A segment that says the value is not a credential: UI state, a timestamp, a
 * pagination cursor, or a token of another kind (CSRF, push, device).
 */
// Deliberately a blocklist that wins over STRONG_SEGMENTS: `token_view`, `jwt_mode` and
// `auth_token_time` are missed, in exchange for not flagging `token_expires_at`,
// `csrf_token` or `next_page_token`. Precision over recall; see the rule page.
const BENIGN_SEGMENTS = new Set([
  "csrf",
  "xsrf",
  "push",
  "fcm",
  "apns",
  "device",
  "captcha",
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "next",
  "page",
  "cursor",
  "pagination",
  "theme",
  "banner",
  "dismissed",
  "dismiss",
  "seen",
  "shown",
  "hidden",
  "collapsed",
  "expanded",
  "ui",
  "layout",
  "color",
  "colour",
  "lang",
  "language",
  "locale",
  "count",
  "counter",
  "consent",
  "cart",
  "sidebar",
  "tab",
  "view",
  "mode",
  "expires",
  "expiry",
  "expiration",
  "timestamp",
  "time",
  "at",
  "version",
  "flag",
  "visited",
  "tooltip",
  "modal",
  "popup",
  "prompt",
  "design",
  "style",
  "font",
  "size",
  "width",
  "height",
]);

const MAX_KEY_CHARS = 64;

export function keySegments(key: string): string[] {
  // `:` `.` `/` separate a namespace from the key (`app:auth`): judge the last part.
  const last = key.split(/[:./]/).filter(Boolean).pop() ?? key;
  return last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/** Does this storage key name a credential? */
export function isTokenKey(key: string): boolean {
  const segments = keySegments(key);
  if (segments.length === 0) return false;
  if (segments.some((s) => BENIGN_SEGMENTS.has(s))) return false;
  if (segments.some((s) => STRONG_SEGMENTS.has(s))) return true;
  if (!segments.some((s) => WEAK_SEGMENTS.has(s))) return false;
  return segments.every((s) => WEAK_SEGMENTS.has(s) || COMPANIONS.has(s) || STRONG_SEGMENTS.has(s));
}

/* -------------------------------------------------------------------------- */
/* Value classification                                                       */
/* -------------------------------------------------------------------------- */

/** Three base64url parts, header and payload starting `eyJ` (`{"`): a JWT. */
const JWT_BODY = "eyJ[\\w-]{8,}\\.eyJ[\\w-]{8,}\\.[\\w-]*";
const JWT_SHAPE = new RegExp(`^${JWT_BODY}$`);
const JWT_AT_START = new RegExp(`^\\s*(['"\`])${JWT_BODY}\\1`);

export const isJwtShaped = (value: string): boolean => JWT_SHAPE.test(value);

/**
 * A value that holds no credential: a write that clears a key (`setItem("token", "")`,
 * `null`, `undefined`) or stores a flag (`"true"`, `"false"`, `"0"`, `"1"`).
 */
const EMPTY_VALUE = /^\s*(?:(['"`])(?:|null|undefined|false|true|0|1)\1|null\b|undefined\b|void 0|!?[01]\b|!0|!1)/;

/* -------------------------------------------------------------------------- */
/* Scanning                                                                   */
/* -------------------------------------------------------------------------- */

const STORAGE = "(?<![\\w$])(?:window\\s*\\.\\s*|self\\s*\\.\\s*|globalThis\\s*\\.\\s*)?(localStorage|sessionStorage)";

// `setItem("key", value)` with a string-literal key. The value is read from the
// text after the comma by VALUE_WINDOW.
const SET_ITEM_LITERAL = sharedRegex(
  new RegExp(
    `${STORAGE}\\s*(?:\\?\\.|\\.)\\s*setItem\\s*\\(\\s*(['"\`])((?:\\\\.|(?!\\2)[^\\\\\\n\\r]){1,${MAX_KEY_CHARS}})\\2\\s*,`,
    "g",
  ),
);
// `setItem(computed, value)`: no literal key, only the value can be judged. The end
// of the first argument is found by a bounded scan (200 characters, brackets
// counted, strings not parsed), so a comma inside a string argument or a very long
// key expression can misplace the value window. That costs at most a missed or odd
// JWT-value match, never a wrong key.
const SET_ITEM_DYNAMIC = sharedRegex(
  new RegExp(
    `${STORAGE}\\s*(?:\\?\\.|\\.)\\s*setItem\\s*\\(\\s*(?!['"\`])`,
    "g",
  ),
);
// `localStorage["key"] = value`
const BRACKET_ASSIGN = sharedRegex(
  new RegExp(
    `${STORAGE}\\s*\\[\\s*(['"\`])((?:\\\\.|(?!\\2)[^\\\\\\n\\r]){1,${MAX_KEY_CHARS}})\\2\\s*\\]\\s*=(?![=>])`,
    "g",
  ),
);
// `localStorage.key = value`
const PROPERTY_ASSIGN = sharedRegex(
  new RegExp(`${STORAGE}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*=(?![=>])`, "g"),
);

const STORAGE_API = new Set([
  "setItem",
  "getItem",
  "removeItem",
  "clear",
  "key",
  "length",
  "constructor",
  "prototype",
  "__proto__",
]);

/** How far after the key a value is read from. A JWT is far shorter than this. */
const VALUE_WINDOW = 1200;

/**
 * Hard cap on one script, so a pathological bundle cannot dominate a page's time.
 * A script longer than this is read only up to the cap, and the report says so
 * (see {@link truncationCheck}) so a pass is never mistaken for a full scan.
 */
export const MAX_SCAN_CHARS = 6_000_000;

const MAX_WRITES_PER_SCRIPT = 25;

function valueAfter(text: string, from: number): string {
  return text.slice(from, from + VALUE_WINDOW);
}

export interface TokenStorageScan {
  writes: TokenStorageWrite[];
  /**
   * The text mentions web storage but is longer than {@link MAX_SCAN_CHARS}, so
   * only its first MAX_SCAN_CHARS characters were read. Text that never mentions
   * web storage is not truncated in any way that matters and reports false.
   */
  truncated: boolean;
}

/** Every web-storage write in `text` that stores a credential, plus whether it was cut short. */
export function findTokenStorageWrites(text: string): TokenStorageWrite[] {
  return scanTokenStorage(text).writes;
}

/**
 * Pure, and cheap on text that never mentions web storage: it returns before
 * running a pattern.
 */
export function scanTokenStorage(text: string): TokenStorageScan {
  if (!text.includes("localStorage") && !text.includes("sessionStorage")) {
    return { writes: [], truncated: false };
  }
  const truncated = text.length > MAX_SCAN_CHARS;
  const scan = truncated ? text.slice(0, MAX_SCAN_CHARS) : text;

  const out = new Map<string, TokenStorageWrite>();
  const add = (storage: StorageKind, key: string | null, reason: TokenStorageReason): void => {
    if (out.size >= MAX_WRITES_PER_SCRIPT) return;
    // A key that is itself JWT-shaped is a value in the wrong argument: do not echo it.
    const safeKey = key !== null && isJwtShaped(key) ? null : key;
    out.set(`${storage}\u0000${safeKey ?? ""}\u0000${reason}`, { storage, key: safeKey, reason });
  };

  const judge = (storage: StorageKind, key: string | null, after: number): void => {
    const value = valueAfter(scan, after);
    if (JWT_AT_START.test(value)) {
      add(storage, key, "jwt-value");
      return;
    }
    if (key !== null && isTokenKey(key) && !EMPTY_VALUE.test(value)) {
      add(storage, key, "key-name");
    }
  };

  for (const re of [SET_ITEM_LITERAL, BRACKET_ASSIGN]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while (out.size < MAX_WRITES_PER_SCRIPT && (m = re.exec(scan)) !== null) {
      judge(m[1] as StorageKind, m[3] ?? null, re.lastIndex);
    }
  }

  SET_ITEM_DYNAMIC.lastIndex = 0;
  let d: RegExpExecArray | null;
  while (out.size < MAX_WRITES_PER_SCRIPT && (d = SET_ITEM_DYNAMIC.exec(scan)) !== null) {
    // Skip to the comma that ends the first argument, at depth zero.
    const argText = valueAfter(scan, SET_ITEM_DYNAMIC.lastIndex);
    let depth = 0;
    let comma = -1;
    for (let i = 0; i < argText.length && i < 200; i++) {
      const c = argText[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) {
        comma = i;
        break;
      }
    }
    if (comma >= 0) judge(d[1] as StorageKind, null, SET_ITEM_DYNAMIC.lastIndex + comma + 1);
  }

  PROPERTY_ASSIGN.lastIndex = 0;
  let p: RegExpExecArray | null;
  while (out.size < MAX_WRITES_PER_SCRIPT && (p = PROPERTY_ASSIGN.exec(scan)) !== null) {
    if (STORAGE_API.has(p[2]!)) continue;
    judge(p[1] as StorageKind, p[2]!, PROPERTY_ASSIGN.lastIndex);
  }

  return { writes: [...out.values()], truncated };
}

/* -------------------------------------------------------------------------- */
/* Rule                                                                       */
/* -------------------------------------------------------------------------- */

interface Located extends TokenStorageWrite {
  location: "inline-script" | "external-script";
  script: string;
  /** An external script served from another registrable domain than the page's. */
  thirdParty?: boolean;
}

const registrable = (url: string): string | null => {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return getDomain(host, { allowPrivateDomains: true }) ?? host;
  } catch {
    return null;
  }
};

/**
 * Is this script served from a different registrable domain than the page? A
 * vendor SDK or widget writes to storage under its own configuration, so the site
 * owner reads such a finding differently: it is labelled, not hidden, because an
 * auth SDK that persists the user's JWT is still an exposure the owner chose.
 */
export function isThirdPartyScript(scriptUrl: string, pageUrl: string): boolean {
  const script = registrable(scriptUrl);
  const page = registrable(pageUrl);
  return script !== null && page !== null && script !== page;
}

const REASON_LABEL: Record<TokenStorageReason, string> = {
  "key-name": "token-like key",
  "jwt-value": "JWT-shaped value (redacted)",
};

const describe = (w: Located): string =>
  `${w.storage}${w.key !== null ? `["${w.key}"]` : " (computed key)"}`;

const MAX_ITEMS = 20;

/** The `type` of an inline script the browser runs as code; JSON data blocks and templates are not. */
const EXECUTABLE_SCRIPT_TYPE = /^(?:text|application)\/(?:javascript|ecmascript)$|^module$/;

/** One check for the writes found in one script (or in a page's inline scripts). */
function findingCheck(found: Located[]): CheckResult {
  const items: CheckItem[] = found.slice(0, MAX_ITEMS).map((w) => ({
    id: `${w.script}: ${describe(w)} (${w.reason})`,
    label: `${REASON_LABEL[w.reason]} written in ${
      w.location === "inline-script" ? "an inline script" : w.thirdParty ? "third-party script" : "script"
    } ${w.script}`,
    meta: {
      storage: w.storage,
      key: w.key,
      reason: w.reason,
      location: w.location,
      script: w.script,
      ...(w.thirdParty ? { thirdParty: true } : {}),
    },
  }));
  const first = found[0]!;
  return {
    name: "token-storage",
    status: "warn",
    message: `${found.length} auth token write(s) to web storage: ${describe(first)} in ${
      first.thirdParty ? "third-party script " : ""
    }${first.script}${
      found.length > 1 ? `, and ${found.length - 1} more` : ""
    }`,
    value: found.length,
    items,
    details: {
      note: "Token values are never reported.",
      ...(first.location === "external-script"
        ? { foldKey: `security/token-storage:${first.script}` }
        : {}),
      ...(first.thirdParty ? { thirdParty: true } : {}),
      ...(found.length > MAX_ITEMS ? { additional: found.length - MAX_ITEMS } : {}),
    },
  };
}

/** A shared bundle is scanned once per run, not once per page that loads it. */
const externalScanCache = new WeakMap<object, TokenStorageScan>();

function externalScan(script: { content: string | null }): TokenStorageScan {
  let result = externalScanCache.get(script);
  if (!result) {
    result = scanTokenStorage(script.content ?? "");
    externalScanCache.set(script, result);
  }
  return result;
}

/**
 * Page URL -> the scripts that page loads, built once per run from the script
 * inventory. A site-wide bundle lists every page in `sourcePages`, so testing
 * `sourcePages.includes(page)` per script on every page is quadratic in pages.
 */
const scriptsByPageCache = new WeakMap<readonly ScriptContentData[], Map<string, ScriptContentData[]>>();

function scriptsLoadedBy(
  scripts: readonly ScriptContentData[],
  pageUrl: string,
): readonly ScriptContentData[] {
  let index = scriptsByPageCache.get(scripts);
  if (!index) {
    index = new Map();
    for (const script of scripts) {
      if (!script.content) continue;
      for (const page of script.sourcePages) {
        const list = index.get(page);
        if (!list) index.set(page, [script]);
        // A page listed twice for one script must not report it twice.
        else if (list[list.length - 1] !== script) list.push(script);
      }
    }
    scriptsByPageCache.set(scripts, index);
  }
  return index.get(pageUrl) ?? [];
}

/**
 * An info check for a script that mentions web storage but was read only up to
 * the cap. It depends on the script alone, so the copies fold across pages.
 */
function truncationCheck(script: string): CheckResult {
  const mb = MAX_SCAN_CHARS / 1_000_000;
  return {
    name: "token-storage-truncated",
    status: "info",
    message: `Script ${script} is longer than ${mb} MB: only the first ${mb} MB were scanned for token writes`,
    details: { foldKey: `security/token-storage:truncated:${script}`, scanLimit: MAX_SCAN_CHARS },
  };
}

export const tokenStorageRule: Rule = {
  meta: {
    id: "security/token-storage",
    name: "Auth Tokens in Web Storage",
    description: "Flags JWTs and session or access tokens written to localStorage or sessionStorage",
    solution:
      "Anything in localStorage or sessionStorage can be read by any script on the page, so one XSS bug or one compromised third-party script steals the session. Keep the credential in an httpOnly, Secure, SameSite cookie that the server sets, and send it automatically with requests. If a token must live in script memory, keep it in a closure for the life of the page rather than persisting it, use short lifetimes and rotate refresh tokens. Pair this with a strict Content-Security-Policy to limit what can run.",
    category: "security",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 6,
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) {
      checks.push({
        name: "token-storage",
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    // Inline scripts belong to this page alone: one check for them.
    const inline: Located[] = [];
    const seenInline = new Set<string>();
    let inlineTruncated = false;
    for (const el of doc.querySelectorAll("script:not([src])")) {
      const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
      // JSON data blocks and templates are not executed code.
      if (type && !EXECUTABLE_SCRIPT_TYPE.test(type)) continue;
      const text = el.textContent || "";
      if (!text) continue;
      const scanned = scanTokenStorage(text);
      if (scanned.truncated) inlineTruncated = true;
      for (const w of scanned.writes) {
        const id = `${w.storage}\u0000${w.key ?? ""}\u0000${w.reason}`;
        if (seenInline.has(id)) continue;
        seenInline.add(id);
        inline.push({ ...w, location: "inline-script", script: ctx.page.url });
      }
    }
    if (inline.length > 0) checks.push(findingCheck(inline));
    if (inlineTruncated) checks.push(truncationCheck(ctx.page.url));

    // An external script is judged on EVERY page that loads it, by a check that
    // depends on the script alone, so the copies are identical and report grouping
    // folds them into one issue. Judging it on one owner page would lose the
    // finding whenever that page is skipped (soft 404, filtered out of the run).
    for (const script of scriptsLoadedBy(ctx.site?.scripts ?? [], ctx.page.url)) {
      const { writes, truncated } = externalScan(script);
      if (truncated) checks.push(truncationCheck(script.url));
      if (writes.length === 0) continue;
      checks.push(
        findingCheck(
          writes.map((w) => ({
            ...w,
            location: "external-script" as const,
            script: script.url,
            thirdParty: isThirdPartyScript(script.url, ctx.page.url),
          })),
        ),
      );
    }

    // Truncation notes are info, not findings: a page with only those still passes.
    if (!checks.some((c) => c.name === "token-storage")) {
      checks.push({
        name: "token-storage",
        status: "pass",
        message: "No auth tokens written to localStorage or sessionStorage",
      });
    }
    return { checks };
  },
};
