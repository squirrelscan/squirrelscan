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
export function getAgentSignals(report: Pick<AuditReport, "ruleResults">): AgentSignal[] {
  const byRule = new Map<string, ReportRuleResult>();
  for (const r of Object.values(report.ruleResults ?? {}))
    byRule.set(canonicalRuleId(r.meta.id), r);
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

export type CitabilityStatus = "ok" | "issues" | "unchecked";

export interface CitabilitySignal {
  ruleId: string;
  label: string;
  status: CitabilityStatus;
}

// Page-level findings an answer engine weighs when deciding what to quote. Each lives in its own
// rule and category; the Agents section links to them and never re-emits the finding (repo#3882).
const CITABILITY_RULES: { ruleId: string; label: string }[] = [
  { ruleId: "eeat/content-dates", label: "dates" },
  { ruleId: "content/freshness", label: "freshness" },
  { ruleId: "content/date-agreement", label: "date agreement" },
  { ruleId: "eeat/author-byline", label: "author" },
  { ruleId: "eeat/author-expertise", label: "author expertise" },
  { ruleId: "eeat/citations", label: "citations" },
  { ruleId: "ax/answer-blocks", label: "answer blocks" },
];

/**
 * Where the report stands on each citability rule, read from the rule results that already exist.
 * Empty when none of them ran, so a quick-level report prints nothing.
 */
export function getCitabilitySignals(report: Pick<AuditReport, "ruleResults">): CitabilitySignal[] {
  const byRule = new Map<string, ReportRuleResult>();
  for (const r of Object.values(report.ruleResults ?? {}))
    byRule.set(canonicalRuleId(r.meta.id), r);
  if (!CITABILITY_RULES.some((c) => byRule.has(c.ruleId))) return [];
  return CITABILITY_RULES.map(({ ruleId, label }) => {
    const checks = byRule.get(ruleId)?.checks ?? [];
    const status: CitabilityStatus = checks.some((c) => c.status === "warn" || c.status === "fail")
      ? "issues"
      : checks.some((c) => c.status === "pass" || c.status === "info")
        ? "ok"
        : "unchecked";
    return { ruleId, label, status };
  });
}

/** One line, e.g. "Citability (not scored here, see each rule): dates ok, author issues (eeat/author-byline)". */
export function citabilityLine(signals: CitabilitySignal[]): string {
  const parts = signals.map((s) =>
    s.status === "issues"
      ? `${s.label} issues (${s.ruleId})`
      : `${s.label} ${s.status === "unchecked" ? "not checked" : "ok"}`,
  );
  return `Citability (findings stay under their own rules): ${parts.join(", ")}`;
}

/** Both lines for an Agents group, or [] when the rules did not run. */
export function agentSignalLines(report: Pick<AuditReport, "ruleResults">): string[] {
  const signals = getAgentSignals(report);
  const lines = signals.length === 0 ? [] : [AGENTS_SCORE_MEASURES, agentSignalsLine(signals)];
  const citability = getCitabilitySignals(report);
  if (citability.length > 0) lines.push(citabilityLine(citability));
  return lines;
}
