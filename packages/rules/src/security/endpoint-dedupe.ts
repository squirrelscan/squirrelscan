// One finding per leaking endpoint across security/auth-endpoint-disclosure and
// security/unauthenticated-api (squirrelscan#2082).
//
// Both rules probe current-user endpoints such as /api/me (one shared anonymous
// GET per audit, squirrelscan#1886) and each reports what it finds on its own.
// After the site pass the runner calls this once: an endpoint the auth rule
// reported keeps the auth rule's finding (the more specific one: it names the
// password, secret or user-record fields), and unauthenticated-api's finding on
// it is taken out with everything it counted. Any other endpoint keeps
// unauthenticated-api's finding. Because the decision reads only the two
// results, it holds whichever rule ran first and however the auth rule ended
// (probe deadline, aborted run, exception, runner timeout): an auth rule that
// did not finish reported nothing, so unauthenticated-api's finding stands.

import type { CheckResult, RuleRunResult } from "../types";

import { AUTH_ENDPOINT_DISCLOSURE_RULE_ID } from "./auth-endpoint-disclosure";
import { anonymousGetUrl } from "./probe-http";
import { dropEndpointsReportedElsewhere, UNAUTHENTICATED_API_RULE_ID } from "./unauthenticated-api";

/** The auth rule's finding check: one per endpoint, its URL in `details.endpoint`. */
const AUTH_FINDING_CHECK = "auth-endpoint-disclosure";

/**
 * Normalised URLs (anonymousGetUrl) of the endpoints the auth rule reported. A
 * finding the user waived in squirrel.toml still counts: the endpoint is in the
 * rule's results, and the waiver should not bring the same leak back as an
 * unauthenticated-api finding.
 */
export function endpointsReportedByAuthRule(checks: readonly CheckResult[]): Set<string> {
  const out = new Set<string>();
  for (const check of checks) {
    if (check.name !== AUTH_FINDING_CHECK) continue;
    const waived = check.status === "pass" && check.details?.ignored !== undefined;
    if (check.status !== "fail" && !waived) continue;
    const endpoint = check.details?.endpoint;
    if (typeof endpoint !== "string") continue;
    try {
      out.add(anonymousGetUrl(endpoint));
    } catch {
      // Not a URL: matches nothing.
    }
  }
  return out;
}

/**
 * Apply the one-finding-per-endpoint rule to one site pass's results, keyed by
 * rule id. Returns the replacement for unauthenticated-api's result when it
 * changed, otherwise undefined. Pure: the inputs are not modified.
 */
export function dedupeEndpointFindings(results: ReadonlyMap<string, RuleRunResult>): RuleRunResult | undefined {
  const auth = results.get(AUTH_ENDPOINT_DISCLOSURE_RULE_ID);
  const api = results.get(UNAUTHENTICATED_API_RULE_ID);
  if (!auth || !api) return undefined;
  const reported = endpointsReportedByAuthRule(auth.checks);
  const checks = dropEndpointsReportedElsewhere(api.checks, reported);
  return checks === api.checks ? undefined : { ...api, checks };
}
