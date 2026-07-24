// CI/agent gating: turn audit results into a build-failing exit code.
//
// `squirrel audit <url> --fail-on score<90 --fail-on severity>=error`
// exits 2 when ANY threshold trips (distinct from 1 = operational error,
// 0 = passed). Grammar is intentionally tiny: `<metric><op><value>`.

import type { AuditReport } from "@/types";

import { RULE_CATEGORY_VALUES } from "@/rules/categories";

export type FailOnOp = "<" | "<=" | ">" | ">=" | "=";

type SeverityName = "error" | "warning" | "info";
const SEVERITY_RANK: Record<SeverityName, number> = {
  info: 1,
  warning: 2,
  error: 3,
};

// Two-char operators first so "<=" wins over "<".
const OPS: FailOnOp[] = ["<=", ">=", "<", ">", "="];

export interface FailOnCondition {
  /** The expression exactly as the user typed it (for messages). */
  raw: string;
  metric: "score" | "category-score" | "errors" | "warnings" | "severity";
  /** Present when `metric === "category-score"`. */
  category?: string;
  op: FailOnOp;
  /** Numeric threshold. For `severity` this is the rank of `severityName`. */
  value: number;
  /** Present when `metric === "severity"`. */
  severityName?: SeverityName;
}

export interface FailOnParseResult {
  conditions: FailOnCondition[];
  errors: string[];
}

export interface FailOnTrip {
  condition: FailOnCondition;
  /** Human-readable actual value, e.g. "82" or "3 error / 1 warning". */
  actual: string;
}

export interface FailOnEvaluation {
  /** Total conditions evaluated (for the "all passed" summary). */
  total: number;
  trips: FailOnTrip[];
  /** Conditions that could not be evaluated (data absent this run). */
  notes: string[];
}

/** Split repeated and/or comma-joined flag values into trimmed specs. */
export function normalizeFailOnArgs(
  value: string | string[] | undefined
): string[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseFailOn(specs: string[]): FailOnParseResult {
  const conditions: FailOnCondition[] = [];
  const errors: string[] = [];
  for (const raw of specs) {
    const parsed = parseOne(raw);
    if (typeof parsed === "string") errors.push(parsed);
    else conditions.push(parsed);
  }
  return { conditions, errors };
}

function parseOne(raw: string): FailOnCondition | string {
  // Pick the LEFTMOST operator; OPS is ordered two-char-first so "<=" wins over
  // "<" at the same index (strict `<` rejects the equal-index single-char).
  let op: FailOnOp | undefined;
  let opIdx = Infinity;
  for (const candidate of OPS) {
    const idx = raw.indexOf(candidate);
    if (idx !== -1 && idx < opIdx) {
      op = candidate;
      opIdx = idx;
    }
  }
  if (!op || opIdx <= 0) {
    return `--fail-on "${raw}": expected <metric><op><value>, e.g. score<90 or severity>=error`;
  }

  const lhs = raw.slice(0, opIdx).trim().toLowerCase();
  let rhs = raw
    .slice(opIdx + op.length)
    .trim()
    .toLowerCase();
  // Tolerate "==" written as "=" + leading "=".
  if (op === "=" && rhs.startsWith("=")) rhs = rhs.slice(1).trim();

  if (rhs === "") {
    return `--fail-on "${raw}": missing value after "${op}"`;
  }

  let metric: FailOnCondition["metric"];
  let category: string | undefined;

  if (lhs === "score") {
    metric = "score";
  } else if (lhs.startsWith("score:")) {
    metric = "category-score";
    category = lhs.slice("score:".length);
    if (!(RULE_CATEGORY_VALUES as readonly string[]).includes(category)) {
      return `--fail-on "${raw}": unknown category "${category}". Valid: ${RULE_CATEGORY_VALUES.join(", ")}`;
    }
  } else if (lhs === "errors") {
    metric = "errors";
  } else if (lhs === "warnings") {
    metric = "warnings";
  } else if (lhs === "severity") {
    metric = "severity";
  } else if (lhs === "new-issues" || lhs === "new") {
    return `--fail-on "${raw}": new-issues gating is not supported yet (needs a baseline) — see #167`;
  } else {
    return `--fail-on "${raw}": unknown metric "${lhs}". Use score, score:<category>, errors, warnings, or severity`;
  }

  if (metric === "severity") {
    if (op === "<" || op === "<=") {
      return `--fail-on "${raw}": severity supports >=, >, = (e.g. severity>=error), not "${op}"`;
    }
    // Only error/warning are gateable — info findings are not counted in the
    // report's severity tallies, so `severity=info` could never trip.
    if (rhs !== "error" && rhs !== "warning") {
      return `--fail-on "${raw}": severity value must be error or warning (info findings are not counted for gating)`;
    }
    // `>error` can never trip — error is the highest rank; reject the no-op.
    if (op === ">" && rhs === "error") {
      return `--fail-on "${raw}": severity>error can never trip — error is the highest severity. Did you mean severity>=error?`;
    }
    const severityName = rhs as SeverityName;
    return {
      raw,
      metric,
      op,
      value: SEVERITY_RANK[severityName],
      severityName,
    };
  }

  const n = Number(rhs);
  if (!Number.isFinite(n)) {
    return `--fail-on "${raw}": "${rhs}" is not a number`;
  }
  return { raw, metric, category, op, value: n };
}

function compare(actual: number, op: FailOnOp, threshold: number): boolean {
  switch (op) {
    case "<":
      return actual < threshold;
    case "<=":
      return actual <= threshold;
    case ">":
      return actual > threshold;
    case ">=":
      return actual >= threshold;
    case "=":
      // Scores and finding counts are integers, so strict equality is safe.
      return actual === threshold;
    default:
      throw new Error(`unexpected fail-on operator: ${op as string}`);
  }
}

/** Scores are 0–100; a threshold outside that range is almost certainly a typo
 * (e.g. `score<110` always trips, `score>200` never does). Allow it, but note. */
function noteIfScoreOutOfRange(c: FailOnCondition, notes: string[]): void {
  if (c.value < 0 || c.value > 100) {
    notes.push(
      `${c.raw}: threshold ${c.value} is outside the 0–100 score range — likely a mistake`
    );
  }
}

export function evaluateFailOn(
  conditions: FailOnCondition[],
  report: AuditReport
): FailOnEvaluation {
  const trips: FailOnTrip[] = [];
  const notes: string[] = [];

  // Failed/blocked audit (#489/#586): no real results, and healthScore.overall is
  // null (N/A), so a `score<N` gate has nothing to compare on an unreachable site.
  // Skip all conditions — the failed audit itself is the signal, not a gate trip.
  if (report.status === "failed" || report.status === "blocked") {
    notes.push(
      `audit ${report.status} — fail-on conditions skipped (no audit data)`
    );
    return { total: conditions.length, trips, notes };
  }

  // `failed`/`warnings` are non-optional on AuditReport, so they're the final
  // fallback when the optional healthScore is absent (no extra `?? 0` needed).
  const errorCount = report.healthScore?.errorCount ?? report.failed;
  const warningCount = report.healthScore?.warningCount ?? report.warnings;
  // Findings present at a given severity rank. Info (rank 1) is never counted —
  // it isn't tracked in the report tallies — so severity gating only sees 3/2.
  const countAtRank = (rank: number): number =>
    rank === SEVERITY_RANK.error
      ? errorCount
      : rank === SEVERITY_RANK.warning
        ? warningCount
        : 0;

  for (const c of conditions) {
    switch (c.metric) {
      case "score": {
        noteIfScoreOutOfRange(c, notes);
        const overall = report.healthScore?.overall;
        if (overall == null) {
          notes.push(`${c.raw}: no health score this run — skipped`);
          break;
        }
        if (compare(overall, c.op, c.value)) {
          trips.push({ condition: c, actual: `score ${overall}` });
        }
        break;
      }
      case "category-score": {
        noteIfScoreOutOfRange(c, notes);
        const cat = report.healthScore?.categories.find(
          (x) => x.category === c.category
        );
        if (!cat) {
          notes.push(
            `${c.raw}: category "${c.category}" not present this run — skipped`
          );
          break;
        }
        if (compare(cat.score, c.op, c.value)) {
          trips.push({
            condition: c,
            actual: `${c.category} score ${cat.score}`,
          });
        }
        break;
      }
      case "errors": {
        if (compare(errorCount, c.op, c.value)) {
          trips.push({
            condition: c,
            actual: `${errorCount} error-severity findings`,
          });
        }
        break;
      }
      case "warnings": {
        if (compare(warningCount, c.op, c.value)) {
          trips.push({
            condition: c,
            actual: `${warningCount} warning-severity findings`,
          });
        }
        break;
      }
      case "severity": {
        // Only error (3) and warning (2) are countable ranks (info is never
        // tracked, so it's excluded here rather than always evaluating to 0).
        let tripped: boolean;
        if (c.op === ">=") {
          tripped = [3, 2].some((r) => r >= c.value && countAtRank(r) > 0);
        } else if (c.op === ">") {
          tripped = [3, 2].some((r) => r > c.value && countAtRank(r) > 0);
        } else {
          tripped = countAtRank(c.value) > 0;
        }
        if (tripped) {
          trips.push({
            condition: c,
            actual: `${errorCount} error / ${warningCount} warning findings`,
          });
        }
        break;
      }
    }
  }

  return { total: conditions.length, trips, notes };
}

/** Render the gate result as lines for the report output stream. */
export function formatFailOnSummary(ev: FailOnEvaluation): string[] {
  const lines: string[] = [];
  for (const note of ev.notes) lines.push(`⚠ fail-on: ${note}`);
  if (ev.trips.length === 0) {
    lines.push(
      `✓ fail-on: all ${ev.total} threshold${ev.total === 1 ? "" : "s"} passed`
    );
  } else {
    lines.push(
      `✗ fail-on: ${ev.trips.length} of ${ev.total} threshold${ev.total === 1 ? "" : "s"} tripped (exit 2):`
    );
    for (const t of ev.trips) {
      lines.push(`  • ${t.condition.raw}  (actual: ${t.actual})`);
    }
  }
  return lines;
}
