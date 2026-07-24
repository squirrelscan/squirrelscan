// Shared, framework-agnostic audience logic for cloud-/Pro-gated rules that
// didn't run this audit (#368, #747, #792, #780). Single source of truth for
// the static HTML report's LockedRulesSection and every other renderer
// (llm/markdown/text) plus the CLI footer — a signed-in paying user must
// never see the "get a free account" upsell, a quick-coverage run must never
// read as a cloud outage, and a failed/blocked audit must never blame our
// infra for checks that never had a chance to run.
//
// Cause precedence mirrors the audit pipeline: a failed audit ran nothing at
// all; quick coverage never attempts cloud regardless of render mode; --http
// only matters when cloud would otherwise run. "Temporarily unavailable" is
// the last resort, reserved for surface/full runs that really tried.

import type {
  AuditStatus,
  CloudPlanTier,
  CloudRenderMode,
  CoverageMode,
  LockedRule,
} from "@squirrelscan/core-contracts";

export type LockedRulesAudience =
  | "audit-failed"
  | "quick-coverage"
  | "http-opt-out"
  | "paid-unavailable"
  | "free-upsell"
  | "anonymous-upsell";

export interface LockedRulesCta {
  /** Full link text — includes any trailing words (e.g. "Get started to unlock them"). */
  label: string;
  url: string;
}

export interface LockedRulesMessage {
  audience: LockedRulesAudience;
  /** Signed-in (free/paid) account vs anonymous/local — drives the heading framing. */
  signedIn: boolean;
  count: number;
  /** e.g. "3 checks didn't run this audit" — plain text, no icon/markup. */
  heading: string;
  /** One-line actionable message, plain text, no embedded links. */
  action: string;
  /** Optional call to action, rendered as its own link after `action`. */
  cta?: LockedRulesCta;
  rules: LockedRule[];
}

/** The slice of AuditReport this helper needs — kept narrow so any report-shaped object works. */
export interface LockedRulesReportShape {
  lockedRules?: LockedRule[];
  cloudPlan?: CloudPlanTier;
  cloudMode?: CloudRenderMode;
  coverageMode?: CoverageMode;
  status?: AuditStatus;
}

/**
 * Resolve the audience-aware "checks not run" message for a report, or
 * `null` when there's nothing locked (no section should render).
 */
export function lockedRulesMessage(report: LockedRulesReportShape): LockedRulesMessage | null {
  const locked = report.lockedRules;
  if (!locked || locked.length === 0) return null;

  const plan = report.cloudPlan ?? "anonymous";
  const signedIn = plan === "free" || plan === "paid";
  const optedOut = report.cloudMode === "http";
  const isQuick = report.coverageMode === "quick";
  const auditFailed = report.status === "failed" || report.status === "blocked";
  const count = locked.length;
  const noun = count === 1 ? "check" : "checks";
  const heading = signedIn
    ? `${count} ${noun} didn't run this audit`
    : `${count} more ${noun} with cloud audits`;
  const base = { count, heading, rules: locked, signedIn };

  if (auditFailed) {
    return {
      ...base,
      audience: "audit-failed",
      action:
        "These cloud checks need a completed audit to run. See the note above, then re-run the audit to include them.",
    };
  }
  if (signedIn && isQuick) {
    return {
      ...base,
      audience: "quick-coverage",
      action:
        "This was a quick audit: cloud checks don't run in quick coverage. Re-run with -C surface or -C full to include them.",
    };
  }
  if (signedIn && optedOut) {
    return {
      ...base,
      audience: "http-opt-out",
      action:
        "These cloud checks were skipped because this audit ran without cloud rendering (--http). Re-run without --http to include them.",
    };
  }
  if (plan === "paid") {
    return {
      ...base,
      audience: "paid-unavailable",
      action:
        "These cloud checks couldn't run this audit. The cloud service may have been temporarily unavailable, so re-run the audit to try again.",
    };
  }
  if (plan === "free") {
    return {
      ...base,
      audience: "free-upsell",
      action:
        "These cloud checks didn't run this audit (out of credits, or a quick scan). Free and Pro run the same checks: Pro just grants more monthly credits and lets you top up.",
      cta: { label: "Add credits in your dashboard", url: "https://app.squirrelscan.com" },
    };
  }
  return {
    ...base,
    audience: "anonymous-upsell",
    // No em-dashes: this action text is shared with the llm renderer, which
    // keeps agent-facing copy em-dash-free (see tests/llm-status.test.ts).
    action:
      "Cloud-powered checks (page rendering, AI content analysis, link-rot, brand protection, and more) run with a free squirrelscan account.",
    cta: { label: "Get started to unlock them", url: "https://squirrelscan.com" },
  };
}
