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
 * segment of at most four words or a query. A server-script extension is not
 * counted as a word (`/MyAccountLogOut.aspx` is four).
 */
const ACTION_PAIRS = new Set([
  "log out",
  "log off",
  "sign out",
  "sign off",
  "opt out",
  "add to",
]);

/**
 * The sign-out pairs, which reach a segment of five words
 * (`/my-account-log-out-now`); a longer slug that mentions one
 * (`/how-to-log-out-of-every-device`) is still a page. Not "sign off", which
 * prose uses for an email's closing line (`/a-perfect-sign-off-email`).
 */
const SIGN_OUT_PAIRS = new Set(["log out", "log off", "sign out"]);

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
/**
 * Query parameters that carry a credential: a bearer or session token, a
 * signature, an API key. A URL with one is never requested by a status-only
 * check, and a link key or a report should not keep its value. Matched on the
 * whole parameter name, in any case.
 */
export const CREDENTIAL_PARAM_NAMES: readonly string[] = [
  "access_token",
  "access-token",
  "accesstoken",
  "token",
  "id_token",
  "refresh_token",
  "auth",
  "auth_token",
  "auth-token",
  "authorization",
  "jwt",
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "x-goog-credential",
  "api_key",
  "api-key",
  "x-api-key",
  "apikey",
  "password",
  "passwd",
  "pwd",
  "secret",
  "client_secret",
  "sessionid",
  "session_id",
  "access_key",
  "auth_key",
  "private_key",
];

/**
 * A parameter name as the list is matched: lower case, the name inside the
 * last brackets (`config[api_key]`), with no list index (`api_key[]`,
 * `pwd[0]`), and no `-`, `_` or `.`, so `x_api_key`, `X-Api-Key` and
 * `session-id` match their entries too.
 *
 * One pass from the end, no regex over the brackets: a query key is the
 * page's to write, and an anchored bracket pattern backtracks quadratically
 * on a long run of `[]` or `[\` (#778).
 */
function credentialParamKey(name: string): string {
  const lower = name.toLowerCase();
  // Peel trailing list indexes, `[]` and `[0]`, right to left.
  let end = lower.length;
  while (end > 0 && lower[end - 1] === "]") {
    let i = end - 2;
    while (i >= 0 && lower[i]! >= "0" && lower[i]! <= "9") i--;
    if (i < 0 || lower[i] !== "[") break;
    end = i;
  }
  let key = lower.slice(0, end);
  // The name inside the last brackets, when there is one.
  if (key.endsWith("]")) {
    const open = key.lastIndexOf("[", key.length - 2);
    const inside = open === -1 ? "" : key.slice(open + 1, -1);
    if (inside !== "" && !inside.includes("]")) key = inside;
  }
  return key.replace(/[-_.]/g, "");
}

const CREDENTIAL_PARAM_SET = new Set(CREDENTIAL_PARAM_NAMES.map(credentialParamKey));

/** A JSON Web Token as a query value, whatever the parameter is called. */
const JWT_VALUE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/**
 * True for a query parameter that carries a credential, by its name (matched
 * as {@link credentialParamKey} describes) or a JWT value.
 */
export function isCredentialParam(name: string, value = ""): boolean {
  return CREDENTIAL_PARAM_SET.has(credentialParamKey(name)) || JWT_VALUE.test(value);
}

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

/**
 * A trailing server-script extension (`.aspx`, `.php`, `.do`): an endpoint's
 * name, not a word of it. A static document's (`.html`, `.pdf`) still counts,
 * so `/how-to-verify.html` keeps its verdict.
 */
const SCRIPT_EXTENSION = /\.(?:aspx|asp|ashx|php|jsp|jspx|do|action|cfm|cgi|pl)$/i;

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

/**
 * Action words in one path segment, or (`inQuery`) one query key or value.
 * `reach` is the segment's length in words, its file extension left out.
 */
function hasActionWords(
  parts: string[],
  inQuery: boolean,
  reach = inQuery ? 1 : parts.length,
): boolean {
  for (let i = 0; i < parts.length; i++) {
    const word = parts[i]!;
    if (RUN_TOGETHER_ACTIONS.some((verb) => word.includes(verb))) return true;
    if (ANYWHERE_ACTION_WORDS.has(word)) return true;
    if (reach <= 3 && STRONG_ACTION_WORDS.has(word)) return true;
    if (reach <= 2 && WEAK_ACTION_WORDS.has(word)) return true;
    if (i + 1 < parts.length) {
      const pair = `${word} ${parts[i + 1]}`;
      if (reach <= 4 && ACTION_PAIRS.has(pair)) return true;
      if (reach <= 5 && SIGN_OUT_PAIRS.has(pair)) return true;
    }
  }
  return false;
}

/**
 * Whether a fragment written as `key=value` pairs (`#access_token=…`,
 * `#id_token=…`) carries a secret: a key that names one, as in a query, or a
 * value that looks like a token. A plain anchor (`#pricing`) or a hash route
 * without pairs (`#/settings`) carries none.
 */
function fragmentCarriesCredential(hash: string): boolean {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment.includes("=")) return false;
  for (const [rawKey, rawValue] of new URLSearchParams(fragment)) {
    const key = rawKey.toLowerCase();
    const keyWords = words(rawKey);
    if (SECRET_KEYS.has(key) || keyWords.some((w) => SECRET_KEY_WORDS.has(w) || SESSION_ID_WORDS.has(w))) {
      return true;
    }
    if (isCredentialParam(rawKey) || looksLikeAToken(rawValue)) return true;
  }
  return false;
}

/**
 * A link whose path or query reads like an action rather than a page, or that
 * carries a secret or a one-time token (in its query, path, userinfo or a
 * `key=value` fragment). The internal link probe never
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
    const reach = words(segment.replace(SCRIPT_EXTENSION, "")).length;
    if (hasActionWords(parts, false, reach)) return true;
    if (parts.some((w) => SESSION_ID_WORDS.has(w))) return true;
    if (reach <= 2 && parts.some((w) => SECRET_KEY_WORDS.has(w))) return true;
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
    if (isCredentialParam(rawKey)) return true;
    // A JWT value (isCredentialParam's other half) is a token here too.
    if (looksLikeAToken(rawKey) || looksLikeAToken(rawValue)) return true;
    if (hasActionWords(keyWords, true) || hasActionWords(valueWords, true)) return true;
  }
  // A credential in the fragment (an OAuth implicit-flow redirect,
  // `#access_token=…&token_type=bearer`) is never sent with a request, but the
  // URL is still the credential, and stored or listed it would leak.
  if (fragmentCarriesCredential(parsed.hash)) return true;
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
 * File types a name like `logo@2x.png` ends in. Not `.zip` or `.mov`, which
 * are also top-level domains.
 */
const ASSET_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "tif", "tiff",
  "css", "js", "mjs", "json", "xml", "txt", "html", "htm", "pdf",
  "woff", "woff2", "ttf", "otf", "eot", "mp4", "webm", "mp3", "wav", "ogg", "gz",
]);

/**
 * An email address anywhere in `value`: `user@example.com`, `(a@x.co)`,
 * `a b@x.co` (a `+` decodes to a space), `user@example.com.json` (an address
 * with a file type after it), `user@münchen.de`. A host after the `@` whose
 * last label is letters. An asset name (`logo@2x.png`, `photo@large.jpg`) is
 * kept, and so are a handle (`/@writer`) and a version (`pkg@1.2.3`).
 */
function containsAnEmail(value: string): boolean {
  for (const match of value.matchAll(/[^\s@]@((?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+)/giu)) {
    const labels = match[1]!.split(".");
    const type = labels.at(-1)!.toLowerCase();
    if (ASSET_EXTENSIONS.has(type)) {
      // `user@example.com.json` is an address; `logo@2x.png` a file name.
      if (labels.length <= 2) continue;
      labels.pop();
    }
    if (/^\d+(?:\.\d+)?x$/i.test(labels[0]!)) continue;
    if (/^\p{L}{2,24}$/u.test(labels.at(-1)!)) return true;
  }
  return false;
}

/** A UUID, or a value of 8+ characters mixing letters and digits that is not a file name. */
function looksLikeAnId(value: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  if (/\.[a-z0-9]{2,5}$/i.test(value)) return false;
  // A slug with a word in it (`top-10-tips`, `iphone-15-pro`) names a page.
  if (/[-_]/.test(value) && value.split(/[-_]/).some((part) => /^[a-z]{3,}$/i.test(part))) return false;
  return value.length >= 8 && /[0-9]/.test(value) && /[a-z]/i.test(value);
}

/**
 * `url` as a report may show a link it never requested (repo#2759): every
 * query value masked as `…`, a query key that looks like a token (or is over
 * 40 characters) masked too, and a path segment masked when any part of it
 * (split at `;`, `,`, `=` and an encoded `/`) is a token or id or holds an
 * email address (#774). The reader sees where the link points; the masking is
 * a best effort, not a guarantee that no credential survives. Userinfo and the
 * fragment are dropped. Unparseable input comes back as `…`.
 */
export function maskLinkTokens(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "…";
  }
  const secret = (piece: string) =>
    looksLikeAToken(piece) || looksLikeAnId(piece) || containsAnEmail(piece);
  const path = parsed.pathname
    .split("/")
    .map((segment) => {
      const decoded = decode(segment);
      if (decoded === null) return "…";
      return decoded.split(/[;,=/]/).some(secret) ? "…" : segment;
    })
    .join("/");
  const keys = [...new Set(parsed.searchParams.keys())].map((key) =>
    key.length > 40 || secret(key) ? "…" : encodeURIComponent(key),
  );
  const query = keys.length > 0 ? `?${[...new Set(keys)].map((k) => `${k}=…`).join("&")}` : "";
  return `${parsed.protocol}//${parsed.host}${path}${query}`;
}
