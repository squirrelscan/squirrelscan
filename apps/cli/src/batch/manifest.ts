// The results file of a batch audit (#1231): one JSON record per line, appended as each URL finishes.
//
// A batch that dies (a crash, a reboot, a SIGKILL) leaves a manifest with complete lines and, at worst, one cut short at
// the end. Reading it back is what makes a re-run resume: the last record of a URL says whether it is done. Records are
// untrusted when read back (the file may have been edited or truncated), so a line that is not a record is counted and
// skipped, never thrown on.

import type { BatchUrl } from "./urls-file";

import { BATCH_MANIFEST_MAX_LINES } from "../constants";

/**
 * How a URL ended. The audit's own vocabulary (`completed`, `partial`, `blocked`, `unreachable`, `redirected`, `failed`) plus
 * what only a batch can say: `timeout` (the child ran past its budget), `crashed` (it died without writing a record),
 * `rejected` (the URL was refused before any audit) and `skipped-budget` (not started: the batch ran out of its budget).
 */
export type BatchStatus =
  | "completed"
  | "partial"
  | "blocked"
  | "unreachable"
  | "redirected"
  | "failed"
  | "timeout"
  | "crashed"
  | "rejected"
  | "skipped-budget";

export const BATCH_STATUSES: readonly BatchStatus[] = [
  "completed",
  "partial",
  "blocked",
  "unreachable",
  "redirected",
  "failed",
  "timeout",
  "crashed",
  "rejected",
  "skipped-budget",
];

/** One line of the results file. */
export interface BatchRecord {
  /** The record format: 1. */
  v: 1;
  url: string;
  key: string;
  status: BatchStatus;
  /** Why, when the status needs saying (a refusal reason, a timeout, an audit status reason code). */
  reason?: string;
  exitCode?: number;
  /** 1 for the first run of the URL, then one more for each retry. */
  attempt: number;
  startedAt?: string;
  durationMs?: number;
  /** The report's file, relative to the batch directory. */
  report?: string;
  score?: number;
  pages?: number;
  finalUrl?: string;
  error?: string;
  notes?: string[];
}

/** The statuses `--retry-failed` runs again: the URL did not get an audit that says anything about the site. */
const RETRYABLE: ReadonlySet<BatchStatus> = new Set([
  "failed",
  "unreachable",
  "timeout",
  "crashed",
]);

/** Whether a status is one `--retry-failed` retries. */
export const isRetryableStatus = (status: BatchStatus): boolean =>
  RETRYABLE.has(status);

const isStatus = (value: unknown): value is BatchStatus =>
  typeof value === "string" &&
  (BATCH_STATUSES as readonly string[]).includes(value);

/** One manifest line as a record, or undefined when it is not one. Fields of the wrong type are dropped, not trusted. */
function asRecord(value: unknown): BatchRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const r = value as Record<string, unknown>;
  if (
    r.v !== 1 ||
    typeof r.url !== "string" ||
    typeof r.key !== "string" ||
    !isStatus(r.status)
  )
    return undefined;
  if (
    typeof r.attempt !== "number" ||
    !Number.isInteger(r.attempt) ||
    r.attempt < 1
  )
    return undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const exitCode = num(r.exitCode);
  const durationMs = num(r.durationMs);
  const score = num(r.score);
  const pages = num(r.pages);
  const notes = Array.isArray(r.notes)
    ? r.notes.filter((n): n is string => typeof n === "string")
    : undefined;
  return {
    v: 1,
    url: r.url,
    key: r.key,
    status: r.status,
    attempt: r.attempt,
    ...(str(r.reason) !== undefined ? { reason: str(r.reason)! } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(str(r.startedAt) !== undefined ? { startedAt: str(r.startedAt)! } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(str(r.report) !== undefined ? { report: str(r.report)! } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(pages !== undefined ? { pages } : {}),
    ...(str(r.finalUrl) !== undefined ? { finalUrl: str(r.finalUrl)! } : {}),
    ...(str(r.error) !== undefined ? { error: str(r.error)! } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

/** A record as the line to append: one line of JSON, no newline inside, a newline at the end. */
export function formatRecord(record: BatchRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export interface ParsedManifest {
  records: BatchRecord[];
  /** Lines that were not a record (a line cut short by a crash, an edit, a record of another format). */
  skipped: number;
  /** The file had more than {@link BATCH_MANIFEST_MAX_LINES} lines: the first ones were read. */
  truncated: boolean;
}

/** The records of a results file. Tolerant: a bad line is counted and skipped. */
export function parseManifest(
  content: string,
  maxLines: number = BATCH_MANIFEST_MAX_LINES
): ParsedManifest {
  const records: BatchRecord[] = [];
  let skipped = 0;
  let truncated = false;
  let lines = 0;
  let start = 0;
  while (start < content.length) {
    let end = content.indexOf("\n", start);
    if (end === -1) end = content.length;
    const text = content.slice(start, end).trim();
    start = end + 1;
    if (text === "") continue;
    if (++lines > maxLines) {
      truncated = true;
      break;
    }
    try {
      const record = asRecord(JSON.parse(text));
      if (record) records.push(record);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped, truncated };
}

/** The last record of each URL, by key: the one that says where the URL stands. */
export function latestRecords(
  records: readonly BatchRecord[]
): Map<string, BatchRecord> {
  const latest = new Map<string, BatchRecord>();
  for (const record of records) {
    const prior = latest.get(record.key);
    if (!prior || record.attempt >= prior.attempt)
      latest.set(record.key, record);
  }
  return latest;
}

export interface Plan {
  /** The URLs to run, in the file's order, each with the attempt number its record will carry. */
  run: Array<{ entry: BatchUrl; attempt: number }>;
  /** URLs already done, left alone. */
  done: number;
  /** URLs whose record is a retryable failure that was left alone because retry was not asked for. */
  failedKept: number;
}

/**
 * What a re-run does. A URL with no record runs. A URL whose last record is done (including a refusal, which a retry cannot
 * change) is skipped. One that ended in a retryable failure is skipped too, unless `retryFailed`, which runs it again as
 * the next attempt. One that was not started (`skipped-budget`) runs.
 */
export function planBatch(
  urls: readonly BatchUrl[],
  records: readonly BatchRecord[],
  options: { retryFailed?: boolean } = {}
): Plan {
  const latest = latestRecords(records);
  const plan: Plan = { run: [], done: 0, failedKept: 0 };
  for (const entry of urls) {
    const record = latest.get(entry.key);
    if (!record) {
      plan.run.push({ entry, attempt: 1 });
    } else if (record.status === "skipped-budget") {
      plan.run.push({ entry, attempt: record.attempt + 1 });
    } else if (isRetryableStatus(record.status)) {
      if (options.retryFailed === true)
        plan.run.push({ entry, attempt: record.attempt + 1 });
      else plan.failedKept++;
    } else {
      plan.done++;
    }
  }
  return plan;
}
