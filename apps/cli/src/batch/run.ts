// The runner of a batch audit (repo#2214): one child `squirrel audit` per URL, sequential by default, one results line per
// URL appended as it finishes, so a batch that dies can be resumed with `--skip-existing`. The child is injected, so the
// runner is tested without a network.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import type { BatchRecord, BatchStatus } from "./manifest";
import type { BatchUrl, RejectedUrl } from "./urls-file";

import {
  effectiveStatus,
  formatRecord,
  isFailedStatus,
  latestRecords,
  parseManifest,
  planBatch,
} from "./manifest";
import { urlKey } from "./urls-file";

export const BATCH_MANIFEST_FILE = "results.jsonl";
export const BATCH_REPORTS_DIR = "reports";
/** Exit code of a batch in which at least one URL ended in a failure. */
export const BATCH_EXIT_FAILED = 6;

export interface ChildResult {
  /** null when the child was killed by a signal. */
  exitCode: number | null;
  timedOut: boolean;
}

export interface RunBatchOptions {
  urls: readonly BatchUrl[];
  rejected: readonly RejectedUrl[];
  outDir: string;
  skipExisting: boolean;
  retryFailed: boolean;
  /** Parallel children. Default 1. */
  concurrency: number;
  /** Pause before each start after the first one a worker makes, in ms. */
  delayMs: number;
  /** Runs one audit: `reportFile` is where the child must write its JSON report. */
  runChild: (url: string, reportFile: string) => Promise<ChildResult>;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface BatchSummary {
  total: number;
  ran: number;
  skipped: number;
  counts: Partial<Record<BatchStatus, number>>;
  averageScore?: number;
  failed: number;
  exitCode: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** The status, score and page count a finished child's report carries; absent when it wrote no readable report. */
function readReport(file: string): {
  status?: BatchStatus;
  score?: number;
  pages?: number;
  finalUrl?: string;
  reason?: string;
  groups?: string;
} {
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    const status = typeof json.status === "string" ? json.status : undefined;
    const known = [
      "completed",
      "partial",
      "blocked",
      "unreachable",
      "redirected",
      "failed",
    ];
    const health = json.score as
      | { overall?: unknown; groups?: unknown }
      | undefined;
    const score =
      typeof health?.overall === "number" ? health.overall : undefined;
    const meta = json.meta as { totalPages?: unknown } | undefined;
    const pageCount =
      typeof meta?.totalPages === "number" ? meta.totalPages : undefined;
    const groups = Array.isArray(health?.groups)
      ? (health.groups as Array<{ group?: unknown; score?: unknown }>)
          .filter(
            (g) => typeof g.group === "string" && typeof g.score === "number"
          )
          .slice(0, 12)
          .map((g) => `${g.group} ${Math.round(g.score as number)}`)
          .join(" ")
      : "";
    const reason =
      typeof json.statusReasonCode === "string"
        ? json.statusReasonCode
        : undefined;
    return {
      ...(status && known.includes(status)
        ? { status: status as BatchStatus }
        : {}),
      ...(score !== undefined ? { score } : {}),
      ...(pageCount !== undefined ? { pages: pageCount } : {}),
      ...(reason ? { reason } : {}),
      ...(groups ? { groups } : {}),
    };
  } catch {
    return {};
  }
}

const statusFromExit = (code: number): BatchStatus =>
  code === 0 || code === 2
    ? "completed"
    : code === 3
      ? "blocked"
      : code === 4
        ? "redirected"
        : code === 5
          ? "unreachable"
          : "failed";

const label = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

export async function runBatch(
  options: RunBatchOptions
): Promise<BatchSummary> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const manifestPath = join(options.outDir, BATCH_MANIFEST_FILE);
  mkdirSync(join(options.outDir, BATCH_REPORTS_DIR), { recursive: true });

  let prior: BatchRecord[] = [];
  // Read without an existsSync probe first: a missing manifest is a fresh batch.
  let content: string | undefined;
  try {
    content = readFileSync(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (content !== undefined) {
    prior = parseManifest(content).records;
    // A crash mid-write leaves a line without its newline: end it so the next record does not join it.
    if (content.length > 0 && !content.endsWith("\n"))
      appendFileSync(manifestPath, "\n");
  }
  const append = (record: BatchRecord) =>
    appendFileSync(manifestPath, formatRecord(record));

  const latest = latestRecords(prior);
  const plan = options.skipExisting
    ? planBatch(options.urls, prior, { retryFailed: options.retryFailed })
    : {
        run: options.urls.map((entry) => ({
          entry,
          attempt: (latest.get(entry.key)?.attempt ?? 0) + 1,
        })),
        done: 0,
        failedKept: 0,
      };

  for (const r of options.rejected) {
    const key = urlKey(r.text);
    if (latest.has(key)) continue;
    append({
      v: 1,
      url: r.text,
      key,
      status: "rejected",
      reason: r.reason,
      attempt: 1,
    });
  }

  const counts: Partial<Record<BatchStatus, number>> = {};
  const scores: number[] = [];
  const bump = (s: BatchStatus) => (counts[s] = (counts[s] ?? 0) + 1);
  if (options.rejected.length > 0) counts.rejected = options.rejected.length;

  // Targets left alone count with what they ended in, so the summary is of the whole list.
  for (const entry of options.urls) {
    const rec = latest.get(entry.key);
    const left = !plan.run.some((p) => p.entry.key === entry.key);
    if (left && rec) {
      bump(effectiveStatus(rec));
      if (rec.score !== undefined) scores.push(rec.score);
    }
  }
  const skipped = plan.done + plan.failedKept;
  if (skipped > 0)
    options.log(
      `Skipping ${skipped} already recorded in ${BATCH_MANIFEST_FILE}${plan.failedKept > 0 ? ` (${plan.failedKept} failed, add --retry-failed to run them again)` : ""}`
    );

  const queue = [...plan.run];
  let index = 0;
  const total = plan.run.length;
  const worker = async () => {
    let started = 0;
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      if (started++ > 0 && options.delayMs > 0) await sleep(options.delayMs);
      const n = ++index;
      const { entry, attempt } = item;
      const reportRel = `${BATCH_REPORTS_DIR}/${entry.key}.json`;
      const reportFile = join(options.outDir, reportRel);
      const startedAt = now();
      append({
        v: 1,
        url: entry.url,
        key: entry.key,
        status: "running",
        attempt,
        startedAt: new Date(startedAt).toISOString(),
      });
      let child: ChildResult;
      try {
        // A report left by an earlier run must not be read as this attempt's result when the child writes nothing.
        rmSync(reportFile, { force: true });
        child = await options.runChild(entry.url, reportFile);
      } catch (error) {
        child = { exitCode: null, timedOut: false };
        void error;
      }
      const report = readReport(reportFile);
      const status: BatchStatus = child.timedOut
        ? "timeout"
        : child.exitCode === null
          ? "crashed"
          : (report.status ?? statusFromExit(child.exitCode));
      const finishedAt = now();
      const hasReport = existsSync(reportFile);
      append({
        v: 1,
        url: entry.url,
        key: entry.key,
        status,
        attempt,
        ...(child.exitCode !== null ? { exitCode: child.exitCode } : {}),
        ...(report.reason ? { reason: report.reason } : {}),
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        ...(hasReport ? { report: reportRel } : {}),
        ...(report.score !== undefined ? { score: report.score } : {}),
        ...(report.pages !== undefined ? { pages: report.pages } : {}),
      });
      bump(status);
      if (report.score !== undefined) scores.push(report.score);
      const detail =
        report.score !== undefined
          ? `score ${Math.round(report.score)}${report.groups ? ` (${report.groups})` : ""}${report.pages !== undefined ? `, ${report.pages} pages` : ""}`
          : (report.reason ??
            (child.timedOut
              ? "timed out"
              : `exit ${child.exitCode ?? "signal"}`));
      options.log(
        `[${n}/${total}] ${label(entry.url)}  ${status}  ${detail}  (${((finishedAt - startedAt) / 1000).toFixed(1)}s)`
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(options.concurrency, total || 1)) },
      worker
    )
  );

  const failed = Object.entries(counts).reduce(
    (sum, [s, c]) => sum + (isFailedStatus(s as BatchStatus) ? (c ?? 0) : 0),
    0
  );
  const averageScore =
    scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : undefined;
  const summary: BatchSummary = {
    total: options.urls.length + options.rejected.length,
    ran: total,
    skipped,
    counts,
    ...(averageScore !== undefined ? { averageScore } : {}),
    failed,
    exitCode: failed > 0 ? BATCH_EXIT_FAILED : 0,
  };
  options.log(formatSummary(summary, options.outDir));
  return summary;
}

export function formatSummary(s: BatchSummary, outDir: string): string {
  const parts = Object.entries(s.counts)
    .filter(([, c]) => (c ?? 0) > 0)
    .map(([k, c]) => `${c} ${k}`);
  return [
    "",
    `Batch summary: ${s.total} targets, ${s.ran} audited this run, ${s.skipped} skipped`,
    `  ${parts.length > 0 ? parts.join(", ") : "nothing to run"}`,
    ...(s.averageScore !== undefined
      ? [`  average score ${s.averageScore.toFixed(1)}`]
      : []),
    `  reports and ${BATCH_MANIFEST_FILE} in ${outDir}`,
  ].join("\n");
}
