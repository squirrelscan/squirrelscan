// The record a child `squirrel audit` leaves for its batch orchestrator (#1231): hidden `--batch-record <file>`.
//
// The child writes what only it knows (the audit status and its reason code, the score, the page count, the final URL)
// once the exit code is decided. The orchestrator adds the exit code, the signal and the timings. A child that dies
// before writing leaves no file, which the orchestrator records as `crashed`.

import { readFileSync, renameSync, writeFileSync } from "node:fs";

import type { BatchStatus } from "./manifest";

/** The audit's own statuses: the ones a child can report for itself. */
const AUDIT_STATUSES: readonly BatchStatus[] = [
  "completed",
  "partial",
  "blocked",
  "unreachable",
  "redirected",
  "failed",
];

export interface ChildRecord {
  status: BatchStatus;
  reason?: string;
  score?: number;
  pages?: number;
  finalUrl?: string;
  notes?: string[];
}

/** Write the record next to its final name, atomically. Never throws: the audit's outcome must not depend on it. */
export function writeChildRecord(path: string, record: ChildRecord): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // The orchestrator falls back to the exit code.
  }
}

/** The record a child left, read as untrusted: wrong-typed fields are dropped. Undefined when there is none. */
export function readChildRecord(path: string): ChildRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.status !== "string" ||
    !(AUDIT_STATUSES as readonly string[]).includes(r.status)
  )
    return undefined;
  const out: ChildRecord = { status: r.status as BatchStatus };
  if (typeof r.reason === "string") out.reason = r.reason.slice(0, 200);
  if (typeof r.score === "number" && r.score >= 0 && r.score <= 100)
    out.score = r.score;
  if (typeof r.pages === "number" && Number.isInteger(r.pages) && r.pages >= 0)
    out.pages = r.pages;
  if (typeof r.finalUrl === "string") out.finalUrl = r.finalUrl.slice(0, 2048);
  return out;
}
