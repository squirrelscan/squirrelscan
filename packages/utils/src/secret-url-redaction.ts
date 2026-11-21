/**
 * Redact the secrets a crawled page URL can carry, before a published report is
 * stored (#3014): a credential or per-visitor parameter's value (`?token=`,
 * `?X-Amz-Signature=`, `;jsessionid=`, `#access_token=`, also percent-encoded
 * once or twice inside another parameter, as in `?next=%2Freset%3Ftoken%3D…`),
 * a one-time token in a path after a word that says so (`/reset/<hex>`), the
 * key of a WordPress password-reset link, userinfo (`user:pass@`), a JSON Web
 * Token anywhere, and a cookieless ASP.NET session segment (`/(S(…))/`).
 *
 * Shared by the API (the publish schema, the chunked ingest) and the cloud
 * container (which redacts and dedupes its finding lines BEFORE it counts them
 * for the chunked publish, so the server's received-count gate sees the same
 * rows it was promised).
 *
 * The result is a DETERMINISTIC rewrite, never a drop: these URLs are join keys
 * (`pages[].url`, a check's `pages`, an item's `sourcePages`, `pageStatuses`,
 * page_findings and site_pages rows), so every copy of one page has to become
 * the same string, in this audit and the next, or merges, issue sync and audit
 * diffs stop matching. A value becomes {@link REDACTED_VALUE}, the parameter's
 * name stays, and every other byte is kept, so a URL with nothing to redact
 * comes back as the same string, and none comes back longer.
 *
 * WHAT counts as a secret is held to the value as well as the name: a
 * parameter whose name can also mean content (`token`, `auth`, `sig`, `sid`,
 * `session`, `ticket`, `nonce`, `*_token`) is redacted only when its value
 * looks like a token (long, opaque: hex, base64, an unbroken run of letters and
 * digits, a UUID, a JWT), never a short value, a number, a word or an `0x`
 * address (an `0x` hash too, except under `token`, `*_token` and `nonce`, and a
 * UUID under `session` and `ticket` is a record's id); one whose name never
 * does (`jsessionid`, `PHPSESSID`, `CFID`, `_wpnonce`, `X-Amz-Signature`,
 * `api_key`, a `*_token` or `*_nonce` after a credential word: `reset_token`,
 * `confirmation_token`, `csrf_token`), a password, userinfo and a WordPress
 * reset key whatever the value. `/token?token=USDC`, `/books?auth=tolkien`,
 * `?sid=42` (a story) and `?session=2026` are pages, and folding them into one
 * would lose distinct pages (#2063). Names match as whole
 * words at the END of the name (`reset_token`, `csrfToken`, `oauth_verifier`),
 * so `tokenId`, `sessions`, `event_ticket_type` and `ticket_id` are content,
 * and pagination cursors (`page_token`, `next_token`) are kept.
 *
 * Per-visitor values (session ids, tickets, nonces, matrix and path tokens, a
 * cookieless ASP.NET segment) are redacted only in the audited site's own URLs
 * (relative ones, and absolute ones on a host the crawl reached) and in URLs
 * nested in their queries; credentials, userinfo and JWTs in every URL. The
 * passes run until nothing changes (a few rounds at most), so a replacement
 * that changes what another pass reads is still idempotent; an input built to
 * need more rounds is the known limit. A link to another site keeps its session
 * parameters because the link checker keys its shared verdicts on them
 * (`canonicalLinkKey` drops credential parameters, never session ones), and a
 * redacted copy would match no verdict.
 *
 * Works on any text, not only on a whole URL: a check message or an item label
 * that quotes a URL is redacted the same way. A value ends at whitespace, a
 * quote, an angle bracket or a backslash, so text inside a JSON string never
 * loses an escape, except that a `;`, `'` or `\` with more of the value glued
 * on (`token=<a>;<b>`) is read as part of it. Every pass is linear in the text.
 *
 * Path tokens (#3433) are also read in a hash route (`/#/reset/<t>`), in a
 * path percent-encoded in a value (`?next=%2Freset%2F<t>`), before a markdown
 * link's `)` or a file extension, after a split or plural word (`/sign-in/`,
 * `/account_activations/`) or a word between (`/invite/accept/<t>`), and in
 * Django's and django-allauth's shapes (`/reset/<uidb64>/<ts>-<hex>/`,
 * `/confirm-email/<v>:<ts>:<sig>/`). A short value is a secret under a
 * credential word's code or key (`otp_code`, `activation_key`) and as the
 * OAuth `code` on the site's callback URL.
 *
 * Out of scope, on purpose: a site obfuscating its own tokens (an escaped JWT
 * header character, a third level of percent-encoding), a short one-time code
 * under a bare name (`?otp=123456` is the same shape as a page number), and a
 * 16 to 19 character token of one letter case and digits under an ambiguous
 * name (`?sid=a1b2c3d4e5f6g7h8` is a slug's shape; mixed case is caught). Known
 * gap on a crawl that spans several hosts: a page host that only a compact
 * resolution signal names (decoded after this runs) is not the site's in free
 * text.
 */

import { clampItemId } from "@squirrelscan/core-contracts/clamp";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";

/** What a redacted value becomes in anything stored or printed (link-check's marker). */
export const REDACTED_VALUE = "REDACTED";

/** The shortest base64url JOSE header that can hold an `alg` (`{"alg":"x"}`). */
const MIN_JWT_HEADER = 10;

/**
 * A JWT header: base64url that decodes to a JSON object with a string `alg`.
 * Hostnames and file names have the `a.b.c` shape too; this is what tells them
 * apart, whatever the header starts with and however short the payload.
 */
export function isJwtHeader(part: string): boolean {
  if (part.length < MIN_JWT_HEADER) return false;
  let header: string;
  try {
    header = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return false;
  }
  if (!header.trimStart().startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(header);
    return (
      !!parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { alg?: unknown }).alg === "string"
    );
  } catch {
    return false;
  }
}

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * Credential names, redacted in every URL: link-check's list
 * (`CREDENTIAL_PARAM_NAMES`), matched without `-`, `_` and `.` so
 * `X-Amz-Signature`, `access-token` and `api.key` match too. The value has to
 * look like a token unless the name never names content
 * ({@link NEVER_CONTENT_KEYS}).
 */
const CREDENTIAL_KEYS = new Set(
  [
    "access_token",
    "token",
    "id_token",
    "refresh_token",
    "auth",
    "auth_token",
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
    "x-api-key",
    "apikey",
    "secret",
    "client_secret",
    "sessionid",
    "session_id",
    // (#3347) Key and token names the lists above missed: a generic or app key
    // (a Laravel `base64:` prefix is read past, #3433), a GitLab token,
    // an Azure Cognitive/API Management key, a Rails signed global id, Django's
    // CSRF field, a Firebase out-of-band code.
    "access_key",
    "secret_key",
    "app_key",
    "private_token",
    "subscription_key",
    "ocp_apim_subscription_key",
    "sgid",
    "csrfmiddlewaretoken",
    "oobcode",
  ].map((name) => name.replace(/[-_.]/g, ""))
);

/** Redacted in every URL whatever the value: nothing a page serves is chosen by a password. */
const PASSWORD_KEYS = new Set(["password", "passwd", "pwd"]);

/**
 * Per-visitor names, besides those ending in one of {@link SESSION_WORDS}:
 * session ids (Java, PHP, ColdFusion, generic), tickets, nonces and token-auth
 * values (Akamai, SAML relay state). Redacted in the site's own URLs, when the
 * value is a token unless the name never names content
 * ({@link NEVER_CONTENT_KEYS}).
 */
const SESSION_KEYS = new Set([
  "sid",
  "session",
  "sess",
  "sessid",
  "phpsessid",
  "jsessionid",
  "cfid",
  "cftoken",
  "ticket",
  "nonce",
  "hmac",
  "hdnts",
  "relaystate",
  "samlresponse",
  "samlrequest",
  "wpnonce",
]);

/**
 * The last word of a name that makes it per-visitor (`reset_token`,
 * `csrfToken`, `session_id` is a credential above): a whole word at the end, so
 * `tokenId`, `sessions` and `nonce_page` do not match.
 */
const SESSION_WORDS =
  /(?:^|_)(?:token|sess|session|sessid|sid|nonce|csrf|xsrf|verifier|ticket)$/;

/** Cursors that page a list: per-request, but each value is a different page. */
const PAGINATION_NAMES =
  /(?:^|_)(?:page|next|prev|previous|continuation|cursor|sync|page_next)_token$/;

/** How many times a parameter name is percent-decoded: it can sit two levels deep. */
const NAME_DECODE_ROUNDS = 2;

/**
 * A parameter name as the lists match it: percent-decoded, the name inside its
 * last brackets (`auth[token]`), with no list index (`token[]`), the last part
 * of a dotted name (`user.token`), camelCase split into words, lowercase.
 * Peeled from the end without a regex over the brackets, so a long run of `[]`
 * cannot backtrack (link-actions #778).
 */
function paramWords(rawName: string): string {
  let name = rawName;
  for (
    let round = 0;
    round < NAME_DECODE_ROUNDS && name.includes("%");
    round++
  ) {
    try {
      name = decodeURIComponent(name);
    } catch {
      break;
    }
  }
  // A list index, empty or numeric (`token[]`, `reset_token[0]`, #3433).
  let end = name.length;
  for (;;) {
    if (end < 2 || name[end - 1] !== "]") break;
    let open = end - 2;
    while (open >= 0 && name[open]! >= "0" && name[open]! <= "9") open--;
    if (open < 0 || name[open] !== "[") break;
    end = open;
  }
  name = name.slice(0, end);
  if (name.endsWith("]")) {
    const open = name.lastIndexOf("[");
    const inside = open === -1 ? "" : name.slice(open + 1, -1);
    if (inside !== "") name = inside;
  }
  name = name.slice(name.lastIndexOf(".") + 1);
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/-/g, "_");
}

/** A credential name ({@link CREDENTIAL_KEYS}). */
function isCredentialName(words: string): boolean {
  return (
    CREDENTIAL_KEYS.has(words.replace(/_/g, "")) ||
    words.endsWith("_access_token") ||
    // `ASP.NET_SessionId`, `my_session_id`.
    /_session_?id$/.test(words)
  );
}

/**
 * Names that never select what a page shows (#3339 review N2): a session id the
 * server wrote into its links, a signature, a key. Their values are redacted
 * whatever their shape, because real ones are not always token-shaped: a
 * WebSphere `0000…:1a2b…`, a WebLogic `…!-123!456`, a Tomcat route suffix, a
 * PHP id with a `,`, a numeric ColdFusion CFID, a 10-hex WordPress nonce, a
 * Devise token with no digit. The other names (`token`, `auth`, `sig`, `sid`,
 * `session`, `ticket`, `nonce`, any other `*_token`) can also name content, so
 * only a token-shaped value is redacted.
 */
const NEVER_CONTENT_KEYS = new Set(
  [
    "access_token",
    "id_token",
    "refresh_token",
    "auth_token",
    "authorization",
    "jwt",
    "signature",
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
    "x-goog-signature",
    "x-goog-credential",
    "api_key",
    "x-api-key",
    "apikey",
    "secret",
    "client_secret",
    "sessionid",
    "session_id",
    "sessid",
    "phpsessid",
    "jsessionid",
    "cfid",
    "cftoken",
    "hdnts",
    "relaystate",
    "samlresponse",
    "samlrequest",
    "wpnonce",
    // (#3347) Names that only ever carry a secret: not `access_key` and `app_key`
    // (a page can have its own `accesskey`), nor `subscription_key` (a plan
    // selector is plausible) or `csrfmiddlewaretoken`, whose real values are
    // token-shaped anyway; those need a token-shaped value.
    "secret_key",
    "private_token",
    "sgid",
    "oobcode",
  ].map((name) => name.replace(/[-_.]/g, ""))
);

/**
 * A `*_token`, `*_nonce`, `*_ticket`, `*_code` or `*_key` with a word before
 * it that makes it a credential (#3339 review round 3, #3433), right before or
 * not (`confirmation_token`, `reset_user_token`, `invite_token`,
 * `remember_token`, `csrf_token`, `oauth_nonce`, `otp_code`, `activation_key`,
 * `sso_ticket`). Devise, Laravel and most auth kits name theirs this way; none
 * selects a page, and a one-time code under one is short (`otp_code=123456`).
 * A code or key under any other word (`promo_code`, `sort_key`) is content.
 * Pagination cursors are excluded before this is asked.
 */
const CREDENTIAL_TOKEN_NAME =
  /(?:^|_)(?:reset|verify|verification|confirm|confirmation|invite|invitation|magic|login|activate|activation|unlock|unsubscribe|remember|csrf|xsrf|session|oauth|password|email|sso|otp)_(?:[a-z0-9]+_)*(?:token|nonce|ticket|code|key)$/;

/** A name that never selects content ({@link NEVER_CONTENT_KEYS}, {@link CREDENTIAL_TOKEN_NAME}). */
function isNeverContentName(words: string): boolean {
  return (
    NEVER_CONTENT_KEYS.has(words.replace(/_/g, "")) ||
    // Akamai token auth's `__token__` (`exp=…~acl=…~hmac=…`, not token-shaped):
    // plain `token` names content, this does not.
    words === "__token__" ||
    CREDENTIAL_TOKEN_NAME.test(words) ||
    words.endsWith("_access_token") ||
    /_session_?id$/.test(words) ||
    words.startsWith("aspsessionid") ||
    words.startsWith("__cf_chl")
  );
}

/**
 * Ambiguous names whose UUID value is as often a record's id as a secret
 * (`?session=<uuid>` a conference session, `?ticket=<uuid>` an event's or a
 * support ticket): a UUID alone does not make their value a secret. Under
 * `sid` it does: a story id is a number, a session id a token.
 */
const UUID_ID_KEYS = new Set(["session", "ticket"]);

/**
 * Names under which an `0x` + 64 hex value is a secret, not a transaction
 * hash: a token or nonce is 32 random bytes as often as not. An `0x` + 40 hex
 * address stays an id (`?token=0x6b17…`, a coin).
 */
const HASH_IS_SECRET_NAME = /(?:^|_)(?:token|nonce)$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A per-visitor name ({@link SESSION_KEYS}, {@link SESSION_WORDS}), not a page cursor. */
export function isSessionName(rawName: string): boolean {
  const words = paramWords(rawName);
  if (PAGINATION_NAMES.test(words)) return false;
  return (
    SESSION_KEYS.has(words.replace(/_/g, "")) ||
    SESSION_WORDS.test(words) ||
    // A credential word's code or key (`otp_code`, `activation_key`, #3433).
    CREDENTIAL_TOKEN_NAME.test(words) ||
    words.startsWith("aspsessionid") ||
    words.startsWith("__cf_chl")
  );
}

// ── Values ───────────────────────────────────────────────────────────────────

/**
 * Which `0x` hex values are ids, not tokens: an address (40 hex) and a hash
 * (64) (`"both"`, the default), an address only (`"address"`), or neither
 * (`"none"`, where the context says the value is a credential).
 */
export type ZeroXIds = "both" | "address" | "none";

/**
 * A value that is a token, not a name or a number: a JWT, a UUID, hex of 16 or
 * more, a run of 20 or more letters and digits with no separator, or 20 or
 * more base64 characters mixing digits with both cases. Slugs and words have
 * separators or no digits; ids are digits, and an `0x` address or hash is an
 * id too unless `zeroXIds` says otherwise. Percent-decoded first.
 */
export function looksLikeAToken(
  raw: string,
  zeroXIds: ZeroXIds = "both"
): boolean {
  const value = tokenCore(raw);
  if (value.length < 16 || /\s/.test(value)) return false;
  // An Ethereum-style address or hash (`/token/0x6b17…`, `/tx/0x…`) is a page's id.
  if (zeroXIds !== "none" && /^0x[0-9a-f]{40}$/i.test(value)) return false;
  if (zeroXIds === "both" && /^0x[0-9a-f]{64}$/i.test(value)) return false;
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/.test(value))
    return true;
  if (UUID.test(value)) return true;
  if (/^\d+$/.test(value)) return false;
  if (/^[0-9a-f]{16,}$/i.test(value)) return true;
  if (
    /^[A-Za-z0-9]{20,}$/.test(value) &&
    /\d/.test(value) &&
    /[A-Za-z]/.test(value)
  )
    return true;
  // A session id can be letters only (PHP, ASP.NET); no word runs on for 24.
  if (/^[A-Za-z0-9]{24,}$/.test(value)) return true;
  return (
    value.length >= 20 &&
    /^[A-Za-z0-9+/_.~-]+={0,2}$/.test(value) &&
    /\d/.test(value) &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value)
  );
}

/**
 * A value as {@link looksLikeAToken} judges it: percent-decoded once, without
 * the braces a COM-style GUID is written in (`{3f2a…}`, `?sid={uuid}`) or the
 * `base64:` prefix of a Laravel `APP_KEY` (#3433).
 */
function tokenCore(raw: string): string {
  const value = percentDecoded(raw);
  if (value.startsWith("{") && value.endsWith("}")) return value.slice(1, -1);
  return /^base64:/i.test(value) ? value.slice(7) : value;
}

/**
 * A random 16 to 19 character run of letters and digits (#3433): every class
 * in it (upper, lower, digit), and the class changing at least every other
 * character, so a camelCase run of words and numbers (`KeynoteDay1Track2`) is
 * not one. Asked only under an ambiguous name; {@link looksLikeAToken} starts
 * at 20.
 */
function looksLikeAShortToken(raw: string): boolean {
  const value = percentDecoded(raw);
  if (!/^[A-Za-z0-9]{16,19}$/.test(value)) return false;
  if (!/\d/.test(value) || !/[a-z]/.test(value) || !/[A-Z]/.test(value))
    return false;
  const kind = (ch: string) =>
    ch >= "0" && ch <= "9" ? 0 : ch >= "a" && ch <= "z" ? 1 : 2;
  let changes = 0;
  for (let i = 1; i < value.length; i++)
    if (kind(value[i]!) !== kind(value[i - 1]!)) changes++;
  return changes * 2 >= value.length - 1;
}

/** A value percent-decoded once, as {@link looksLikeAToken} judges it; as written when it does not decode. */
function percentDecoded(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** What replaces a value this long: the marker, or as many `*` when the marker would be longer. */
function replacementFor(length: number): string {
  return length >= REDACTED_VALUE.length ? REDACTED_VALUE : "*".repeat(length);
}

// ── Site scope ───────────────────────────────────────────────────────────────

/**
 * The audited site's hosts, for telling its own URLs from links to other sites:
 * every host the crawl reached (the base URL's and its pages'), lowercase,
 * without `www.`. `null` treats every URL as the site's own.
 */
export type SiteHosts = ReadonlySet<string> | null;

function hostKey(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/** A host as the URL parser canonicalizes it (punycode, escapes), keyed by {@link hostKey}. */
function canonicalHostKey(host: string): string {
  try {
    return hostKey(new URL(`http://${host}/`).hostname);
  } catch {
    return hostKey(host);
  }
}

/** The {@link SiteHosts} of these URLs; `null` when none of them parses. */
export function siteHostsOf(urls: Iterable<unknown>): SiteHosts {
  const hosts = new Set<string>();
  for (const url of urls) {
    if (typeof url !== "string") continue;
    try {
      hosts.add(hostKey(new URL(url).hostname));
    } catch {
      // Not a URL: no host to add.
    }
  }
  return hosts.size > 0 ? hosts : null;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** The page URLs one check names: its page, its pages, and its items' source pages. */
function checkPageUrls(check: unknown, into: unknown[]): void {
  const c = asRecord(check);
  if (!c) return;
  into.push(c.pageUrl, ...asArray(c.pages));
  for (const item of asArray(c.items)) {
    const i = asRecord(item);
    into.push(...asArray(i?.sourcePages));
    for (const source of asArray(i?.sources)) into.push(asRecord(source)?.page);
  }
}

/**
 * Every host a report's crawl reached, from every field that names a crawled
 * page: the base URL, `pages[].url`, every check's page, pages and items'
 * source pages, `pageStatuses`, the summary lists and the resolution signal's
 * crawled pages, and any `alsoUrls` (the container's streamed finding pages,
 * which a sampled shell can leave out). Raw or redacted, a URL has the same
 * host, so the publish schema, the container and the later signal translation
 * agree.
 */
export function reportSiteHosts(
  report: unknown,
  alsoUrls: Iterable<unknown> = []
): SiteHosts {
  const r = asRecord(report);
  const urls: unknown[] = [...alsoUrls];
  if (!r) return siteHostsOf(urls);
  urls.push(r.baseUrl);
  for (const page of asArray(r.pages)) {
    const p = asRecord(page);
    urls.push(p?.url);
    for (const check of asArray(p?.checks)) checkPageUrls(check, urls);
  }
  for (const check of asArray(r.siteChecks)) checkPageUrls(check, urls);
  for (const rule of Object.values(asRecord(r.ruleResults) ?? {})) {
    for (const check of asArray(asRecord(rule)?.checks))
      checkPageUrls(check, urls);
  }
  for (const row of asArray(r.pageStatuses)) urls.push(asRecord(row)?.url);
  for (const list of Object.values(asRecord(r.summary) ?? {})) {
    for (const entry of asArray(list)) {
      urls.push(typeof entry === "string" ? entry : asRecord(entry)?.url);
    }
  }
  urls.push(...asArray(asRecord(r.resolutionSignal)?.crawledUrls));
  return siteHostsOf(urls);
}

/**
 * Characters that end a URL in running text: ASCII and Unicode whitespace (what
 * `\s` matches, so the value ends the parameter passes use agree), quotes and
 * angle brackets.
 */
const URL_BOUNDARY = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
  '"',
  "'",
  "<",
  ">",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
]);
/** Where a plain authority ends. */
const AUTHORITY_END = new Set(["/", "?", "#", ";", "\\"]);
/** Where a percent-encoded one ends (`%2F`, `%3F`, `%23`, `%3B`, `%26`) or the outer value does. */
const ENCODED_AUTHORITY_END = /%2F|%3F|%23|%3B|%26|[&/?#;\\\s"'<>]/gi;
/** The same, encoded twice. */
const TWICE_ENCODED_AUTHORITY_END =
  /%252F|%253F|%2523|%253B|%2526|[&/?#;\\\s"'<>]/gi;
/** An authority's start, percent-encoded once or twice: after a scheme, or protocol-relative. */
const ENCODED_AUTHORITY_START: [RegExp, number, 1 | 2][] = [
  [/^%3A%2F%2F/i, 9, 1],
  [/^%253A%252F%252F/i, 15, 2],
];
const ENCODED_RELATIVE_START: [RegExp, number, 1 | 2][] = [
  [/^%2F%2F/i, 6, 1],
  [/^%252F%252F/i, 10, 2],
];

/**
 * What a position in `text` is part of, read in ONE forward pass however many
 * positions are asked about (each must be at or after the last): the URL whose
 * authority came last before it (after `://`, a protocol-relative `//` at the
 * start of a run or of a value, or an encoded `%3A%2F%2F`, so a parameter
 * inside a nested `?next=https://other.example/…` belongs to that URL), the
 * run's root URL (the one whose query came first), whether a `?` or `#` (or
 * `%3F`, `%23`) came after the authority, so a `;` is a query separator and
 * not a matrix parameter, and the run's last WordPress reset link query
 * (`isWpResetQuery`, asked at each raw `?`). One level of nesting is tracked:
 * the outer URL resumes where the nested value ends, at the outer query's next
 * raw `&`, `;` or `#`.
 */
function urlCursor(
  text: string,
  site: SiteHosts,
  isWpResetQuery: (query: number) => boolean = () => false
) {
  let pos = 0;
  let authority = -1;
  /** How many times the current authority is percent-encoded. */
  let encoded: 0 | 1 | 2 = 0;
  let query = false;
  /** The `?` of the run's last WordPress reset link query. */
  let wpQuery = -1;
  /** Where the last value read past by `skip` ended: text before it is being replaced. */
  let skippedTo = -1;
  let outer: { authority: number; encoded: 0 | 1 | 2 } | null = null;
  /** The URL whose query is the run's first: every URL nested in its query is in it. */
  let root: { authority: number; encoded: 0 | 1 | 2 } | null = null;
  /** Each authority's answer, by where it starts: nested and outer URLs alternate. */
  const decisions = new Map<number, boolean>();
  const startAuthority = (at: number, levels: 0 | 1 | 2) => {
    // An authority inside a query is a URL nested in one of its values, the
    // outer URL relative (`authority` -1) or not.
    outer = query ? { authority, encoded } : null;
    authority = at;
    encoded = levels;
    query = false;
  };
  /** At the start of a run or of a parameter value: where a protocol-relative URL can begin. */
  const valueStart = (at: number) =>
    at === 0 || URL_BOUNDARY.has(text[at - 1]!) || text[at - 1] === "=";
  /** An encoded authority marker at `at`: starts it, moves `pos` past it, and says so. */
  const encodedAuthority = (at: number): boolean => {
    const ahead = text.slice(at, at + 15);
    const markers = valueStart(at)
      ? [...ENCODED_AUTHORITY_START, ...ENCODED_RELATIVE_START]
      : ENCODED_AUTHORITY_START;
    for (const [marker, length, levels] of markers) {
      if (marker.test(ahead)) {
        startAuthority(at + length, levels);
        pos = at + length - 1;
        return true;
      }
    }
    return false;
  };
  /** Whether the URL with this authority (-1: relative) is one of the site's own. */
  const isSite = (at: number, levels: 0 | 1 | 2): boolean => {
    if (site === null || at === -1) return true;
    let onSite = decisions.get(at);
    if (onSite === undefined) {
      let host: string;
      if (levels > 0) {
        const end =
          levels === 2 ? TWICE_ENCODED_AUTHORITY_END : ENCODED_AUTHORITY_END;
        end.lastIndex = at;
        host = text.slice(at, end.exec(text)?.index ?? text.length);
        for (let round = 0; round < levels; round++) {
          try {
            host = decodeURIComponent(host);
          } catch {
            // Compared as far as it decodes.
          }
        }
      } else {
        let end = at;
        while (
          end < text.length &&
          !AUTHORITY_END.has(text[end]!) &&
          !URL_BOUNDARY.has(text[end]!)
        ) {
          end++;
        }
        host = text.slice(at, end);
      }
      host = host.slice(host.lastIndexOf("@") + 1).replace(/:\d*$/, "");
      onSite = site.has(canonicalHostKey(host));
      decisions.set(at, onSite);
    }
    return onSite;
  };
  return {
    seek(index: number): void {
      for (; pos < index; pos++) {
        const ch = text[pos]!;
        if (URL_BOUNDARY.has(ch)) {
          authority = -1;
          query = false;
          wpQuery = -1;
          outer = null;
          root = null;
        } else if (outer !== null && (ch === "&" || ch === ";" || ch === "#")) {
          ({ authority, encoded } = outer);
          query = true;
          outer = null;
        } else if (
          ch === ":" &&
          text[pos + 1] === "/" &&
          text[pos + 2] === "/"
        ) {
          startAuthority(pos + 3, 0);
          pos += 2;
        } else if (ch === "/" && text[pos + 1] === "/" && valueStart(pos)) {
          startAuthority(pos + 2, 0);
          pos += 1;
        } else if (ch === "%" && encodedAuthority(pos)) {
          // `pos` moved past the marker.
        } else if (ch === "?" || ch === "#") {
          // Not after a value being replaced (`;password=wp-login.php?`).
          if (
            ch === "?" &&
            pos - "wp-login.php".length >= skippedTo &&
            isWpResetQuery(pos)
          ) {
            wpQuery = pos;
          }
          root ??= { authority, encoded };
          query = true;
        } else if (
          ch === "%" &&
          /^%(?:3F|23)/i.test(text.slice(pos, pos + 3))
        ) {
          root ??= { authority, encoded };
          query = true;
        }
      }
    },
    /**
     * Read past a value that is being replaced by a marker (no URL syntax), as
     * if the marker were there, so what follows it is judged as it will be in
     * the output and a second pass agrees with the first.
     */
    skip(index: number): void {
      pos = Math.max(pos, index);
      skippedTo = pos;
    },
    /** In the query or fragment of its URL, not in the path. */
    inQuery(): boolean {
      return query;
    },
    /** The `?` of the run's last WordPress reset link query so far; -1 for none. */
    wpResetQuery(): number {
      return wpQuery;
    },
    /**
     * In one of the site's own URLs (a relative one, or one on a host the crawl
     * reached), or in a URL nested in the query of one. The root is decided
     * before any value can be replaced, so a nested URL a later pass removes
     * never changes this answer for the site's own URLs.
     */
    onSite(): boolean {
      return (
        isSite(authority, encoded) ||
        (root !== null && isSite(root.authority, root.encoded))
      );
    },
  };
}

// ── Passes ───────────────────────────────────────────────────────────────────

/** Anything here needs one of these: a separator, `@`, `%`, `(`, a dot or a slash. */
const MIGHT_CARRY_SECRET = /[?;#@%(./]/;
/**
 * Something shaped like a JSON Web Token: three base64url parts joined by dots,
 * plain or percent-encoded. It starts at a word boundary, right after a `%XX`
 * escape (`%3DeyJ…` inside an encoded parameter), or at an `eyJ` glued to a
 * word (`/verify/user-eyJ…`, `?t=tok_eyJ…`). Host names and dotted file names
 * have the shape too: {@link isJwtHeader} is what tells them apart. The header
 * part is bounded (a JOSE header is short), so a failed start costs at most
 * that much however long the run, and the retries stay linear.
 */
const JWT_CANDIDATE =
  /(?:(?<=^|[^A-Za-z0-9_-]|%[0-9A-Fa-f]{2}|%25[0-9A-Fa-f]{2})|(?=eyJ))[A-Za-z0-9_-]{10,512}(?:\.|%2[Ee]|%252[Ee])[A-Za-z0-9_-]+(?:\.|%2[Ee]|%252[Ee])[A-Za-z0-9_-]*/g;
/** Where a JWT's header can start: a JOSE header is a JSON object, `{"`, `{ `, `{\n`. */
const JWT_HEADER_START = /e[yw]/;
/** The end of a JWT candidate's header part. */
const JWT_SEPARATOR = /\.|%2[Ee]|%252[Ee]/;
/**
 * Userinfo in an absolute or protocol-relative URL: everything between `//` and
 * the LAST `@` of the authority, as a URL parser reads it, so a raw `@` in a
 * password (`u:p@ss@host`) goes with it.
 */
const USERINFO = /((?:\bhttps?:)?\/\/)[^\s/?#"'<>\\]+@/gi;
/**
 * The same in a URL percent-encoded once or twice inside a parameter
 * (`https%3A%2F%2Fu%3Ap%40host`, `%2F%2Fu%3Ap%40host`, `https%253A%252F%252F…%2540`),
 * once-encoded ending at a raw `@` too (half-encoded).
 */
const ENCODED_USERINFO =
  /((?:https?%3A)?%2F%2F)(?:(?!%2F|%3F|%23)[^\s/?#"'<>\\&])*(?:%40|@)/gi;
const TWICE_ENCODED_USERINFO =
  /((?:https?%253A)?%252F%252F)(?:(?!%252F|%253F|%2523)[^\s/?#"'<>\\&])*%2540/gi;
/**
 * A cookieless ASP.NET session, auth or forms ticket segment, alone or several
 * together: `/(S(lit3py55t21z5v55vlm25s55))/`, `/(A(x_y-z…)S(…))/`.
 */
const ASPNET_COOKIELESS = /\((?:[SAF]\([A-Za-z0-9_-]{8,}\))+\)/g;
const ASPNET_PART = /([SAF])\([A-Za-z0-9_-]{8,}\)/g;

/** A query, matrix or fragment parameter's start: its separator, then `name=`. */
const PARAM_START = /([?&;#])([^=&?;#\s"'<>\\]{1,128})=/g;
/** Where a query or fragment value ends. It can hold `/` and `?` (a nested URL). */
const QUERY_VALUE_END = /[&;#\s"'<>\\]/g;
/** Where a matrix parameter's value ends: also at the next path segment or the query. */
const MATRIX_VALUE_END = /[/?&;#\s"'<>\\]/g;
/**
 * Value ends that can sit INSIDE a value (`token=<a>;<b>`, `<a>'<b>`, `<a>\<b>`):
 * one glued to a value character on its right does not end it, unless a `;`
 * starts the next parameter. A JSON escape (`\"`, `\\`) still ends it.
 */
const GLUE_ENDS = new Set([";", "'", "\\"]);
const VALUE_CHAR = /[A-Za-z0-9_~.%-]/;
/** A parameter's `name=` at a position (sticky). */
const PARAM_AHEAD = /[^=&?;#\s"'<>\\]{1,128}=/y;

/** Whether the value end at `to` is glued inside the value (see {@link GLUE_ENDS}). */
function gluedEnd(text: string, to: number): boolean {
  if (!GLUE_ENDS.has(text[to]!) || !VALUE_CHAR.test(text[to + 1] ?? ""))
    return false;
  if (text[to] !== ";") return true;
  PARAM_AHEAD.lastIndex = to + 1;
  return !PARAM_AHEAD.test(text);
}

/** A nested query's start at `at`: `?`, or one encoded once or twice. */
function isNestedQueryAt(text: string, at: number): boolean {
  const ch = text[at];
  return (
    ch === "?" || (ch === "%" && /^%(?:25)?3F/i.test(text.slice(at, at + 5)))
  );
}

/**
 * Where a value starting at `from` ends, for each `end` pattern: the first end
 * not glued inside it. Whether an end is glued depends only on where it is, so
 * an answer holds for every later start up to it, and a run of candidates
 * nested in one value shares a single scan.
 */
function valueEnds(text: string) {
  const last = new Map<RegExp, { from: number; to: number }>();
  return (end: RegExp, from: number): number => {
    const known = last.get(end);
    if (known && from >= known.from && from <= known.to) return known.to;
    end.lastIndex = from;
    let to = end.exec(text)?.index ?? text.length;
    while (to < text.length && gluedEnd(text, to)) {
      end.lastIndex = to + 1;
      to = end.exec(text)?.index ?? text.length;
    }
    last.set(end, { from, to });
    return to;
  };
}

/**
 * The same, percent-encoded inside another parameter's value, once (`%3F`) or
 * twice (`%253F`), its `=` encoded or not (`%3Ftoken=…` half-encoded). A name's
 * own characters can be escaped too (`%74oken`), but never as a separator or
 * `=`.
 */
function encodedParamPatterns(pct: "%" | "%25") {
  const sep = ["3F", "26", "3B", "23"].map((hex) => `${pct}${hex}`).join("|");
  const nameEscape = `${pct}(?!3[DdFfBb]|26|23)[0-9A-Fa-f]{2}`;
  const valueEnd = `${pct}26|${pct}3B|${pct}23|[&;#\\s"'<>\\\\]`;
  return {
    start: new RegExp(
      `(${sep})((?:[A-Za-z0-9._~\\[\\]-]|${nameEscape}){1,128})(?:${pct}3D|=)`,
      "gi"
    ),
    end: new RegExp(valueEnd, "gi"),
    // A matrix parameter's value also ends at the next segment or the query.
    matrixEnd: new RegExp(`${pct}2F|${pct}3F|${valueEnd}`, "gi"),
  };
}
const ENCODED_ONCE = encodedParamPatterns("%");
const ENCODED_TWICE = encodedParamPatterns("%25");

/** Where a WordPress reset link's query ends: its `#`, or the run's (not at a `'`, see below). */
const WP_QUERY_END = new Set([
  "#",
  " ",
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
  '"',
  "<",
  ">",
]);
/** `wp-login.php` right before a query's `?`, a path segment or a whole value. */
const WP_LOGIN_PATH = /(?:^|[/=\s"'<>])wp-login\.php$/i;
/** The end of a reset action's value: where the value does (a `;`, `'` or `\` glued on does not end it). */
const WP_ACTION_END = `(?=[&#"\\s<>]|$|[;'\\\\](?![A-Za-z0-9_~.%-])|;[^=&?;#\\s"'<>\\\\]{1,128}=)`;
/**
 * A reset action as a query's first parameter (sticky, at its `?`), or as a
 * later one, after an `&` or an HTML-escaped `&amp;` (an `outerHTML` snippet).
 */
const WP_FIRST_RESET_ACTION = new RegExp(
  `\\?action=(?:rp|resetpass)${WP_ACTION_END}`,
  "iy"
);
const WP_RESET_ACTION = new RegExp(
  `&(?:amp;)?action=(?:rp|resetpass)${WP_ACTION_END}`,
  "gi"
);

/**
 * Where the query starting at a raw `?` ends when it is a WordPress
 * password-reset link's (after `wp-login.php`, with an `action=rp` or
 * `resetpass` of its own before its `#`), else -1; its `key` is the reset
 * key. Past the `?` this reads only what never sits inside a parameter value
 * (an `&` parameter, a `#`, a run's end, which here is not at a `'`), so a
 * second pass, which sees the text with values replaced, answers the same. The
 * positions are indexed once, at the first question that needs them.
 */
function wpResetQueries(text: string) {
  let actions: number[] | null = null;
  const ends: number[] = [];
  /** The first position in a sorted list after `at`, or the text's end. */
  const firstAfter = (list: readonly number[], at: number): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! <= at) lo = mid + 1;
      else hi = mid;
    }
    return list[lo] ?? text.length;
  };
  return (query: number): number => {
    if (
      query < 0 ||
      !WP_LOGIN_PATH.test(text.slice(Math.max(0, query - 13), query))
    )
      return -1;
    if (actions === null) {
      actions = Array.from(text.matchAll(WP_RESET_ACTION), (m) => m.index);
      for (let i = 0; i < text.length; i++)
        if (WP_QUERY_END.has(text[i]!)) ends.push(i);
    }
    const end = firstAfter(ends, query);
    WP_FIRST_RESET_ACTION.lastIndex = query;
    return WP_FIRST_RESET_ACTION.test(text) || firstAfter(actions, query) < end
      ? end
      : -1;
  };
}

/**
 * The path an OAuth provider redirects back to with a one-time `code`
 * (#3433): `/callback`, `/auth/callback`, `/auth/google/callback`,
 * `/api/auth/callback/github` (NextAuth), `/oauth2callback`,
 * `/login/oauth2/code/google` (Spring). Read on the path right before the query.
 */
const OAUTH_CALLBACK_PATH =
  /(?:\/(?:oauth2?_?)?callback(?:\/[a-z0-9_-]{1,32})?|\/oauth2\/code\/[a-z0-9_-]{1,32})\/?$/i;
/** How far back a callback query's `?` is looked for: further, it is not one. */
const CALLBACK_LOOKBACK = 512;

/**
 * Whether the parameter whose separator ends at `at` is in a query that follows an OAuth callback
 * path (`/auth/callback?state=x&code=<c>`), its own or a nested one
 * (`?next=%2Fauth%2Fcallback%3Fcode%3D…`): the query is the one whose `?`
 * (raw or encoded) came last before it. Reads back a bounded distance, so a
 * run of `&code=` stays linear.
 */
function inOAuthCallbackQuery(text: string, at: number): boolean {
  let from = Math.max(0, at - CALLBACK_LOOKBACK);
  for (let i = at; i > from; i--) {
    if (URL_BOUNDARY.has(text[i - 1]!)) {
      from = i;
      break;
    }
  }
  const window = text.slice(from, at);
  let query = -1;
  for (const mark of [/\?/g, /%3F/gi, /%253F/gi]) {
    for (const m of window.matchAll(mark)) query = Math.max(query, m.index);
  }
  if (query === -1) return false;
  let path = window
    .slice(Math.max(0, query - 80), query)
    .replace(/%(?:25)?2F/gi, "/");
  const nested = path.lastIndexOf("=");
  if (nested !== -1) path = path.slice(nested + 1);
  return OAUTH_CALLBACK_PATH.test(path);
}

/**
 * Every parameter `start` finds whose value is a secret has it replaced (see
 * the module comment for what counts). A parameter that is not one keeps its
 * value AND has it searched, so a secret nested in it (`?next=/reset?token=…`)
 * is still found. Only a candidate's value is read to its end, and the search
 * resumes past a replaced one, so each character is read a bounded number of
 * times.
 */
function redactParams(
  text: string,
  site: SiteHosts,
  start: RegExp,
  valueEnd: (matrix: boolean) => RegExp
): string {
  const wpResetQueryEnd = wpResetQueries(text);
  const cursor = urlCursor(
    text,
    site,
    (query) => wpResetQueryEnd(query) !== -1
  );
  const valueEndFrom = valueEnds(text);
  let out = "";
  let copied = 0;
  start.lastIndex = 0;
  for (let match = start.exec(text); match !== null; match = start.exec(text)) {
    // Past the separator itself: an `&` can end a nested value (`urlCursor`).
    cursor.seek(match.index + 1);
    const words = paramWords(match[2]!);
    const password = PASSWORD_KEYS.has(words.replace(/_/g, ""));
    const credential = password || isCredentialName(words);
    // An OAuth authorization code on the site's callback URL, whatever its
    // shape: one-time, and as short as a page number (#3433).
    const oauthCode =
      words === "code" &&
      inOAuthCallbackQuery(text, match.index + match[1]!.length);
    const session = !credential && (oauthCode || isSessionName(match[2]!));
    // A reset link's own `key`: the first parameter after its `?`, or a later
    // one after an `&` (or `&amp;`), before its `#`, the link the run's last one so far
    // (nested too: `?next=/wp-login.php?action=rp&key=…`). Not an outer URL's
    // (`/products?key=blue&next=/wp-login.php?…`), a nested URL's
    // (`?next=/products?key=blue`), or one in a fragment.
    const wpQuery = cursor.wpResetQuery();
    const wpKey =
      words === "key" &&
      wpQuery !== -1 &&
      (match.index === wpQuery ||
        match[1] === "&" ||
        (match[1] === ";" &&
          text.slice(match.index - 4, match.index).toLowerCase() === "&amp")) &&
      match.index < wpResetQueryEnd(wpQuery);
    if (!credential && !session && !wpKey) continue;
    if ((session || wpKey) && !cursor.onSite()) continue;
    // A raw `;` is a matrix parameter in a path and a separator in a query. An
    // encoded one is read as a matrix parameter: inside an encoded value there
    // is no telling a nested path from a nested query, and a `;` query is rare.
    const separator = match[1]!.toLowerCase();
    const matrix =
      separator === ";"
        ? !cursor.inQuery()
        : separator === "%3b" || separator === "%253b";
    const from = match.index + match[0].length;
    const to = valueEndFrom(valueEnd(matrix), from);
    if (from === to) continue;
    // Past a nested query (`?`, `%3F`, `%253F`) the value is a URL, never a
    // token: it is judged by what comes before, so a chain of nested
    // parameters is read once, not once per parameter.
    let nested = from;
    while (nested < to && !isNestedQueryAt(text, nested)) nested++;
    const prefix = text.slice(from, nested);
    if (nested === to && (prefix === REDACTED_VALUE || /^\*+$/.test(prefix)))
      continue;
    // A token, or a token a query value runs on from (`?a=1;token=<hex>/more`),
    // or one glued on after a `;`, `'` or `\` (`token=x;<hex>`).
    const head = prefix.split("/", 1)[0]!;
    if (!password && !wpKey && !oauthCode && !isNeverContentName(words)) {
      // An ambiguous name: only a token-shaped value is a secret, and for some
      // of them a UUID is a record's id (`?session=<uuid>`).
      const uuidIsId = UUID_ID_KEYS.has(words.replace(/_/g, ""));
      const zeroXIds = HASH_IS_SECRET_NAME.test(words) ? "address" : "both";
      const shaped = (part: string) =>
        (looksLikeAToken(part, zeroXIds) &&
          !(uuidIsId && UUID.test(tokenCore(part)))) ||
        looksLikeAShortToken(part);
      if (!shaped(prefix) && !head.split(/[;'\\]/).some(shaped)) continue;
    }
    cursor.seek(from);
    cursor.skip(to);
    out += `${text.slice(copied, from)}${replacementFor(to - from)}`;
    copied = to;
    start.lastIndex = to;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** Every JSON Web Token in `text`, by its header ({@link isJwtHeader}), replaced. */
function redactJwts(text: string): string {
  let out = "";
  let copied = 0;
  JWT_CANDIDATE.lastIndex = 0;
  for (
    let match = JWT_CANDIDATE.exec(text);
    match !== null;
    match = JWT_CANDIDATE.exec(text)
  ) {
    const header = match[0].slice(0, match[0].search(JWT_SEPARATOR));
    if (!isJwtHeader(header)) {
      // The token can start later in this run (`subdomain.eyJ…`, `3DeyJ…`).
      JWT_CANDIDATE.lastIndex = match.index + 1;
      continue;
    }
    out += `${text.slice(copied, match.index)}${REDACTED_VALUE}`;
    copied = match.index + match[0].length;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** Every cookieless ASP.NET segment in the site's own URLs, replaced. */
function redactAspNetSegments(text: string, site: SiteHosts): string {
  if (!/\([SAF]\(/.test(text)) return text;
  const cursor = urlCursor(text, site);
  return text.replace(ASPNET_COOKIELESS, (segment: string, at: number) => {
    cursor.seek(at);
    return cursor.onSite()
      ? segment.replace(ASPNET_PART, `$1(${REDACTED_VALUE})`)
      : segment;
  });
}

/**
 * Words in a path that, as a segment of their own or beside any word, say a
 * token after them is a credential (`/reset/<hex>`, `/invite/<uuid>`).
 */
const CREDENTIAL_CONTEXT_WORDS = new Set([
  "login",
  "signin",
  "magic",
  "password",
  "invite",
  "reset",
  "confirm",
  "activate",
  "unsubscribe",
  "unsub",
]);

/**
 * Noun forms that say so as a segment of their own (`/confirmation/<hex>`) or
 * beside one of {@link NOUN_PAIR_WORDS} (`/order-confirmation/<uuid>`), never
 * beside any other word: `/blog/confirmation-bias/<hex>` and
 * `/products/activation-lock/<hex>` are pages.
 */
const NOUN_CONTEXT_WORDS = new Set([
  "confirmation",
  "activation",
  "invitation",
]);
const NOUN_PAIR_WORDS = new Set([
  "email",
  "account",
  "password",
  "order",
  // A weak word or a context partner (`/confirmation-token/<t>`, `/activation-link/<t>`).
  "token",
  "auth",
  "session",
  "verify",
  "verification",
  "recover",
  "recovery",
  "link",
  "code",
  "key",
  "login",
  // Who or what the invite, confirmation or activation is for (`/accept-invitation/<t>`).
  "accept",
  "user",
  "team",
  "member",
  "subscription",
  "newsletter",
  "registration",
  "signup",
  "license",
]);

/**
 * Words that say so only beside another such word, in their segment
 * (`/verify-email/<t>`, `/auth-token/<t>`) or as the one before it
 * (`/email/verify/<t>`, `/login/token/<t>`, `/account/recover/<t>`): on their
 * own they name pages too (#3339 review N1), `/token/0x6b17…` a coin,
 * `/session/<uuid>` a talk, `/verify/<uuid>` and `/verification/<uuid>` a
 * certificate.
 */
const WEAK_CONTEXT_WORDS = new Set([
  "token",
  "auth",
  "session",
  "verify",
  "verification",
  "recover",
  "recovery",
]);
/** What a weak word pairs with to mean a credential, in its own segment. */
const CONTEXT_PAIR_WORDS = new Set([
  "email",
  "link",
  "account",
  "code",
  "key",
  "login",
]);
/**
 * The same as the segment before a weak word, less the nouns that name a
 * page there (`/key/token/<hex>`, `/code/token/<hex>`).
 */
const PREVIOUS_PAIR_WORDS = new Set(["email", "link", "account", "login"]);
/**
 * A segment that can sit between a credential word and its token, saying what
 * the token is for (`/invite/accept/<t>`, `/activate/account/<t>`), or, after
 * a weak word, who it is for (`/verify/email/<t>`, the order
 * `/email/verify/<t>` reads too).
 */
const BETWEEN_WORDS = new Set(["accept", "email", "account"]);

/**
 * A segment naming a chain object: an `0x` value after it is the object's id,
 * whatever word comes between (`/tx/confirm/0x<64>`, `/token/magic/0x<40>`).
 */
const CHAIN_OBJECT_WORDS = new Set([
  "tx",
  "txn",
  "transaction",
  "token",
  "address",
  "block",
  "contract",
]);

/**
 * What a short segment's words say about the segment after it: a credential
 * word's context, a context only weak words make, or none.
 */
function segmentContext(words: string[]): "credential" | "weak" | null {
  if (words.length === 1) {
    const word = words[0]!;
    return CREDENTIAL_CONTEXT_WORDS.has(word) || NOUN_CONTEXT_WORDS.has(word)
      ? "credential"
      : null;
  }
  if (words.length !== 2) return null;
  if (words.some((w) => CREDENTIAL_CONTEXT_WORDS.has(w))) return "credential";
  if (
    words.some((w) => NOUN_CONTEXT_WORDS.has(w)) &&
    words.some((w) => NOUN_PAIR_WORDS.has(w))
  ) {
    return "credential";
  }
  return words.some((w) => WEAK_CONTEXT_WORDS.has(w)) &&
    words.every((w) => WEAK_CONTEXT_WORDS.has(w) || CONTEXT_PAIR_WORDS.has(w))
    ? "weak"
    : null;
}

/**
 * The context a segment gives the one after it, with the segment before it:
 * its own words' ({@link segmentContext}), or a lone weak word's paired with
 * the segment before, when that one says a token follows
 * (`/reset-password/token/<t>`), is a credential word or a partner, or is
 * another weak word (`/login/token/<t>`, `/account/verify/<t>`,
 * `/auth/token/<t>`).
 */
function contextAfter(
  previous: string[],
  words: string[]
): "credential" | "weak" | null {
  const own = segmentContext(words);
  if (own) return own;
  if (words.length === 1 && BETWEEN_WORDS.has(words[0]!)) {
    // A word between the credential word and its token (#3433):
    // `/invite/accept/<t>`, `/confirm/email/<t>`, `/verify/email/<t>`.
    const before = segmentContext(previous);
    if (before === "credential") return before;
    return previous.length === 1 &&
      WEAK_CONTEXT_WORDS.has(previous[0]!) &&
      PREVIOUS_PAIR_WORDS.has(words[0]!)
      ? "weak"
      : null;
  }
  if (words.length !== 1 || !WEAK_CONTEXT_WORDS.has(words[0]!)) return null;
  const before = segmentContext(previous);
  if (before) return before;
  if (previous.length !== 1) return null;
  return PREVIOUS_PAIR_WORDS.has(previous[0]!) ||
    WEAK_CONTEXT_WORDS.has(previous[0]!)
    ? "weak"
    : null;
}

/**
 * Which `0x` values stay ids after a context: every one after a chain object
 * (`previous`), an address after weak words alone or a `token` segment
 * (`/account/token/0x<40>`, `/magic/token/0x<40>`), none after a credential
 * word (`/reset/0x<64>`, `/magic/0x<40>`).
 */
function contextZeroXIds(
  context: "credential" | "weak",
  previous: string[],
  words: string[]
): ZeroXIds {
  if (previous.some((w) => CHAIN_OBJECT_WORDS.has(w))) return "both";
  return context === "weak" || words.includes("token") ? "address" : "none";
}

/**
 * A URL path in text: after a host (with a scheme, or protocol-relative), or a
 * relative one at the start of a run or a value.
 */
const URL_PATH =
  /(?:(?:\bhttps?:)?\/\/[^\s/?#"'<>\\]+|(?<=^|[\s"'<>=(]|#!?))(\/[^\s?#&"'<>\\]*)/g;
/** Where a path that is not a parameter's value ends: it can hold an `&`. */
const PATH_END = /[\s?#"'<>\\]/g;

/** A path segment's words: camelCase split, lowercase, split on anything not a letter or digit. */
function segmentWords(segment: string): string[] {
  const words = segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
  // (#3433) A credential word split in two (`/sign-in/<t>`, `/sign_in`,
  // `/log-in`) is one, and a Rails resource's plural is its word
  // (`/account_activations/<t>/edit`, `/invitations/<t>`).
  const out: string[] = [];
  for (const word of words) {
    const last = out.length - 1;
    if (word === "in" && (out[last] === "sign" || out[last] === "log"))
      out[last] += "in";
    else out.push(PLURAL_CONTEXT_WORDS.get(word) ?? word);
  }
  return out;
}

/** Rails resource plurals of context words, as their word (#3433). */
const PLURAL_CONTEXT_WORDS = new Map([
  ["activations", "activation"],
  ["confirmations", "confirmation"],
  ["invitations", "invitation"],
  ["invites", "invite"],
  ["verifications", "verification"],
]);

/**
 * A Django password-reset token, `<timestamp base36>-<hmac hex>`
 * (`PasswordResetTokenGenerator`, 20 hex for SHA-1, 32 for SHA-256), and a
 * django-allauth email confirmation key, a signed `<value>:<timestamp>:<sig>`
 * (`TimestampSigner`). Neither is one run of letters and digits, so
 * {@link looksLikeAToken} does not see them; after a credential word they are
 * a credential (#3433).
 */
const DJANGO_RESET_TOKEN = /^[0-9a-z]{1,13}-[0-9a-f]{20,64}$/;
const DJANGO_SIGNED_KEY =
  /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9]{4,10}:[A-Za-z0-9_-]{20,}$/;
/** A Django `uidb64` segment before its reset token: a user's id, base64url, not the secret. */
const DJANGO_UIDB64 = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Where a run of trailing `)`, `.` and `,` starts in `text` (its length when
 * none). A backwards scan, not `/[).,]+$/`, whose backtracking is quadratic
 * on a segment of many `)` that does not end in one.
 */
function trailingPunctuationStart(text: string): number {
  let end = text.length;
  while (end > 0) {
    const char = text[end - 1];
    if (char !== ")" && char !== "." && char !== ",") break;
    end--;
  }
  return end;
}

/**
 * How much of a path segment is a token after a context: the whole of it, or
 * the part before a markdown link's closing `)` or a file extension
 * (`/reset/<hex>)`, `/reset/<hex>.html`, #3433); 0 when none is.
 */
function pathTokenLength(
  head: string,
  zeroXIds: ZeroXIds,
  context: "credential" | "weak"
): number {
  const isToken = (part: string) =>
    looksLikeAToken(part, zeroXIds) ||
    (context === "credential" &&
      (DJANGO_RESET_TOKEN.test(part) || DJANGO_SIGNED_KEY.test(part)));
  if (isToken(head)) return head.length;
  const bare = head.slice(0, trailingPunctuationStart(head));
  if (bare !== head && isToken(bare)) return bare.length;
  const stem = bare.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return stem !== bare && isToken(stem) ? stem.length : 0;
}

/**
 * Every token segment in `segments` after a short segment that says it is one
 * ({@link contextAfter}), replaced in place; whether any was. `cut` ends a
 * segment's token part (a matrix parameter, a value's `&`).
 */
function redactSegments(segments: string[], cut: RegExp): boolean {
  let changed = false;
  let previous: string[] = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const words = segmentWords(segments[i]!.split(cut)[0]!);
    const context = contextAfter(previous, words);
    const before = previous;
    previous = words;
    if (!context) continue;
    const next = segments[i + 1]!;
    const head = next.split(cut)[0]!;
    const zeroXIds = contextZeroXIds(context, before, words);
    const length = pathTokenLength(head, zeroXIds, context);
    if (length > 0) {
      segments[i + 1] = `${REDACTED_VALUE}${next.slice(length)}`;
      changed = true;
      continue;
    }
    // Django's `/reset/<uidb64>/<token>/`: the token is two segments on.
    const after = segments[i + 2];
    if (
      context === "credential" &&
      after !== undefined &&
      DJANGO_UIDB64.test(head)
    ) {
      const token = after.split(cut)[0]!;
      if (DJANGO_RESET_TOKEN.test(token)) {
        segments[i + 2] = `${REDACTED_VALUE}${after.slice(token.length)}`;
        changed = true;
      }
    }
  }
  return changed;
}

/** What ends a parameter name, reading back from its `=`. */
const PARAM_NAME_END = new Set([
  "=",
  "&",
  "?",
  ";",
  "#",
  ...URL_BOUNDARY,
  "\\",
]);
/** An encoded separator right before a name: `%3Fnext=`, `%253Fnext=`. */
const ENCODED_NAME_START = /%(?:25)?(?:3F|26|3B|23)[^%]*$/i;

/**
 * Whether the `=` at `at` ends a query, fragment or matrix parameter's name
 * (`?next=`, `&next=`, `;next=`, `%3Fnext=`), as opposed to an attribute's in
 * unquoted HTML (`<a href=/news&events/…>`), whose value is a whole URL that
 * may hold `&`. Reads back at most a name's length.
 */
function endsParamName(text: string, at: number): boolean {
  const stop = Math.max(0, at - 129);
  let i = at - 1;
  while (i >= stop && !PARAM_NAME_END.has(text[i]!)) i--;
  if (i >= 0 && i >= stop && "?&#".includes(text[i]!)) return true;
  if (i >= 0 && i >= stop && text[i] === ";") return semicolonInUrl(text, i);
  return ENCODED_NAME_START.test(text.slice(i + 1, at));
}

/**
 * Whether the `;` at `at` separates a matrix or `;`-query parameter, which only
 * a URL has: a `/`, `?` or `#` since the last boundary (`/shop;next=`,
 * `?a=1;next=`, `&amp;next=`). A meta refresh's `0;url=` has none, so its `url=`
 * names an attribute-like value, as `href=` does, and the URL after it may hold
 * `&` (`content="0;url=/news&events/reset/<t>"`). Reads back a bounded distance,
 * so a run of `;url=` cannot make the pass quadratic.
 */
function semicolonInUrl(text: string, at: number): boolean {
  const stop = Math.max(0, at - 256);
  for (let i = at - 1; i >= stop; i--) {
    const ch = text[i]!;
    if (ch === "/" || ch === "?" || ch === "#") return true;
    if (URL_BOUNDARY.has(ch)) return false;
  }
  return false;
}

/**
 * The token segment right after a short segment that says it is one, in the
 * site's own path (`/reset/<hex>`, `/verify-email/<token>`, `/magic-link/<b64>`,
 * `/login/token/<t>`), replaced. A short segment is one or two words, so a slug
 * that mentions a word (`/how-to-reset-your-password/<id>`) is a page, and so
 * is a bare id after no such word (`/posts/<uuid>`). After a credential word
 * every token shape is a credential, an `0x` value and a UUID too
 * (`/reset/0x…`, `/invite/<uuid>`); after weak words alone an `0x` address
 * stays an id (`/account/token/0x<40>`), and after a chain object every `0x`
 * value does (`/tx/confirm/0x<64>`).
 *
 * A relative path that is a parameter's value is decided by the URL it sits in
 * (`urlCursor`), as the parameter pass decides it: one nested in an off-site
 * link's query (`https://other.example/x?next=/login/token/<t>`) is that
 * site's, and kept, since the link checker keys its verdict on that link's raw
 * `next`. Any other relative path is the site's own.
 */
function redactPathTokens(text: string, site: SiteHosts): string {
  if (!text.includes("/")) return text;
  let out = "";
  let copied = 0;
  let cursor: ReturnType<typeof urlCursor> | null = null;
  URL_PATH.lastIndex = 0;
  for (
    let match = URL_PATH.exec(text);
    match !== null;
    match = URL_PATH.exec(text)
  ) {
    let path = match[1]!;
    const host = match[0].slice(0, match[0].length - path.length);
    const pathAt = match.index + match[0].length - path.length;
    // A path stops at `&`: a parameter's value (relative or absolute) ends
    // there (`?next=/reset/<t>&lang=en`), and what follows is read from there.
    // Any other path runs on to its end, read once. A replaced value never
    // holds an `&`, so a second pass cuts the same.
    const paramValue =
      text[match.index - 1] === "=" && endsParamName(text, match.index - 1);
    if (!paramValue && text[pathAt + path.length] === "&") {
      PATH_END.lastIndex = pathAt + path.length;
      const end = PATH_END.exec(text)?.index ?? text.length;
      path = text.slice(pathAt, end);
      URL_PATH.lastIndex = end;
    }
    if (path.length < 18) continue;
    // A hash route (`/#/reset/<t>`, `#!/reset/<t>`, #3433) is its URL's.
    const hashRoute =
      !host &&
      text[pathAt - 1] !== undefined &&
      "#!".includes(text[pathAt - 1]!);
    if (host && site !== null) {
      const authority = host.slice(host.indexOf("//") + 2);
      if (
        !site.has(
          canonicalHostKey(authority.slice(authority.lastIndexOf("@") + 1))
        )
      )
        continue;
    } else if (!host && site !== null && (paramValue || hashRoute)) {
      // A parameter's value or a hash route: the URL it is in decides. A
      // relative path anywhere else (a run's start, after `(`) is the site's own.
      cursor ??= urlCursor(text, site);
      cursor.seek(pathAt);
      if (!cursor.onSite()) continue;
    }
    const segments = path.split("/");
    // A path that runs on past `&` (not a parameter's value) ends its token
    // there too: `<a href=/reset/<t>&lang=en>`.
    if (!redactSegments(segments, /[;&]/)) continue;
    out += `${text.slice(copied, pathAt)}${segments.join("/")}`;
    copied = pathAt + path.length;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * A relative or absolute path percent-encoded once or twice as a parameter's
 * value (`?next=%2Freset%2F<t>`, `?next=https%3A%2F%2Fexample.com%2Freset%2F<t>`,
 * #3433), or as an encoded URL's hash route (`%23%2Freset%2F<t>`); not a
 * protocol-relative `%2F%2F`, whose host is not read here. Group 1 is the `=`
 * of a value.
 */
function encodedPathPattern(pct: "%" | "%25") {
  return {
    path: new RegExp(
      `(?:(=)(?:https?${pct}3A${pct}2F${pct}2F(?:(?!${pct}2F|${pct}3F|${pct}23)[^\\s&#/?"'<>\\\\])+)?|${pct}23(?:${pct}21|!)?)(${pct}2F)(?!${pct}2F)`,
      "gi"
    ),
    /**
     * Where the path ends: its encoded query or fragment, or what ends the
     * value. Searched forward from the path's first `/` rather than scanned
     * greedily and cut back, which made a run of `%23%2F` quadratic (#3433).
     */
    end: new RegExp(`${pct}3F|${pct}23|[\\s&#"'<>\\\\]`, "gi"),
    separator: new RegExp(`${pct}2F`, "gi"),
    /** What ends a segment's token: a matrix parameter, an encoded `&`. */
    cut: new RegExp(`${pct}3B|${pct}26|[;&]`, "i"),
  };
}
const ENCODED_PATHS = [encodedPathPattern("%"), encodedPathPattern("%25")];

/**
 * {@link redactPathTokens} for a path percent-encoded in a parameter's value:
 * the segments are split at the encoded `/`, judged as the plain pass judges
 * them, and the URL the value is in decides whether it is the site's.
 */
function redactEncodedPathTokens(text: string, site: SiteHosts): string {
  for (const pattern of ENCODED_PATHS) {
    let out = "";
    let copied = 0;
    let cursor: ReturnType<typeof urlCursor> | null = null;
    pattern.path.lastIndex = 0;
    for (
      let match = pattern.path.exec(text);
      match !== null;
      match = pattern.path.exec(text)
    ) {
      if (match[1] !== undefined && !endsParamName(text, match.index)) continue;
      const pathAt = match.index + match[0].length - match[2]!.length;
      pattern.end.lastIndex = pathAt + match[2]!.length;
      const end = pattern.end.exec(text);
      const path = text.slice(pathAt, end === null ? text.length : end.index);
      // What follows the path (its query, a hash route) is read from there.
      pattern.path.lastIndex = pathAt + path.length;
      if (path.length < 18) continue;
      if (site !== null) {
        cursor ??= urlCursor(text, site);
        cursor.seek(pathAt);
        if (!cursor.onSite()) continue;
      }
      const separators = path.match(pattern.separator) ?? [];
      const segments = path.split(pattern.separator);
      if (!redactSegments(segments, pattern.cut)) continue;
      let rebuilt = segments[0]!;
      for (let i = 1; i < segments.length; i++)
        rebuilt += separators[i - 1]! + segments[i]!;
      out += `${text.slice(copied, pathAt)}${rebuilt}`;
      copied = pathAt + path.length;
    }
    if (copied !== 0) text = out + text.slice(copied);
  }
  return text;
}

/**
 * How many times the passes run before their result is taken as it is. One
 * pass's replacement can change what another reads (a removed `'` joins two
 * runs, a replaced value no longer nests a URL), so they run again until
 * nothing changes; past a few rounds an input is built to nest, not a URL.
 */
const MAX_ROUNDS = 4;

/**
 * `text` with every secret a URL in it can carry replaced (see the module
 * comment); `site` decides which URLs are the site's own. Idempotent (the
 * passes run to a fixed point), never longer than `text`, and the same string
 * when there is nothing to redact.
 */
export function redactSecretText(text: string, site: SiteHosts = null): string {
  let out = text;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = redactOnce(out, site);
    if (next === out) return out;
    out = next;
  }
  return out;
}

/** One round of every pass. */
function redactOnce(text: string, site: SiteHosts): string {
  if (!MIGHT_CARRY_SECRET.test(text)) return text;
  let out = text;
  if (out.includes("@")) out = out.replace(USERINFO, "$1");
  if (/%2F%2F/i.test(out)) out = out.replace(ENCODED_USERINFO, "$1");
  if (/%2540/i.test(out)) out = out.replace(TWICE_ENCODED_USERINFO, "$1");
  if (out.includes("=")) {
    out = redactParams(out, site, PARAM_START, (matrix) =>
      matrix ? MATRIX_VALUE_END : QUERY_VALUE_END
    );
  }
  if (/%3[Ff]|%26|%3[Bb]|%23/.test(out)) {
    out = redactParams(out, site, ENCODED_ONCE.start, (matrix) =>
      matrix ? ENCODED_ONCE.matrixEnd : ENCODED_ONCE.end
    );
  }
  if (/%25(?:3[Ff]|26|3[Bb]|23)/.test(out)) {
    out = redactParams(out, site, ENCODED_TWICE.start, (matrix) =>
      matrix ? ENCODED_TWICE.matrixEnd : ENCODED_TWICE.end
    );
  }
  if (JWT_HEADER_START.test(out)) out = redactJwts(out);
  out = redactPathTokens(out, site);
  if (/%(?:25)?2F/i.test(out)) out = redactEncodedPathTokens(out, site);
  return redactAspNetSegments(out, site);
}

/** A token-shaped stand-in for a redacted value, to ask the redactor what it would do there. */
const PROBE_TOKEN = "0123456789abcdef0123";
/**
 * A JWT-shaped one, for a marker the JWT pass could have left: a whole path
 * segment or value (`/share/REDACTED`, `?t=REDACTED`). A page's own word there
 * reads the same and is treated the same: not a URL to fetch.
 */
const PROBE_JWT = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
/**
 * A Django reset token's shape, for a marker two segments after its word
 * (`/reset/<uidb64>/REDACTED/`), which only that shape is redacted at (#3433).
 */
const PROBE_DJANGO = "c4r1ze-0123456789abcdef0123";
const WHOLE_MARKER_BEFORE = new Set(["/", "="]);
const WHOLE_MARKER_AFTER = new Set([undefined, "/", "?", "&", "#", ";"]);
/** A short password's `*` replacement (`replacementFor`). */
const STAR_VALUE = /(=|%3D)(\*+)(?=$|[&#;%])/gi;

/**
 * Whether a URL carries a value this redaction replaced, so it is not a URL
 * to fetch (`?sid=REDACTED`, `/reset/REDACTED`, `?password=****`). Asked of the
 * redactor itself, one marker at a time: a stand-in put back in its place is
 * redacted again, where a page's own `REDACTED` (`?topic=REDACTED`) is not.
 */
export function carriesRedactedValue(url: string): boolean {
  for (
    let at = url.indexOf(REDACTED_VALUE);
    at !== -1;
    at = url.indexOf(REDACTED_VALUE, at + 1)
  ) {
    const end = at + REDACTED_VALUE.length;
    const whole =
      WHOLE_MARKER_BEFORE.has(url[at - 1]!) && WHOLE_MARKER_AFTER.has(url[end]);
    for (const token of whole
      ? [PROBE_TOKEN, PROBE_JWT, PROBE_DJANGO]
      : [PROBE_TOKEN]) {
      const probe = `${url.slice(0, at)}${token}${url.slice(end)}`;
      if (redactSecretText(probe) !== probe) return true;
    }
  }
  for (const match of url.matchAll(STAR_VALUE)) {
    const at = match.index + match[1]!.length;
    const stars = match[2]!.length;
    const probe = `${url.slice(0, at)}${"x".repeat(stars)}${url.slice(at + stars)}`;
    if (redactSecretText(probe) !== probe) return true;
  }
  return false;
}

// ── Reports and finding lines ────────────────────────────────────────────────

/**
 * Transport-only fields the walk leaves alone: the resolution signal's page
 * hashes are of the producer's raw URLs, so it is translated after it is
 * decoded, never rewritten blind.
 */
const SIGNAL_FIELDS = new Set(["resolutionSignal", "resolutionSignalCompact"]);
/** A report's robots.txt body and rules: the site's own text and patterns, never page URLs. */
const ROBOTS_TEXT_FIELDS = new Set(["content", "rules"]);

/** Deeper than any report nests; past it a value is left as it is. */
const MAX_DEPTH = 64;

/** Called when a walk changes anything: a string, or a key. */
type OnChange = (() => void) | undefined;

function redactInPlace(
  value: unknown,
  depth: number,
  site: SiteHosts,
  onChange?: OnChange
): unknown {
  if (typeof value === "string") {
    const out = redactSecretText(value, site);
    if (out !== value) onChange?.();
    return out;
  }
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH)
    return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = redactInPlace(value[i], depth + 1, site, onChange);
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  /** Where each key was before the walk: a renamed key that lands on a later one gives way to it. */
  const order = new Map(keys.map((k, i) => [k, i]));
  for (const [index, key] of keys.entries()) {
    if (depth === 0 && SIGNAL_FIELDS.has(key)) continue;
    if (depth === 0 && key === "robotsTxt") {
      const robots = asRecord(record[key]);
      for (const field of Object.keys(robots ?? {})) {
        if (!ROBOTS_TEXT_FIELDS.has(field)) {
          robots![field] = redactInPlace(robots![field], 2, site, onChange);
        }
      }
      continue;
    }
    const next = redactInPlace(record[key], depth + 1, site, onChange);
    // A key can quote a URL too (a free-form `details` record keyed by page).
    const redactedKey = redactSecretText(key, site);
    if (redactedKey !== key) {
      onChange?.();
      delete record[key];
      // Two keys that redact alike are one: the later one's value stays, as in
      // a JSON object with a repeated key (and in `redactingReplacer`).
      if ((order.get(redactedKey) ?? -1) <= index) record[redactedKey] = next;
    } else if (next !== record[key]) {
      record[key] = next;
    }
  }
  return record;
}

/**
 * A `JSON.stringify` replacer that writes a report redacted for `site` as the
 * publish schema's walk would, without changing or copying the report: the
 * container serializes its shell this way before init (#3339 review), with the
 * hosts of every streamed finding too, so the shell's text is redacted with
 * the same host set as the lines. A record whose keys quote a URL is the one
 * thing it rebuilds, and only that record, shallowly.
 */
export function redactingReplacer(
  report: unknown,
  site: SiteHosts
): (this: unknown, key: string, value: unknown) => unknown {
  const root = asRecord(report);
  /** Subtrees written as they are: the resolution signal, robots.txt's text. */
  const kept = new WeakSet<object>();
  return function (this: unknown, key: string, value: unknown): unknown {
    const holder = this as object | null;
    const keep =
      (holder !== null && kept.has(holder)) ||
      (holder === root && SIGNAL_FIELDS.has(key)) ||
      (root !== undefined &&
        holder === root.robotsTxt &&
        ROBOTS_TEXT_FIELDS.has(key));
    if (keep) {
      if (value === null || typeof value !== "object") return value;
      // Inside a kept subtree: its own nodes. At its root: a copy, so an
      // object the report shares between the signal and a page list is
      // still redacted where the page list writes it.
      const own =
        holder !== null && kept.has(holder) ? value : structuredClone(value);
      kept.add(own);
      return own;
    }
    if (typeof value === "string") return redactSecretText(value, site);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const redactedKeys = keys.map((k) => redactSecretText(k, site));
    if (redactedKeys.every((rk, i) => rk === keys[i])) return value;
    // The walk's own moves on a shallow copy (`redactInPlace`), so the keys
    // come out in its order too: a renamed key goes last, the later of two
    // that redact alike wins.
    const order = new Map(keys.map((k, i) => [k, i]));
    const renamed: Record<string, unknown> = { ...record };
    for (const [index, k] of keys.entries()) {
      const rk = redactedKeys[index]!;
      if (rk === k) continue;
      delete renamed[k];
      if ((order.get(rk) ?? -1) <= index) renamed[rk] = record[k];
    }
    return renamed;
  };
}

/**
 * Redact every string (and record key) in a published report payload, in place,
 * before it is validated (#3014): page URLs, check page lists, item ids, labels
 * and source pages, messages, details. The site is every host the crawl
 * reached ({@link reportSiteHosts}). The resolution signal is translated
 * separately, and robots.txt's body and rules are kept as the site wrote them.
 * Returns the same value for the schema's preprocess chain.
 */
export function redactReportSecrets(report: unknown): unknown {
  return redactInPlace(report, 0, reportSiteHosts(report));
}

/** Redact one value that is not a whole report, for `site`, in place. */
export function redactSecretsDeep<T>(value: T, site: SiteHosts): T {
  return redactInPlace(value, 1, site) as T;
}

/** The fields of a page_findings line this reads and writes. */
export interface RedactableFindingLine {
  normalizedUrl?: unknown;
  ruleId?: unknown;
  checkName?: unknown;
  locator?: unknown;
  status?: unknown;
  message?: unknown;
  value?: unknown;
  expected?: unknown;
  payload?: unknown;
  fingerprint?: unknown;
}

/** The finding fingerprint (audit-engine's `findingFingerprint`), passed in. */
export type FindingFingerprint = (
  status: string,
  message: string,
  value: string | null,
  expected: string | null
) => string;

/**
 * A finding line with every secret its URLs can carry redacted, in place, as
 * the publish schema redacts a whole report: the page URL and locator (join
 * keys, so every copy of a page becomes the same key), the display text and
 * the payload (JSON text: walked as the values it holds, so an escape cannot
 * hide a name). The producer computed the fingerprint over the text it sent,
 * so a line whose text changed gets it again from `fingerprint`.
 */
export function redactFindingLine<L extends RedactableFindingLine>(
  line: L,
  site: SiteHosts,
  fingerprint: FindingFingerprint,
  onChange?: OnChange
): L {
  const text = [line.message, line.value, line.expected];
  if (typeof line.payload === "string") {
    try {
      let changed = false;
      const redacted = redactInPlace(
        JSON.parse(line.payload) as unknown,
        1,
        site,
        () => {
          changed = true;
        }
      );
      // Re-serialized only when something in it changed: a payload is the
      // bulk of a line, and most have nothing to redact.
      if (changed) {
        onChange?.();
        line.payload = JSON.stringify(redacted) as L["payload"];
      }
    } catch {
      // Not JSON: left for the receiver's own checks.
    }
  }
  redactInPlace(line, 1, site, onChange);
  const changed = [line.message, line.value, line.expected].some(
    (v, i) => v !== text[i]
  );
  if (
    changed &&
    typeof line.status === "string" &&
    typeof line.message === "string" &&
    (line.value === undefined ||
      line.value === null ||
      typeof line.value === "string") &&
    (line.expected === undefined ||
      line.expected === null ||
      typeof line.expected === "string")
  ) {
    line.fingerprint = fingerprint(
      line.status,
      line.message,
      (line.value as string | null | undefined) ?? null,
      (line.expected as string | null | undefined) ?? null
    ) as L["fingerprint"];
  }
  return line;
}

/**
 * {@link redactFindingLine} without touching `line`: the same line back when
 * there was nothing to redact, else a redacted shallow copy. The container
 * redacts every streamed line this way, so a report's worth of lines is not
 * copied for the few that carry a secret.
 */
export function redactedFindingLine<L extends RedactableFindingLine>(
  line: L,
  site: SiteHosts,
  fingerprint: FindingFingerprint
): L {
  let changed = false;
  const copy = redactFindingLine({ ...line }, site, fingerprint, () => {
    changed = true;
  });
  return changed ? copy : line;
}

/**
 * A finding line's page_findings key: (page, rule, check, locator), the locator
 * clamped as the ingest schema clamps it (`clampItemId`, a hash suffix past the
 * cap), so two locators the store keys as one are one here too.
 */
export function findingLineKey(line: RedactableFindingLine): string {
  const locator =
    typeof line.locator === "string"
      ? clampItemId(line.locator, REPORT_LIMITS.maxMediumString)
      : "";
  return JSON.stringify([
    line.normalizedUrl,
    line.ruleId,
    line.checkName,
    locator,
  ]);
}

/**
 * One line per page_findings key, the LAST of each, in first-seen order: what
 * an upsert of them all leaves in the store. Redaction can fold two lines into
 * one key (`?sid=<a>` and `?sid=<b>` are one page), so a producer counts the
 * lines after this, not before.
 */
export function dedupeFindingLines<L extends RedactableFindingLine>(
  lines: readonly L[]
): L[] {
  const byKey = new Map<string, L>();
  for (const line of lines) byKey.set(findingLineKey(line), line);
  return [...byKey.values()];
}
