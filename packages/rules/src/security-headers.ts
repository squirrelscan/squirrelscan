// @squirrelscan/rules/security-headers: the security response-header rules on
// their own, for a caller that grades one HTTP response and cannot load the
// rules barrel (it pulls linkedom, the runner and every rule), such as the
// squirrelscan web security headers checker running in a Worker.
//
// Each rule reads only the first crawled page's URL and its lowercased header
// record, and its file imports nothing at runtime, so this entry's import
// closure is these six files. tests/security-headers-entry.test.ts keeps it so.

import type { CheckResult, Rule, RuleContext, RuleResult } from "./types";

import { cspRule } from "./security/csp";
import { hstsRule } from "./security/hsts";
import { permissionsPolicyRule } from "./security/permissions-policy";
import { referrerPolicyRule } from "./security/referrer-policy";
import { xContentTypeRule } from "./security/x-content-type";
import { xFrameOptionsRule } from "./security/x-frame-options";

export {
  cspRule,
  hstsRule,
  permissionsPolicyRule,
  referrerPolicyRule,
  xContentTypeRule,
  xFrameOptionsRule,
};

/** The header rules, in the order a report lists them. */
export const SECURITY_HEADER_RULES: readonly Rule[] = [
  cspRule,
  hstsRule,
  xFrameOptionsRule,
  xContentTypeRule,
  referrerPolicyRule,
  permissionsPolicyRule,
];

/**
 * One header rule's checks for a single response, exactly as an audit reports
 * them for its first page. `headers` is keyed by lowercased name with repeated
 * values joined the way `Headers.get()` joins them, as the crawler records them.
 */
export function gradeResponseHeaders(
  rule: Rule,
  url: string,
  headers: Record<string, string>,
): CheckResult[] {
  const ctx = { site: { pages: [{ url, headers }] } } as unknown as RuleContext;
  const result: RuleResult | Promise<RuleResult> = rule.run(ctx);
  if (result instanceof Promise) {
    throw new Error(`${rule.meta.id} is not a synchronous header rule`);
  }
  return result.checks;
}
