// Site-level agent signals shown next to the Agents group score.
//
// ax/llms-txt, ax/markdown-response and ax/agents-md are advisory: they never
// count toward the Agents score (#1386). Without this, a reader sees a low or
// high Agents number and assumes it reflects agent support. The score covers
// the scored agent experience rules, so the three signals are listed beside it
// instead of inside it.

import type { AuditReport, ReportRuleResult } from "./types";

export const AGENTS_SCORE_MEASURES =
  "The Agents score covers the scored agent experience rules; it does not include llms.txt, Markdown response or AGENTS.md, which are shown separately as site-level signals.";

export type AgentSignalStatus = "present" | "missing" | "unchecked";

export interface AgentSignal {
  id: string;
  label: string;
  status: AgentSignalStatus;
}

interface SignalSpec {
  id: string;
  label: string;
  ruleId: string;
  /** The primary check: other checks on the rule (format, headers) say nothing about presence. */
  check: string;
}

const SIGNALS: SignalSpec[] = [
  { id: "llms-txt", label: "llms.txt", ruleId: "ax/llms-txt", check: "llms-txt-present" },
  {
    id: "markdown-response",
    label: "Markdown response",
    ruleId: "ax/markdown-response",
    check: "markdown-response",
  },
  { id: "agents-md", label: "AGENTS.md", ruleId: "ax/agents-md", check: "agents-md-present" },
];

// Reports stored before the `ai` to `ax` category rename keep the old prefix.
const canonicalRuleId = (id: string): string => (id.startsWith("ai/") ? `ax/${id.slice(3)}` : id);

function statusOf(value: unknown): AgentSignalStatus {
  if (value === "present" || value === "available") return "present";
  // spa-fallback, not-checked, refused and any unknown value: we did not learn the answer.
  return value === "absent" ? "missing" : "unchecked";
}

/**
 * Presence of the three advisory agent files. Empty when none of the rules ran
 * (quick level), so renderers print nothing rather than three "unchecked".
 */
export function getAgentSignals(
  report: Pick<AuditReport, "ruleResults">,
): AgentSignal[] {
  const byRule = new Map<string, ReportRuleResult>();
  for (const r of Object.values(report.ruleResults ?? {})) byRule.set(canonicalRuleId(r.meta.id), r);
  if (!SIGNALS.some((s) => byRule.has(s.ruleId))) return [];
  return SIGNALS.map((s) => {
    const check = byRule.get(s.ruleId)?.checks.find((c) => c.name === s.check);
    return { id: s.id, label: s.label, status: statusOf(check?.value) };
  });
}

/** One line, e.g. "Site-level signals (not scored): llms.txt present, AGENTS.md missing". */
export function agentSignalsLine(signals: AgentSignal[]): string {
  return `Site-level signals (not scored): ${signals.map((s) => `${s.label} ${s.status === "unchecked" ? "not checked" : s.status}`).join(", ")}`;
}

/** Both lines for an Agents group, or [] when the rules did not run. */
export function agentSignalLines(report: Pick<AuditReport, "ruleResults">): string[] {
  const signals = getAgentSignals(report);
  return signals.length === 0 ? [] : [AGENTS_SCORE_MEASURES, agentSignalsLine(signals)];
}
