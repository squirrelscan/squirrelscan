// The internal link probe (repo#2729): a status-only request for each internal
// link target the crawl did not fetch, so links/broken-links can find a linked
// 404 the crawl never reached.
//
// A GET to a link the crawl did not choose to follow can change state on the
// site (log out, unsubscribe, delete, confirm a token, add to a cart), so the
// probe is safe by construction:
//
// - It never requests a link that looks like an action (`looksLikeAnAction`,
//   `linkTextLooksLikeAnAction`): action words in a path segment, a query key
//   or value, token-like query values, and rel=nofollow or action-worded links.
// - It sends no credentials: no cookies, no Authorization, and none of the
//   audit's custom request headers, which can carry auth. Only a User-Agent
//   and Accept.
// - HEAD first. GET (a one-byte range, body discarded) only when the server
//   answers the HEAD with 405 or 501, which say HEAD is not supported.
// - Redirects are followed by hand, and every hop must pass the same checks
//   as the first request (scope, robots.txt, the action filter). A redirect
//   that leaves them is not followed: its 3xx is the target's status.
// - The caller holds it to the crawl's scope, robots.txt, per-host concurrency
//   and a per-audit limit (`[internal_links] max_targets`).

import { Effect } from "effect";

import { isRateLimitedResponse } from "@squirrelscan/utils/rate-limit";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";
import { isHttpOrHttpsUrl } from "@squirrelscan/utils/safe-fetch";

import type { FetchBudget } from "./fetch-budget";

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

export interface LinkTargetProbeOptions {
  /** The crawl's user agent. */
  userAgent: string;
  timeoutMs: number;
  /** Requests in flight at once (the crawl's per-host concurrency). */
  concurrency: number;
  /**
   * May this URL be requested: in scope, allowed by robots.txt, not an action.
   * Applied to every redirect hop.
   */
  mayRequest: (url: string) => boolean;
  budget?: FetchBudget;
  /**
   * A page on the same site the crawl fetched with a 2xx, asked first. A
   * server that answers its HEAD with 4xx or 5xx (some frameworks route only
   * GET) cannot be trusted on the targets either: their 4xx and 5xx are
   * reported as unanswered, never as broken.
   */
  controlUrl?: string;
  /** Test seam. */
  send?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface LinkTargetProbeResult {
  url: string;
  /** The final status; a 3xx when a redirect left what the probe may request. */
  status: number | null;
  error: string | null;
  rateLimited?: boolean;
}

const MAX_HOPS = 5;

async function requestStatus(
  url: string,
  method: "HEAD" | "GET",
  options: LinkTargetProbeOptions,
  signal: AbortSignal,
): Promise<Response> {
  const send = options.send ?? fetchUndecoded;
  let current = url;
  for (let hop = 0; ; hop++) {
    const response = await send(current, {
      method,
      // No cookies, no Authorization, no custom headers: see the top of this file.
      headers: {
        "User-Agent": options.userAgent,
        Accept: "*/*",
        ...(method === "GET" ? { Range: "bytes=0-0" } : {}),
      },
      credentials: "omit",
      redirect: "manual",
      signal,
    });
    response.body?.cancel().catch(() => {});
    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location || hop + 1 >= MAX_HOPS) return response;
    let next: string;
    try {
      next = new URL(location, current).href;
    } catch {
      return response;
    }
    if (!isHttpOrHttpsUrl(next) || !options.mayRequest(next)) return response;
    current = next;
  }
}

async function probeOne(url: string, options: LinkTargetProbeOptions): Promise<LinkTargetProbeResult> {
  if (!options.mayRequest(url)) return { url, status: null, error: "not requested" };
  if (options.budget?.shouldSkip(url)) return { url, status: null, error: "skipped" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = Date.now();
  try {
    let response = await requestStatus(url, "HEAD", options, controller.signal);
    // 405 Method Not Allowed and 501 Not Implemented say the server does not
    // do HEAD; only then is the GET sent.
    if (response.status === 405 || response.status === 501) {
      response = await requestStatus(url, "GET", options, controller.signal);
    }
    options.budget?.record(url, Date.now() - started, "ok");
    const rateLimited = isRateLimitedResponse(response.status, response.headers.get("retry-after"));
    return { url, status: response.status, error: null, ...(rateLimited ? { rateLimited } : {}) };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    options.budget?.record(url, Date.now() - started, timedOut ? "timeout" : "error");
    return {
      url,
      status: null,
      error: timedOut ? "timeout" : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface LinkTargetProbe {
  results: LinkTargetProbeResult[];
  /** The control page's HEAD failed, so no target's 4xx or 5xx was trusted. */
  headUnreliable: boolean;
}

/** Status-check each URL as described at the top of this file, in input order. */
export function probeLinkTargets(
  urls: string[],
  options: LinkTargetProbeOptions,
): Effect.Effect<LinkTargetProbe, never, never> {
  const unique = [...new Set(urls)];
  return Effect.gen(function* () {
    if (unique.length === 0) return { results: [], headUnreliable: false };
    // The control is a page the crawl already fetched, so it is asked
    // whatever the filters say (they are for links the crawl did not follow;
    // its redirect hops still pass them), and outside the budget. No answer
    // says nothing either way.
    const controlUrl = options.controlUrl;
    const control = controlUrl
      ? yield* Effect.promise(() =>
          probeOne(controlUrl, {
            ...options,
            mayRequest: (url) => url === controlUrl || options.mayRequest(url),
            budget: undefined,
          }),
        )
      : null;
    const headUnreliable = control?.status != null && control.status >= 400;
    const results = yield* Effect.all(
      unique.map((url) => Effect.promise(() => probeOne(url, options))),
      { concurrency: Math.max(1, options.concurrency) },
    );
    if (!headUnreliable) return { results, headUnreliable };
    return {
      headUnreliable,
      results: results.map((r) =>
        r.status !== null && r.status >= 400
          ? { url: r.url, status: null, error: "head unreliable" }
          : r,
      ),
    };
  });
}
