// Fetches the site refused, recorded by the root probes so the report can say
// "refused" instead of "not found".
//
// A 403 from a bot wall on /robots.txt says nothing about whether the file
// exists. Each probe used to fold that into its "absent" shape, and the rules
// then asserted the absence. The probes now note the refusal here and treat the
// request as unanswered.

import {
  MAX_REFUSED_FETCHES,
  type RefusedFetch,
  type RefusedResource,
} from "@squirrelscan/core-contracts";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";
import { detectWafFromHeaders, getWafProviderName } from "@squirrelscan/utils/waf";

/** What a refusal check needs from a response. */
export type RefusalCandidate = Pick<Response, "status" | "headers">;

/**
 * Whether a response is the site refusing the crawler rather than answering.
 *
 * 401/403 are auth and bot walls, 429/430 are throttling, and a 503 is a
 * refusal only when Cloudflare stamps it as a challenge: a bare 503 is an
 * outage, which stays an answer.
 */
export function isRefusal(response: RefusalCandidate): boolean {
  const { status } = response;
  if (status === 401 || status === 403 || isRateLimitStatus(status)) return true;
  return status === 503 && response.headers.get("cf-mitigated") === "challenge";
}

/**
 * Whether a response is a block signal that should stop the optional probes (#1655): throttling
 * (429/430) or a bot challenge (`cf-mitigated: challenge`, on any status). A lone 401/403 is not
 * one: sites answer those for a single protected path without banning anyone.
 */
export function isBlockSignal(response: RefusalCandidate): boolean {
  return isRateLimitStatus(response.status) || response.headers.get("cf-mitigated") === "challenge";
}

/** Collects the refusals of one crawl, deduplicated by URL and bounded. */
export class RefusalLog {
  private readonly byUrl = new Map<string, RefusedFetch>();
  private blockSeen = false;

  /** True once any response of the crawl was a block signal; the optional probes stop at it. */
  get blocked(): boolean {
    return this.blockSeen;
  }

  /** Notes a block signal without recording a refusal, for probes whose resource is not a refusal kind. */
  observe(response: RefusalCandidate): boolean {
    if (!isBlockSignal(response)) return false;
    this.blockSeen = true;
    return true;
  }

  /** Records `response` when it is a refusal. Returns whether it was one. */
  note(url: string, resource: RefusedResource, response: RefusalCandidate): boolean {
    this.observe(response);
    if (!isRefusal(response)) return false;
    if (this.byUrl.has(url) || this.byUrl.size >= MAX_REFUSED_FETCHES) return true;
    const waf = detectWafFromHeaders(response.headers);
    this.byUrl.set(url, {
      url,
      resource,
      status: response.status,
      ...(waf.provider ? { provider: getWafProviderName(waf.provider) } : {}),
    });
    return true;
  }

  list(): RefusedFetch[] {
    return [...this.byUrl.values()];
  }
}

/**
 * `note` for a probe that may run without a log (a caller outside a crawl, or a
 * test): still reports whether the response was a refusal.
 */
export function noteRefusal(
  log: RefusalLog | undefined,
  url: string,
  resource: RefusedResource,
  response: RefusalCandidate,
): boolean {
  return log ? log.note(url, resource, response) : isRefusal(response);
}
