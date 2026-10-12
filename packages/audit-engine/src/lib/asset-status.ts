// Status classification shared by the asset fetchers (scripts, stylesheets,
// fonts, third-party copies) so a throttled or challenged response is recorded
// as unverified rather than as a broken file (#703).

import { detectWaf } from "@squirrelscan/waf-detect";
import { isRateLimitedResponse } from "@squirrelscan/utils/rate-limit";

/**
 * True when a 403 or 503 was answered by a WAF or bot challenge instead of the
 * file. Headers only: the asset fetches read no body on the error path, and the
 * same header test the external link checker uses (#1829) is reused here.
 */
export function isWafChallengeResponse(status: number, headers: Headers): boolean {
  if (status !== 403 && status !== 503) return false;
  return detectWaf(headers).detected;
}

/** Throttled (429/430, or 503 with Retry-After) as a flag for a resource record. */
export function rateLimitedFlag(status: number, headers: Headers): true | undefined {
  return isRateLimitedResponse(status, headers.get("retry-after")) ? true : undefined;
}

/** WAF challenge as a flag for a resource record. */
export function wafBlockedFlag(status: number, headers: Headers): true | undefined {
  return isWafChallengeResponse(status, headers) ? true : undefined;
}
