// Which links are actions or carry a credential, and so are never requested
// by a status-only check (repo#2729, repo#2759). Shared by the internal link
// probe and the external link checker in @squirrelscan/audit-engine, and pure
// (no I/O, no node built-ins) so a Worker can use the same rules.

import { isHttpOrHttpsUrl } from "./safe-fetch";

/**
 * Each path segment, query key and query value is split into words on
 * anything but letters and digits, and at camelCase humps
 * (`/users/sign_out`, `?route=account/logout`, `?task=user.logout`,
 * `/logout;jsessionid=…`, `/account%2Flogout`, `?action=deleteItem`). How far
 * a word reaches depends on how unambiguous it is: a long slug that mentions
 * one (`/blog/how-to-verify-your-domain`) is still a page.
 */

/** Verbs that never mean a page, matched anywhere, even run together (`/UserLogout.aspx`, `/dologout`). */
const RUN_TOGETHER_ACTIONS = [
  "logout",
  "logoff",
  "signout",
  "signoff",
  "unsubscribe",
];

/** Words that are an action anywhere in a URL. */
const ANYWHERE_ACTION_WORDS = new Set(["unsub", "optout"]);

/**
 * Two-word actions (`log-out`, `sign_off`, `opt out`, `add-to-cart`), in a
 * segment of at most four words or a query.
 */
const ACTION_PAIRS = new Set([
  "log out",
  "log off",
  "sign out",
  "sign off",
  "opt out",
  "add to",
]);

/** Action verbs, in a segment of at most three words (`/delete-your-account`) or a query. */
const STRONG_ACTION_WORDS = new Set([
  "delete",
  "destroy",
  "trash",
  "revoke",
  "deactivate",
  "confirm",
  "verify",
  "activate",
  "approve",
  "unlock",
  "purchase",
  "callback",
]);

/**
 * Words that are an action in a short segment or a query (`/cart`,
 * `/remove-item`, `?do=subscribe`) but a page in a longer slug
 * (`/where-to-buy`, `/how-to-remove-stains`): a segment of at most two words.
 */
const WEAK_ACTION_WORDS = new Set([
  "remove",
  "cancel",
  "disable",
  "reset",
  "checkout",
  "cart",
  "basket",
  "buy",
  "vote",
  "like",
  "follow",
  "subscribe",
  "oauth",
  "invite",
  "accept",
  "decline",
]);

/**
 * Words that carry a secret or a one-time value: in any query key
 * (`?token=`, `?_wpnonce=`, `?csrf_token=`), or a path segment of at most two
 * words (`/token/…`, `/password-reset`).
 */
const SECRET_KEY_WORDS = new Set([
  "token",
  "nonce",
  "wpnonce",
  "csrf",
  "csrfmiddlewaretoken",
  "xsrf",
  "sig",
  "signature",
  "otp",
  "apikey",
  "secret",
  "password",
  "passwd",
]);
/** A session id in the URL, anywhere. */
const SESSION_ID_WORDS = new Set(["jsessionid", "phpsessid", "sessionid"]);
/** Whole query keys that carry a secret: `?code=` (OAuth), `?key=`, `?hash=`, `?auth=`. */
const SECRET_KEYS = new Set([
  "code",
  "key",
  "hash",
  "auth",
  "session",
  "sid",
  "ticket",
  "state",
]);

/** Words that say a path token is a credential (`/magic-login/<jwt>`, `/login/token/<hex>`). */
const CREDENTIAL_CONTEXT_WORDS = new Set([
  "login",
  "signin",
  "magic",
  "token",
  "auth",
  "session",
  "password",
  "email",
  "invite",
  "reset",
  "verify",
  "confirm",
  "activate",
  "unsubscribe",
  "unsub",
]);

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/**
 * A JWT, a long hex string, a long run of letters and digits with no
 * separator, or a long mixed-case base64 string: a one-time value, not a name.
 * Slugs, UUIDs and campaign names have separators.
 */
function looksLikeAToken(value: string): boolean {
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)) return true;
  if (/^[a-f0-9]{16,}$/i.test(value)) return true;
  if (/^[A-Za-z0-9]{20,}$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value)) return true;
  return (
    /^[A-Za-z0-9_-]{20,}={0,2}$/.test(value) &&
    /[0-9]/.test(value) &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value)
  );
}

/** Action words in one path segment, or (`inQuery`) one query key or value. */
function hasActionWords(parts: string[], inQuery: boolean): boolean {
  const reach = inQuery ? 1 : parts.length;
  for (let i = 0; i < parts.length; i++) {
    const word = parts[i]!;
    if (RUN_TOGETHER_ACTIONS.some((verb) => word.includes(verb))) return true;
    if (ANYWHERE_ACTION_WORDS.has(word)) return true;
    if (reach <= 3 && STRONG_ACTION_WORDS.has(word)) return true;
    if (reach <= 2 && WEAK_ACTION_WORDS.has(word)) return true;
    if (reach <= 4 && i + 1 < parts.length && ACTION_PAIRS.has(`${word} ${parts[i + 1]}`)) {
      return true;
    }
  }
  return false;
}

/**
 * A link whose path or query reads like an action rather than a page, or that
 * carries a secret or a one-time token. The internal link probe never
 * requests these: a status-only request is still a request, and a crawl that
 * did not follow links never would have. A crawl that follows links reaches
 * pages through the crawler, which is unchanged.
 */
export function looksLikeAnAction(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (!isHttpOrHttpsUrl(parsed.href)) return true;
  if (parsed.username || parsed.password) return true;

  const allWords: string[] = [];
  const pathTokens: string[] = [];
  for (const raw of parsed.pathname.split("/")) {
    const segment = decode(raw);
    if (segment === null) return true;
    // Matrix parameters (`;jsessionid=…`) and an encoded `/` are part of the
    // segment's words, so `/logout;x=1` and `/account%2Flogout` still match.
    const parts = words(segment);
    allWords.push(...parts);
    if (hasActionWords(parts, false)) return true;
    if (parts.some((w) => SESSION_ID_WORDS.has(w))) return true;
    if (parts.length <= 2 && parts.some((w) => SECRET_KEY_WORDS.has(w))) return true;
    for (const piece of segment.split(/[;,/]/)) {
      if (looksLikeAToken(piece)) pathTokens.push(piece);
    }
  }
  for (const [rawKey, rawValue] of parsed.searchParams) {
    const key = rawKey.toLowerCase();
    const keyWords = words(rawKey);
    const valueWords = words(rawValue);
    allWords.push(...keyWords, ...valueWords);
    if (SECRET_KEYS.has(key) || keyWords.some((w) => SECRET_KEY_WORDS.has(w) || SESSION_ID_WORDS.has(w))) {
      return true;
    }
    if (looksLikeAToken(rawKey) || looksLikeAToken(rawValue)) return true;
    if (hasActionWords(keyWords, true) || hasActionWords(valueWords, true)) return true;
  }
  // A token in the path is a credential when the URL says so; a bare id
  // (`/posts/<uuid>`) is still a page. A JWT is always a credential.
  if (pathTokens.some((t) => t.includes("."))) return true;
  if (pathTokens.length > 0 && allWords.some((w) => CREDENTIAL_CONTEXT_WORDS.has(w))) return true;
  return false;
}

/** Link text that starts with an action ("Log out", "Delete", "Add to cart"). */
const ACTION_TEXT =
  /^(log ?out|log ?off|sign ?out|sign ?off|unsubscribe|opt ?out|delete|remove|destroy|trash|cancel|revoke|disable|deactivate|confirm|verify|activate|reset|approve|unlock|checkout|check out|add to|buy|purchase|vote|like|follow|subscribe|invite|accept|decline)\b/i;

/** Short link text that is an unambiguous action, whatever the URL says. */
const PLAIN_ACTION_TEXT =
  /^(log ?out|log ?off|sign ?out|sign ?off|unsubscribe|opt ?out|delete|destroy|trash|revoke|deactivate)\b/i;

/**
 * A link whose text says it is an action: short text that is an unambiguous
 * one ("Log out", "Unsubscribe", "Delete account"), whatever its URL says, or
 * rel=nofollow on any action text ("Remove", "Buy now"). Without nofollow,
 * "Buy now" or "Subscribe" on a product or newsletter page is still a page.
 */
export function linkTextLooksLikeAnAction(text: string, nofollow: boolean): boolean {
  const label = text.trim().replace(/\s+/g, " ");
  if (label === "") return false;
  if (nofollow && ACTION_TEXT.test(label)) return true;
  return label.split(" ").length <= 4 && PLAIN_ACTION_TEXT.test(label);
}

/**
 * `url` with every query value, and every token-like path segment, replaced
 * by `…`, for a report that lists a link it never requested (repo#2759): the
 * reader sees where it points, the report never carries the credential.
 * Unparseable input comes back as `…`.
 */
export function maskLinkTokens(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "…";
  }
  const path = parsed.pathname
    .split("/")
    .map((segment) => {
      const decoded = decode(segment);
      return decoded !== null && decoded.split(/[;,]/).some((piece) => looksLikeAToken(piece))
        ? "…"
        : segment;
    })
    .join("/");
  const keys = [...new Set(parsed.searchParams.keys())];
  const query = keys.length > 0 ? `?${keys.map((k) => `${encodeURIComponent(k)}=…`).join("&")}` : "";
  return `${parsed.protocol}//${parsed.host}${path}${query}`;
}
