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
  LockedRuleReason,
} from "@squirrelscan/core-contracts";
import { isAuditFailed, isLockedRuleReason } from "@squirrelscan/core-contracts";

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
  /**
   * Present only when at least one rule carries a reason (#1734): the rules by
   * cause, each with the sentence that matches it. `action` is then those
   * sentences joined, so a renderer that prints `action` alone is still right.
   */
  groups?: LockedRulesGroup[];
}

/** The rules locked for one reason; `reason` is absent for rules from a publisher that sent none. */
export interface LockedRulesGroup {
  reason?: LockedRuleReason;
  count: number;
  /** One sentence, plain text, no links. */
  text: string;
  rules: LockedRule[];
}

/** Longest `detail` shown: it is publisher-supplied free text. */
const MAX_DETAIL_CHARS = 200;

/** A rule's reason when it is one of the closed set; anything else reads as no reason. */
export function lockedRuleReason(rule: LockedRule): LockedRuleReason | undefined {
  return isLockedRuleReason(rule.reason) ? rule.reason : undefined;
}

/**
 * Publisher-supplied text as one plain line: control characters (an ANSI escape in a terminal
 * report, a NUL, a line break) become spaces. Markup is NOT touched here: each renderer escapes
 * for its own format, since this text is shared by the text, markdown, HTML, XML and JSON outputs.
 */
function plainLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A rule's detail as one short line, or undefined. */
export function lockedRuleDetail(rule: LockedRule): string | undefined {
  if (typeof rule.detail !== "string") return undefined;
  const line = plainLine(rule.detail);
  if (!line) return undefined;
  return line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS - 1)}…` : line;
}

/** A locked rule as every renderer lists it: reason only when it is in the closed set, detail as one short line. */
export function lockedRuleView(rule: LockedRule): {
  id: string;
  name: string;
  reason?: LockedRuleReason;
  detail?: string;
} {
  const reason = lockedRuleReason(rule);
  const detail = lockedRuleDetail(rule);
  return {
    id: plainLine(String(rule.id)),
    name: plainLine(String(rule.name)),
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** Short label for a reason, for a list beside a rule. */
export const LOCKED_REASON_LABELS: Record<LockedRuleReason, string> = {
  plan: "not in your plan",
  credits: "out of credits, add credits and re-run",
  provider_error: "a service failed, a re-run may help",
  unsupported_environment: "cannot run in this environment",
};

const PLAN_NAMES: Record<CloudPlanTier, string> = {
  anonymous: "a signed-out audit (no account)",
  free: "the Free plan",
  paid: "your plan",
};

const UNSUPPORTED_DEFAULT =
  "They run in a cloud audit, or from the squirrel CLI on a machine with direct network access.";

/** The sentence for one group of rules locked for the same reason. */
function groupText(
  reason: LockedRuleReason | undefined,
  rules: LockedRule[],
  plan: CloudPlanTier,
  legacyAction: string,
): string {
  const n = rules.length;
  const these = n === 1 ? "This check" : `These ${n} checks`;
  const details = [...new Set(rules.map(lockedRuleDetail).filter((d): d is string => !!d))];
  const detail = details.length > 0 ? ` ${details.map((d) => (/[.!?]$/.test(d) ? d : `${d}.`)).join(" ")}` : "";
  if (reason === "plan") return `${these} ${n === 1 ? "is" : "are"} not included in ${PLAN_NAMES[plan]}.${detail}`;
  if (reason === "credits") {
    return `${these} did not run because the audit ran out of credits. Add credits, then re-run the audit to include ${n === 1 ? "it" : "them"}.${detail}`;
  }
  if (reason === "provider_error") {
    return `${these} did not run because a service ${n === 1 ? "it" : "they"} depend${n === 1 ? "s" : ""} on failed during this audit. Re-running the audit may include ${n === 1 ? "it" : "them"}.${detail}`;
  }
  if (reason === "unsupported_environment") {
    return `${these} can't run in the environment this audit ran in.${detail || ` ${UNSUPPORTED_DEFAULT}`}`;
  }
  return legacyAction;
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
 *
 * Rules that carry a reason (#1734) are grouped by it and each group gets the
 * sentence for its cause, so a plan exclusion, a provider failure and an
 * unsupported environment never read alike. Rules with no reason (an older
 * publisher) keep the audience wording unchanged, and a failed audit keeps its
 * own message: nothing ran, whatever the reasons say.
 */
export function lockedRulesMessage(report: LockedRulesReportShape): LockedRulesMessage | null {
  const legacy = audienceMessage(report);
  const locked = report.lockedRules;
  if (!legacy || !locked || legacy.audience === "audit-failed") return legacy;
  if (!locked.some((r) => lockedRuleReason(r))) return legacy;

  const plan = report.cloudPlan ?? "anonymous";
  const order: Array<LockedRuleReason | undefined> = [
    "plan",
    "credits",
    "provider_error",
    "unsupported_environment",
    undefined,
  ];
  const groups: LockedRulesGroup[] = [];
  for (const reason of order) {
    const rules = locked.filter((r) => lockedRuleReason(r) === reason);
    if (rules.length === 0) continue;
    groups.push({
      ...(reason ? { reason } : {}),
      count: rules.length,
      text: groupText(reason, rules, plan, legacy.action),
      rules,
    });
  }
  // The upsell link (add credits, or get started) only goes with a plan exclusion, an audit out of credits, or
  // a rule with no reason.
  const upsell = groups.some(
    (g) => g.reason === undefined || g.reason === "plan" || g.reason === "credits",
  );
  const { cta: _cta, ...rest } = legacy;
  return {
    ...rest,
    action: groups.map((g) => g.text).join(" "),
    groups,
    ...(upsell && legacy.cta ? { cta: legacy.cta } : {}),
  };
}

function audienceMessage(report: LockedRulesReportShape): LockedRulesMessage | null {
  const locked = report.lockedRules;
  if (!locked || locked.length === 0) return null;

  const plan = report.cloudPlan ?? "anonymous";
  const signedIn = plan === "free" || plan === "paid";
  const optedOut = report.cloudMode === "http";
  const isQuick = report.coverageMode === "quick";
  const auditFailed = isAuditFailed(report.status);
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
        "This was a quick audit: the quick level skips the cloud checks. Re-run at the surface or full level (--level surface or --level full) to include them.",
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
