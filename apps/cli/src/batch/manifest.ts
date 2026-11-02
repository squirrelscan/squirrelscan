// The results file of a batch audit (#1231): one JSON record per line, appended as each URL finishes.
//
// A batch that dies (a crash, a reboot, a SIGKILL) leaves a manifest with complete lines and, at worst, one cut short at
// the end. Reading it back is what makes a re-run resume: the last record of a URL says whether it is done. Records are
// untrusted when read back (the file may have been edited or truncated), so a line that is not a record is counted and
// skipped, never thrown on.

import type { BatchUrl } from "./urls-file";

import {
  BATCH_MANIFEST_MAX_LINE_CHARS,
  BATCH_MANIFEST_MAX_LINES,
  BATCH_URL_MAX_LENGTH,
} from "../constants";

/**
 * How a URL ended. The audit's own vocabulary (`completed`, `partial`, `blocked`, `unreachable`, `redirected`, `failed`) plus
 * what only a batch can say: `timeout` (the child ran past its budget), `crashed` (it died without writing a record),
 * `rejected` (the URL was refused before any audit) and `skipped-budget` (not started: the batch ran out of its budget).
 * `running` is the line written when a URL starts: it is never a final answer, and one that is still the last record when
 * the file is read back means the process died, so it is read as `crashed` (see {@link effectiveStatus}).
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
  | "skipped-budget"
  | "running";

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
  "running",
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
  finishedAt?: string;
  durationMs?: number;
  /** The report's file, relative to the batch directory. */
  report?: string;
  score?: number;
  pages?: number;
  finalUrl?: string;
  error?: string;
  notes?: string[];
}

/**
 * The statuses that count as a failed URL: the batch exit code is 6 when any URL ends in one, and `--retry-failed` runs them
 * again. `blocked` and `redirected` are here (the #1231 spec): a WAF-blocked or off-site-redirected URL can succeed later.
 */
const FAILED: ReadonlySet<BatchStatus> = new Set([
  "failed",
  "unreachable",
  "timeout",
  "crashed",
  "blocked",
  "redirected",
]);

/** A record's status as the batch reads it: a `running` line that is the last one is a process that died. */
export const effectiveStatus = (record: BatchRecord): BatchStatus =>
  record.status === "running" ? "crashed" : record.status;

/** Whether a status is a failed URL (see {@link FAILED}): counted in the exit code, run again by `--retry-failed`. */
export const isFailedStatus = (status: BatchStatus): boolean =>
  FAILED.has(status === "running" ? "crashed" : status);

/** Whether a status is one `--retry-failed` retries. */
export const isRetryableStatus = isFailedStatus;

const isStatus = (value: unknown): value is BatchStatus =>
  typeof value === "string" &&
  (BATCH_STATUSES as readonly string[]).includes(value);

/** Largest attempt number believed: a tampered 1e308 would otherwise win every later record of the URL. */
const MAX_ATTEMPT = 1_000;
const MAX_TEXT = 10_000;
const MAX_NOTES = 50;
const KEY = /^[0-9a-f]{16}$/;

/** A report path inside the batch directory: relative, no `..` or `.` segment, no backslash, colon or control character. */
const isSafeReport = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 512 &&
  !value.startsWith("/") &&
  /^[\w.@+-]+(?:\/[\w.@+-]+)*$/.test(value) &&
  value.split("/").every((segment) => segment !== "." && segment !== "..");

/** One manifest line as a record, or undefined when it is not one. A field of the wrong type or range is dropped, not trusted. */
function asRecord(value: unknown): BatchRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const r = value as Record<string, unknown>;
  if (
    r.v !== 1 ||
    typeof r.url !== "string" ||
    r.url.length > BATCH_URL_MAX_LENGTH ||
    typeof r.key !== "string" ||
    !KEY.test(r.key) ||
    !isStatus(r.status)
  )
    return undefined;
  if (
    typeof r.attempt !== "number" ||
    !Number.isInteger(r.attempt) ||
    r.attempt < 1 ||
    r.attempt > MAX_ATTEMPT
  )
    return undefined;
  const num = (v: unknown, min: number, max: number): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
      ? v
      : undefined;
  const int = (v: unknown, min: number, max: number): number | undefined => {
    const n = num(v, min, max);
    return n !== undefined && Number.isInteger(n) ? n : undefined;
  };
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length <= MAX_TEXT ? v : undefined;
  const exitCode = int(r.exitCode, 0, 255);
  const durationMs = num(r.durationMs, 0, Number.MAX_SAFE_INTEGER);
  const score = num(r.score, 0, 100);
  const pages = int(r.pages, 0, 1_000_000_000);
  const report =
    typeof r.report === "string" && isSafeReport(r.report)
      ? r.report
      : undefined;
  const notes = Array.isArray(r.notes)
    ? r.notes
        .filter(
          (n): n is string => typeof n === "string" && n.length <= MAX_TEXT
        )
        .slice(0, MAX_NOTES)
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
    ...(str(r.finishedAt) !== undefined
      ? { finishedAt: str(r.finishedAt)! }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(report !== undefined ? { report } : {}),
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
    const tooLong = end - start > BATCH_MANIFEST_MAX_LINE_CHARS;
    const text = tooLong ? "x" : content.slice(start, end).trim();
    start = end + 1;
    if (text === "") continue;
    if (++lines > maxLines) {
      truncated = true;
      break;
    }
    // A line past the cap is not a record this batch wrote: skipped without being parsed or copied.
    if (tooLong) {
      skipped++;
      continue;
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
  /** URLs whose record is a failure that was left alone because retry was not asked for. */
  failedKept: number;
}

/**
 * What a re-run does. The plan is made from the urls file alone: a record counts only for a URL listed in it, under its key,
 * and only when the record's own url is that URL (a record edited to carry another URL, or a key of another URL, is not
 * the URL's record). A URL with no record runs. A URL whose last record is done (including a refusal, which a retry cannot
 * change) is skipped. One that ended in a failure (`failed`, `unreachable`, `timeout`, `crashed`, `blocked`, `redirected`, or
 * a `running` line left by a process that died) is skipped too, unless `retryFailed`, which runs it again as the next
 * attempt. One that was not started (`skipped-budget`) runs.
 */
export function planBatch(
  urls: readonly BatchUrl[],
  records: readonly BatchRecord[],
  options: { retryFailed?: boolean } = {}
): Plan {
  const listed = new Map(urls.map((entry) => [entry.key, entry.url]));
  const latest = latestRecords(
    records.filter((r) => listed.get(r.key) === r.url)
  );
  const plan: Plan = { run: [], done: 0, failedKept: 0 };
  for (const entry of urls) {
    const record = latest.get(entry.key);
    if (!record) {
      plan.run.push({ entry, attempt: 1 });
    } else if (record.status === "skipped-budget") {
      plan.run.push({ entry, attempt: record.attempt + 1 });
    } else if (isFailedStatus(record.status)) {
      if (options.retryFailed === true)
        plan.run.push({ entry, attempt: record.attempt + 1 });
      else plan.failedKept++;
    } else {
      plan.done++;
    }
  }
  return plan;
}
