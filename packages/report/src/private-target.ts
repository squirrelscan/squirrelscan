// Rules that do not apply to a local or private-network host (pub#629).
// Shared across the CLI console and every report renderer.
//
// The rules runner skips the transport and delivery rules (HTTPS, HSTS,
// caching, compression, HTTP/2) when the audited host is localhost, a `.local`
// name, loopback, RFC1918 or link-local, emitting a `skipped` check with
// skipReason "private-target" for each (once per page, for a page rule).
// Skipped checks are neither passes nor findings, so the issue list already
// leaves them out and the score never counts them. This turns them into ONE
// note per report, instead of a line per rule and page.

import { PRIVATE_TARGET_SKIP_REASON } from "@squirrelscan/core-contracts";

import type { ReportRuleResult } from "./types";

export interface PrivateTargetRule {
  id: string;
  name: string;
}

/** The slice of a report this needs, so any report-shaped object works. */
export interface PrivateTargetReportShape {
  ruleResults: Record<string, ReportRuleResult>;
}

/**
 * Rules the runner skipped because the audited host is local or private,
 * sorted by name (then id) so the line reads in order. Empty for a public host,
 * and for reports written before pub#629.
 */
export function privateTargetSkippedRules(report: PrivateTargetReportShape): PrivateTargetRule[] {
  const rules: PrivateTargetRule[] = [];
  for (const ruleId of Object.keys(report.ruleResults)) {
    const result = report.ruleResults[ruleId];
    if (!result) continue;
    if (
      result.checks.some(
        (c) => c.status === "skipped" && c.skipReason === PRIVATE_TARGET_SKIP_REASON,
      )
    ) {
      rules.push({ id: ruleId, name: result.meta.name });
    }
  }
  return rules.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * One-line disclosure, e.g.
 *   "Local or private-network host: 2 transport and delivery rules do not apply
 *   here and are not scored (HTTPS, Compression)."
 * Returns null when no rule was skipped for that reason.
 */
export function privateTargetLine(report: PrivateTargetReportShape): string | null {
  const rules = privateTargetSkippedRules(report);
  if (rules.length === 0) return null;
  const one = rules.length === 1;
  const names = rules.map((r) => r.name).join(", ");
  return `Local or private-network host: ${rules.length} transport and delivery rule${one ? "" : "s"} ${one ? "does" : "do"} not apply here and ${one ? "is" : "are"} not scored (${names}).`;
}
