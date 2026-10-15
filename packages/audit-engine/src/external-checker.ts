// External link checker
// Uses HEAD requests with GET fallback, optional cache, WAF detection
//
// repo#2759: a link that looks like an action or carries a token (a
// third-party unsubscribe or magic link, a signed download URL) is never
// requested; the URL itself can be the credential. The audit's entry point
// (`checkCollectedExternalLinks`) leaves such links out before anything is
// sent, the cloud bulk checker included, and redirects are followed by hand
// here so a hop into one is not requested either. Same rules as the internal
// link probe (`looksLikeAnAction`, @squirrelscan/utils/link-actions).

import { Effect } from "effect";

import {
  isRateLimitedResponse,
  isRateLimitStatus,
} from "@squirrelscan/utils/rate-limit";
import {
  DEFAULT_MAX_BODY_BYTES,
  fetchUndecoded,
  readBodyCapped,
} from "@squirrelscan/utils/response-body";
import { looksLikeAnAction } from "@squirrelscan/utils/link-actions";
import {
  EgressRefusedError,
  egressGuardedSend,
  refusedWithoutLookup,
  type EgressPolicy,
} from "@squirrelscan/utils/public-egress";
import { isHttpOrHttpsUrl } from "@squirrelscan/utils/safe-fetch";
import { detectWaf, detectWafChallengePage, type WafProvider } from "@squirrelscan/waf-detect";

// ============================================
// LINK CACHE INTERFACE (implemented by CLI's LinkCacheStorage)
// ============================================

export interface LinkCacheEntry {
  href: string;
  status: number | null;
  error: string | null;
  redirectTarget: string | null;
  checkedAt: number;
  wafBlocked?: boolean;
  wafProvider?: string;
  // No `rateLimited` here on purpose (#1829): throttled results are never
  // cached, because the 7-day default TTL would keep a live link reported as
  // "unverifiable" long after the host recovered.
}

/**
 * Injectable link cache — CLI provides SQLite-backed cache; cloud passes null (no caching).
 * Shared by every audit on the machine, so it is read and written only under a
 * public-only egress policy (pub#775, {@link isPublicOnlyEgress}).
 */
export interface LinkCache {
  getCachedBulk(urls: string[], ttlSeconds: number): Map<string, LinkCacheEntry>;
  setCachedBulk(entries: LinkCacheEntry[]): void;
}

// ============================================
// TYPES
// ============================================

export interface ExternalCheckResult {
  href: string;
  status: number | null;
  error: string | null;
  redirectTarget: string | null;
  fromCache: boolean;
  wafBlocked?: boolean;
  wafProvider?: WafProvider;
  /**
   * The target answered with rate limiting (429/430, or 503 + `Retry-After`),
   * so its status is unverified rather than broken (#1829).
   */
  rateLimited?: boolean;
  /**
   * Never requested: the egress policy refuses its address (a private,
   * link-local or metadata one for a public site's audit). Unresolved, never
   * broken (pub#770).
   */
  refused?: boolean;
}

export interface ExternalCheckerOptions {
  ttlSeconds: number;
  concurrency: number;
  timeoutMs: number;
  userAgent: string;
  /**
   * Optional cloud bulk checker (e.g. the credit-gated /v1/services/dead-links
   * endpoint). When present it is tried FIRST for every url the local cache
   * misses; urls it resolves skip the per-link local fetch. Any throw, or a
   * chunk answered with none of its urls, falls back to the existing per-link
   * local path for the remaining urls. The map is keyed by the exact requested
   * url.
   *
   * pub#775: never sent a url whose host is non-public by the URL alone (a
   * private IP literal, `localhost`, a `.local` or single-label name), whatever
   * {@link egress} allows: those take the local path. A url it answers with
   * its non-public refusal ({@link BULK_NON_PUBLIC_REFUSAL}) takes the local
   * path too, so the refusal is never recorded as the link's verdict.
   */
  bulkChecker?: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>;
  /**
   * Every hop of every local request, the first included, is vetted against
   * this policy before it is sent and connects to the address it was vetted
   * on (`@squirrelscan/utils/public-egress`). A refused first request leaves
   * the link unresolved, never broken; a refused redirect hop is not followed,
   * and the redirect that pointed there is the link's answer. Absent: the
   * strict default, {@link DEFAULT_EGRESS}, public addresses only. A caller
   * auditing a private site passes `allowPrivateNetwork: true`.
   */
  egress?: EgressPolicy;
}

/**
 * The policy when a caller gives none: fail closed. Public addresses only,
 * never link-local or metadata, each hop pinned to the address vetted.
 */
export const DEFAULT_EGRESS: EgressPolicy = { allowPrivateNetwork: false };

/**
 * True when `policy` only ever reaches public addresses, and any host, so a
 * verdict it produced holds for any audit. One that allows private addresses (an audit of
 * a private site) may have reached the auditor's own network through a public
 * name or a redirect, and the shared link cache would hand that verdict to a
 * public site's audit (pub#775): its checks neither read nor write the cache.
 */
export function isPublicOnlyEgress(policy: EgressPolicy): boolean {
  return (
    !policy.allowPrivateNetwork &&
    !policy.allowPrivateTarget &&
    !policy.trustTarget &&
    // A host-restricted check stops where others would not: its verdict is its own.
    !policy.allowHost
  );
}

/**
 * The `error` prefix of the cloud dead-links service's answer for a link it
 * would not request because the link, or a redirect it led to, is not on a
 * public address (`blocked_non_public_host:<reason>`). A refusal, not a
 * verdict on the link: it takes the local check (pub#775).
 */
export const BULK_NON_PUBLIC_REFUSAL = "blocked_non_public_host";

function isBulkNonPublicRefusal(result: ExternalCheckResult): boolean {
  return result.status === null && (result.error?.startsWith(`${BULK_NON_PUBLIC_REFUSAL}:`) ?? false);
}

/** Max urls per bulk-checker call — mirrors SERVICE_LIMITS.deadLinksBatchUrls. */
export const BULK_CHECK_CHUNK_SIZE = 200;

/**
 * Run a bulk checker over `urls` in chunks, accumulating whatever it resolves.
 * Never throws: a failing chunk, or one that answers none of its urls, stops
 * the bulk pass and the unresolved remainder takes the per-link local path.
 */
export async function runBulkChecker(
  bulkChecker: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>,
  urls: string[],
  chunkSize: number = BULK_CHECK_CHUNK_SIZE
): Promise<Map<string, ExternalCheckResult>> {
  const resolved = new Map<string, ExternalCheckResult>();
  for (let i = 0; i < urls.length; i += chunkSize) {
    const requested = urls.slice(i, i + chunkSize);
    try {
      const chunk = await bulkChecker(requested);
      for (const [url, result] of chunk) resolved.set(url, result);
      // pub#753: a service that answered nothing for a whole chunk (overloaded,
      // or out of time on links it has not seen) will most likely do the same
      // for the next one, and each such chunk costs its full wait. Stop asking:
      // the remaining urls go to the local checker straight away. A chunk that
      // answers even one of its urls keeps the pass going.
      if (!requested.some((url) => chunk.has(url))) break;
    } catch {
      break; // cloud unavailable — remaining urls fall back to local checks
    }
  }
  return resolved;
}

const DEFAULT_OPTIONS: ExternalCheckerOptions = {
  ttlSeconds: 7 * 24 * 60 * 60,
  concurrency: 5,
  timeoutMs: 10000,
  userAgent: "SquirrelScan/2.0 (+https://squirrelscan.com)",
};

interface CheckUrlResult {
  status: number | null;
  error: string | null;
  redirectTarget: string | null;
  wafBlocked?: boolean;
  wafProvider?: WafProvider;
  /**
   * The target answered with rate limiting (429/430, or 503 + `Retry-After`),
   * so its status is unverified rather than broken (#1829).
   */
  rateLimited?: boolean;
  /** The egress policy refused the first request: nothing was sent, and nothing is cached. */
  refused?: boolean;
}

/**
 * What a site answers a request it takes for a robot's: a sign-in or bot wall
 * (401, 403), a method or content refusal bot rules send (405, 406), and
 * LinkedIn's 999. Asked from this machine, none of them says the page is gone,
 * so a link answering one is unverifiable, never broken (pub#800). The cloud
 * link checker takes the same statuses to a browser-grade check.
 */
const BOT_WALL_STATUSES = new Set([401, 403, 405, 406, 999]);

/**
 * A cached wall or timeout written before this was counted broken by a client
 * from before pub#800, and is asked again. After it, a cached wall status is a
 * real answer (a cloud-confirmed broken 403, say): walls and timeouts are no
 * longer cached at all. A month past the change, so an older client still in
 * use for a while, and the cache's 7-day default life, are both covered.
 */
const WALL_VERDICT_CUTOFF_MS = Date.parse("2026-11-16T00:00:00Z");

/** A cached answer from before pub#800, which counted a wall or a timeout as broken: asked again. */
function staleWallVerdict(entry: LinkCacheEntry): boolean {
  if (entry.wafBlocked || entry.checkedAt >= WALL_VERDICT_CUTOFF_MS) return false;
  return (entry.status !== null && BOT_WALL_STATUSES.has(entry.status)) || entry.error === "timeout";
}

/**
 * A wall status that, from these headers, is the site's own answer rather than
 * a robot check, so it stays broken (pub#800 review):
 * - an object store's 403 for a key it will not list (S3, GCS), which is how a
 *   deleted download answers: by its headers, or by its XML error body when a
 *   CDN in front (CloudFront) strips them;
 * - an HTTP authentication challenge (`WWW-Authenticate` naming Basic, Digest,
 *   Negotiate or NTLM, in any position), which a person meets too;
 * - a 405 whose `Allow` header leaves out GET: the link points at an endpoint
 *   nobody can open.
 */
function realRefusal(status: number, headers: Headers, body: string | undefined): boolean {
  if (status === 403) {
    return (
      headers.has("x-amz-request-id") ||
      /^amazons3$/i.test(headers.get("server") ?? "") ||
      headers.has("x-guploader-uploadid") ||
      /<Code>(?:AccessDenied|NoSuchKey)<\/Code>/.test(body ?? "")
    );
  }
  if (status === 401) {
    return /\b(?:basic|digest|negotiate|ntlm)\b/i.test(headers.get("www-authenticate") ?? "");
  }
  if (status === 405) {
    const allow = headers.get("allow");
    return allow !== null && !/\bGET\b/i.test(allow);
  }
  return false;
}

/** Redirects followed per request, a browser's limit. */
const MAX_REDIRECTS = 20;

/** The statuses fetch's own `redirect: "follow"` follows; 300 and 304 are answers. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * One request, following redirects by hand: a hop whose Location is not
 * http(s), looks like an action or token link (repo#2759), or is refused by
 * the egress policy is not requested, and the 3xx that pointed there is the
 * answer. Every hop, the first included, goes through the same guarded send,
 * with no headers but User-Agent, Accept and the Accept-Encoding it decodes.
 * `redirectTarget` is the last URL requested when the chain was followed to
 * its end, or the Location that was not followed; null when the link answered
 * without redirecting. A refused first request throws EgressRefusedError.
 */
async function requestFollowingSafeRedirects(
  href: string,
  method: "HEAD" | "GET",
  options: ExternalCheckerOptions,
  signal: AbortSignal,
): Promise<{ response: Response; redirectTarget: string | null }> {
  const send = egressGuardedSend(fetchUndecoded, options.egress ?? DEFAULT_EGRESS);
  let current = href;
  let previous: Response | null = null;
  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await send(current, {
        method,
        headers: { "User-Agent": options.userAgent, Accept: "*/*" },
        signal,
        redirect: "manual",
      });
    } catch (error) {
      // Refused before it was sent: the redirect that pointed here answers.
      if (previous && error instanceof EgressRefusedError) {
        return { response: previous, redirectTarget: current };
      }
      throw error;
    }
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (!location) {
      return { response, redirectTarget: current !== href ? current : null };
    }
    let next: string;
    try {
      next = new URL(location, current).href;
    } catch {
      return { response, redirectTarget: current !== href ? current : null };
    }
    if (!isHttpOrHttpsUrl(next) || looksLikeAnAction(next)) {
      // Not followed: the link answers with this redirect.
      response.body?.cancel().catch(() => {});
      return { response, redirectTarget: next };
    }
    response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
    previous = response;
    current = next;
  }
}

async function checkSingleUrlAsync(
  href: string,
  options: ExternalCheckerOptions
): Promise<CheckUrlResult> {
  const controller = new AbortController();
  // #1729: the deadline stays armed until this function returns, so it also
  // covers the WAF body read below. Clearing it where the GET resolved disarmed
  // the abort at the HEADERS, leaving the body read below no time bound at all
  // — the 403 interstitials this branch exists to read are exactly the
  // responses a hostile origin is happy to trickle forever.
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    try {
      const head = await requestFollowingSafeRedirects(href, "HEAD", options, controller.signal);

      if (head.response.status < 400) {
        return {
          status: head.response.status,
          error: null,
          redirectTarget: head.redirectTarget,
        };
      }
    } catch (error) {
      // Refused by the egress policy: the GET would be refused too. Not
      // checked, so unresolved: never broken.
      if (error instanceof EgressRefusedError) {
        return { status: null, error: null, redirectTarget: null, refused: true };
      }
      // HEAD failed, try GET
    }

    const get = await requestFollowingSafeRedirects(href, "GET", options, controller.signal);
    const getResponse = get.response;
    const redirectTarget = get.redirectTarget;

    // pub#800: a wall says nothing about the page behind it, whether or not
    // its vendor can be named, so it is listed as unverifiable. A 503 is a
    // wall only when it is a challenge page; otherwise it is the site's own
    // error (or, with Retry-After, throttling, below).
    if (BOT_WALL_STATUSES.has(getResponse.status) || getResponse.status === 503) {
      let body: string | undefined;
      try {
        // Capped, and decoded no further than the cap (#2717): the WAF
        // markers sit at the top of an interstitial.
        body = await readBodyCapped(getResponse, DEFAULT_MAX_BODY_BYTES);
      } catch {
        // The body never arrived: the deadline above fired mid-read, or the
        // connection dropped. Most WAFs are identifiable from their response
        // headers alone (cf-ray, x-sucuri-id, a provider `server` value), so
        // run detection on the headers we DO have. `detectWaf` treats an
        // absent body as headers-only (#1729).
      }
      const headers = getResponse.headers;
      const challenge =
        getResponse.status !== 503 ||
        headers.get("cf-mitigated") === "challenge" ||
        detectWafChallengePage({
          status: 503,
          headers: {
            server: headers.get("server"),
            cfCacheStatus: headers.get("cf-cache-status"),
            xCache: headers.get("x-cache"),
          },
          html: body ?? null,
        }).detected;
      if (challenge && !realRefusal(getResponse.status, headers, body)) {
        const wafResult = detectWaf(headers, body);
        return {
          status: getResponse.status,
          error: null,
          redirectTarget,
          wafBlocked: true,
          wafProvider: wafResult.detected ? (wafResult.provider ?? "unknown") : "unknown",
        };
      }
    }

    // Throttling is not a broken link (#1829). Recorded rather than re-derived
    // from the status later: the 503 + Retry-After case is invisible once the
    // headers are gone, and the rules only ever see the stored row.
    if (isRateLimitedResponse(getResponse.status, getResponse.headers.get("retry-after"))) {
      return {
        status: getResponse.status,
        error: null,
        redirectTarget,
        rateLimited: true,
      };
    }

    return { status: getResponse.status, error: null, redirectTarget };
  } catch (error) {
    if (error instanceof EgressRefusedError) {
      return { status: null, error: null, redirectTarget: null, refused: true };
    }
    if ((error as Error).name === "AbortError") {
      // pub#800: a site that stalls robots looks exactly like a dead one from
      // here, so out of time is unverifiable, never broken. Not cached.
      return {
        status: null,
        error: null,
        redirectTarget: null,
        wafBlocked: true,
        wafProvider: "unknown",
      };
    }
    return { status: null, error: (error as Error).message || "Unknown error", redirectTarget: null };
  } finally {
    clearTimeout(timeoutId);
    // Closes every connection this check opened (#766). Neither a capped read
    // nor a cancelled body does: Bun keeps downloading until the signal aborts.
    controller.abort();
  }
}

function checkSingleUrl(
  href: string,
  options: ExternalCheckerOptions
): Effect.Effect<CheckUrlResult, never, never> {
  return Effect.promise(() => checkSingleUrlAsync(href, options));
}

export function checkExternalLinks(
  urls: string[],
  cache: LinkCache | null,
  options?: Partial<ExternalCheckerOptions>
): Effect.Effect<ExternalCheckResult[], never, never> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  opts.concurrency = Math.max(1, opts.concurrency);

  return Effect.gen(function* () {
    if (urls.length === 0) return [];

    const results: ExternalCheckResult[] = [];
    let urlsToCheck: string[] = [];

    // repo#2759: never requested, by the bulk checker or locally, and never
    // answered from an old cached verdict either. The audit leaves these out
    // before calling (checkCollectedExternalLinks reports them); this holds
    // for any other caller. They come back unresolved.
    // pub#770: an address the egress policy refuses on the URL alone is
    // refused here too, before the cache and the bulk checker, either of
    // which would otherwise answer for it: a verdict another audit (a private
    // site's) cached, or a remote service asked about it.
    const egress = opts.egress ?? DEFAULT_EGRESS;
    const uniqueUrls: string[] = [];
    for (const url of new Set(urls)) {
      if (looksLikeAnAction(url)) {
        results.push({ href: url, status: null, error: null, redirectTarget: null, fromCache: false });
      } else if (refusedWithoutLookup(url, egress)) {
        results.push({
          href: url,
          status: null,
          error: null,
          redirectTarget: null,
          fromCache: false,
          refused: true,
        });
      } else {
        uniqueUrls.push(url);
      }
    }
    if (uniqueUrls.length === 0) return results;

    // pub#775: a private site's checks stay out of the cache every audit shares.
    const sharedCache = isPublicOnlyEgress(egress) ? cache : null;
    if (sharedCache) {
      const cachedEntries = sharedCache.getCachedBulk(uniqueUrls, opts.ttlSeconds);
      for (const url of uniqueUrls) {
        const cached = cachedEntries.get(url);
        if (cached && !staleWallVerdict(cached)) {
          results.push({
            href: cached.href,
            status: cached.status,
            error: cached.error,
            redirectTarget: cached.redirectTarget,
            fromCache: true,
            wafBlocked: cached.wafBlocked,
            wafProvider: cached.wafProvider as WafProvider | undefined,
          });
        } else {
          urlsToCheck.push(url);
        }
      }
    } else {
      urlsToCheck.push(...uniqueUrls);
    }

    if (urlsToCheck.length === 0) return results;

    // Cloud bulk path: resolve local-cache misses via the bulk checker first.
    // Resolved urls are surfaced as-is and written into the local cache so the
    // next run is a pure local hit; the unresolved remainder (or everything,
    // if the bulk checker failed) takes the per-link local path below.
    if (opts.bulkChecker) {
      // pub#775: a public service, so never sent a link whose URL names a
      // non-public host, whatever this audit's policy allows. Those take the
      // local check, which a private site's audit may make.
      const bulkUrls = urlsToCheck.filter((url) => !refusedWithoutLookup(url, DEFAULT_EGRESS));
      const bulkResolved =
        bulkUrls.length > 0
          ? yield* Effect.promise(() => runBulkChecker(opts.bulkChecker!, bulkUrls))
          : new Map<string, ExternalCheckResult>();
      if (bulkResolved.size > 0) {
        const stillToCheck: string[] = [];
        const bulkCacheEntries: LinkCacheEntry[] = [];
        for (const url of urlsToCheck) {
          const resolved = bulkResolved.get(url);
          // Its refusal of a non-public address is no answer: checked locally.
          if (resolved && !isBulkNonPublicRefusal(resolved)) {
            results.push({ ...resolved, href: url });
            // #1829: never cache a throttled verdict — see the per-link cache
            // write below for why. Nor an unverifiable one (pub#800): asked
            // again next run, which may be signed in where this one was not.
            if (cacheableVerdict(resolved)) {
              bulkCacheEntries.push({
                href: url,
                status: resolved.status,
                error: resolved.error,
                redirectTarget: resolved.redirectTarget,
                checkedAt: Date.now(),
                wafBlocked: resolved.wafBlocked,
                wafProvider: resolved.wafProvider,
              });
            }
          } else {
            stillToCheck.push(url);
          }
        }
        if (sharedCache && bulkCacheEntries.length > 0) {
          sharedCache.setCachedBulk(bulkCacheEntries);
        }
        urlsToCheck = stillToCheck;
      }
    }

    if (urlsToCheck.length === 0) return results;

    const checkEffects = urlsToCheck.map((href) =>
      checkSingleUrl(href, opts).pipe(
        Effect.map((result) => ({ href, ...result }))
      )
    );

    const checkedResults = yield* Effect.all(checkEffects, {
      concurrency: opts.concurrency,
    });

    if (sharedCache) {
      // #1829: a throttled result is a fact about the MOMENT, not the link. The
      // TTL is 7 days by default, so caching one 429 would keep a live link
      // reported as "unverifiable" for a week after the host recovered. Cache
      // the verified results only; throttled ones are re-checked next run.
      const cacheEntries: LinkCacheEntry[] = checkedResults
        // Nor a refused one: nothing was asked. Nor an unverifiable one, a
        // wall or a timeout: like throttling, a fact about the moment, and the
        // next run may ask the cloud link checker instead (pub#800).
        .filter((r) => cacheableVerdict(r))
        .map((r) => ({
          href: r.href,
          status: r.status,
          error: r.error,
          redirectTarget: r.redirectTarget,
          checkedAt: Date.now(),
          wafBlocked: r.wafBlocked,
          wafProvider: r.wafProvider,
        }));
      if (cacheEntries.length > 0) sharedCache.setCachedBulk(cacheEntries);
    }

    for (const r of checkedResults) {
      results.push({
        href: r.href,
        status: r.status,
        error: r.error,
        redirectTarget: r.redirectTarget,
        fromCache: false,
        wafBlocked: r.wafBlocked,
        wafProvider: r.wafProvider,
        rateLimited: r.rateLimited,
        ...(r.refused ? { refused: true } : {}),
      });
    }

    return results;
  });
}

export function checkExternalLink(
  href: string,
  cache: LinkCache | null,
  options?: Partial<ExternalCheckerOptions>
): Effect.Effect<ExternalCheckResult, never, never> {
  return checkExternalLinks([href], cache, options).pipe(
    Effect.map((results) => results[0]!)
  );
}

export function filterBrokenLinks(
  results: ExternalCheckResult[]
): ExternalCheckResult[] {
  return results.filter((r) => {
    if (r.error) return true;
    // Unverifiable, whatever its status: a wall or a timeout (pub#800).
    if (r.wafBlocked) return false;
    // Rate limiting means the status is UNVERIFIED, not that the link is dead
    // (#1829). Checked before the >= 400 test, which 429/430 would otherwise
    // satisfy.
    if (isRateLimited(r)) return false;
    if (r.status && r.status >= 400) return true;
    return false;
  });
}

/**
 * Whether a verdict goes into the link cache: a real answer about the link.
 * Not throttling (#1829), not a request that was never sent (pub#770), and not
 * an unverifiable one, a wall or a timeout (pub#800): each is a fact about the
 * moment, and the next audit, maybe signed in, asks again.
 */
export function cacheableVerdict(result: {
  status: number | null;
  rateLimited?: boolean;
  refused?: boolean;
  wafBlocked?: boolean;
}): boolean {
  return !isRateLimited(result) && result.refused !== true && result.wafBlocked !== true;
}

/** True when this result reflects throttling rather than the target's real state. */
export function isRateLimited(result: {
  status: number | null;
  rateLimited?: boolean;
}): boolean {
  return result.rateLimited === true || isRateLimitStatus(result.status);
}

/** Links whose status could not be verified because the host was throttling (#1829). */
export function filterRateLimitedLinks(
  results: ExternalCheckResult[]
): ExternalCheckResult[] {
  return results.filter((r) => isRateLimited(r));
}

export function filterWafBlockedLinks(
  results: ExternalCheckResult[]
): ExternalCheckResult[] {
  return results.filter((r) => r.wafBlocked === true);
}

export function getDisplayStatus(result: ExternalCheckResult): string {
  if (result.error) return `Error: ${result.error}`;
  if (result.status === null) return "Unknown";
  return String(result.status);
}
