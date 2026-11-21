// One finding per leak across the probing rules that read the same endpoint
// (squirrelscan#2082, squirrelscan#2083).
//
// security/auth-endpoint-disclosure, security/unauthenticated-api and
// security/json-sensitive-fields can all probe a current-user endpoint such as
// /api/me or /api/account (one shared anonymous GET per audit, squirrelscan#1886)
// and each reports what it finds on its own. After the site pass the runner
// calls `dedupeCrossRuleFindings` once, which applies every pair in
// CROSS_RULE_PAIRS: the rule that keeps a finding, the rule that loses its
// overlapping one, and how the overlap is matched. Both pairs key endpoints the
// same way (anonymousGetUrl: query and fragment dropped).
//
//  - auth-endpoint-disclosure over unauthenticated-api, per endpoint: an
//    endpoint the auth rule reported keeps the auth rule's finding (the more
//    specific one: it names the password, secret or user-record fields), and
//    unauthenticated-api's finding on it is taken out with everything it
//    counted.
//  - auth-endpoint-disclosure over json-sensitive-fields, per field: a password,
//    hash or secret field the auth rule reported on an endpoint keeps the auth
//    rule's finding (the more specific one for an auth or session endpoint),
//    and json-sensitive-fields drops only that field (or a field inside it).
//    Its other fields on the endpoint, and its bulk personal data finding,
//    stand.
//
// The dropping rule's checks are rebuilt from what is left, so no count or
// message names a dropped finding. Because the decision reads only the rules'
// results, it holds whichever rule ran first and however the auth rule ended
// (probe deadline, aborted run, exception, runner timeout): an auth rule that
// did not finish reported nothing, so the other rule's finding stands.

import type { CheckResult, RuleRunResult } from "../types";

import { AUTH_ENDPOINT_DISCLOSURE_RULE_ID } from "./auth-endpoint-disclosure";
import { authFieldKey } from "./field-key";
import {
  dropFieldsReportedElsewhere,
  JSON_SENSITIVE_FIELDS_RULE_ID,
} from "./json-sensitive-fields";
import { anonymousGetUrl } from "./probe-http";
import {
  dropEndpointsReportedElsewhere,
  UNAUTHENTICATED_API_RULE_ID,
} from "./unauthenticated-api";

/** The auth rule's finding check: one per endpoint, its URL in `details.endpoint`. */
const AUTH_FINDING_CHECK = "auth-endpoint-disclosure";

/**
 * The auth rule's findings, keyed by normalised endpoint URL (anonymousGetUrl).
 * A finding the user waived in squirrel.toml still counts: the endpoint is in
 * the rule's results, and the waiver should not bring the same leak back as
 * another rule's finding.
 */
function authFindings(
  checks: readonly CheckResult[]
): Map<string, CheckResult> {
  const out = new Map<string, CheckResult>();
  for (const check of checks) {
    if (check.name !== AUTH_FINDING_CHECK) continue;
    const waived =
      check.status === "pass" && check.details?.ignored !== undefined;
    if (check.status !== "fail" && !waived) continue;
    const endpoint = check.details?.endpoint;
    if (typeof endpoint !== "string") continue;
    try {
      out.set(anonymousGetUrl(endpoint), check);
    } catch {
      // Not a URL: matches nothing.
    }
  }
  return out;
}

/** Normalised URLs (anonymousGetUrl) of the endpoints the auth rule reported. */
export function endpointsReportedByAuthRule(
  checks: readonly CheckResult[]
): Set<string> {
  return new Set(authFindings(checks).keys());
}

/**
 * The field keys (field-key.ts) the auth rule reported, by normalised endpoint
 * URL. Read from the finding's items, one per field (`meta.field`).
 */
export function fieldsReportedByAuthRule(
  checks: readonly CheckResult[]
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [endpoint, check] of authFindings(checks)) {
    const keys = new Set<string>();
    for (const item of check.items ?? []) {
      const field = item.meta?.field;
      const key = typeof field === "string" ? authFieldKey(field) : undefined;
      if (key !== undefined) keys.add(key);
    }
    if (keys.size > 0) out.set(endpoint, keys);
  }
  return out;
}

interface CrossRulePair {
  /** The rule whose finding stands: the more specific one. */
  keeps: string;
  /** The rule that loses the overlapping finding. */
  drops: string;
  /** The dropping rule's checks without the overlap; `dropping` itself when nothing overlaps. */
  dedupe: (
    kept: readonly CheckResult[],
    dropping: CheckResult[]
  ) => CheckResult[];
}

/** Every cross-rule pair, in the order they are applied. */
export const CROSS_RULE_PAIRS: readonly CrossRulePair[] = [
  {
    keeps: AUTH_ENDPOINT_DISCLOSURE_RULE_ID,
    drops: UNAUTHENTICATED_API_RULE_ID,
    dedupe: (auth, api) =>
      dropEndpointsReportedElsewhere(api, endpointsReportedByAuthRule(auth)),
  },
  {
    keeps: AUTH_ENDPOINT_DISCLOSURE_RULE_ID,
    drops: JSON_SENSITIVE_FIELDS_RULE_ID,
    dedupe: (auth, json) =>
      dropFieldsReportedElsewhere(json, fieldsReportedByAuthRule(auth)),
  },
];

/**
 * Apply every pair in CROSS_RULE_PAIRS to one site pass's results, keyed by
 * rule id. Returns the replacement result of each rule that changed, keyed by
 * rule id (empty when none did). Pure: the inputs are not modified.
 */
export function dedupeCrossRuleFindings(
  results: ReadonlyMap<string, RuleRunResult>
): Map<string, RuleRunResult> {
  const current = new Map(results);
  const changed = new Map<string, RuleRunResult>();
  for (const pair of CROSS_RULE_PAIRS) {
    const kept = current.get(pair.keeps);
    const dropping = current.get(pair.drops);
    if (!kept || !dropping) continue;
    const checks = pair.dedupe(kept.checks, dropping.checks);
    if (checks === dropping.checks) continue;
    const next = { ...dropping, checks };
    current.set(pair.drops, next);
    changed.set(pair.drops, next);
  }
  return changed;
}

/**
 * unauthenticated-api's replacement result from `dedupeCrossRuleFindings`, or
 * undefined when it did not change.
 */
export function dedupeEndpointFindings(
  results: ReadonlyMap<string, RuleRunResult>
): RuleRunResult | undefined {
  return dedupeCrossRuleFindings(results).get(UNAUTHENTICATED_API_RULE_ID);
}
