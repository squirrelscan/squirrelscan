// The batch orchestrator behind `squirrel audit --urls-file` (#1231).
//
// Each URL is audited by a child `squirrel audit` process of the same binary: the audit command owns process globals
// (signals, the content store handle, the exit code), so a pool of children gives crash isolation, a real exit code per URL
// and a kill switch for a wedged crawl. The orchestrator is the only writer of `results.jsonl`. A re-run resumes from it.

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { availableParallelism, hostname, freemem } from "node:os";
import { join } from "node:path";

import { domainToProjectName } from "@/crawler/storage";

import { BATCH_MAX_URLS, BATCH_URLS_FILE_MAX_BYTES } from "../constants";
import { readChildRecord } from "./child-record";
import {
  type BatchRecord,
  type BatchStatus,
  formatRecord,
  isFailedStatus,
  latestRecords,
  parseManifest,
  planBatch,
} from "./manifest";
import {
  type BatchUrl,
  type UrlsFileResult,
  parseUrlsFile,
  urlKey,
} from "./urls-file";

export const BATCH_EXIT = {
  ok: 0,
  cannotRun: 1,
  gateTripped: 2,
  urlFailed: 6,
  interrupted: 130,
} as const;

const MAX_CONCURRENCY = 16;
const GRACE_MS = 10_000;
const PER_CHILD_MEMORY_BYTES = 600 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

/** Batch-only flags and whether they take a value: removed from the arguments each child gets. */
const BATCH_FLAGS: Record<string, boolean> = {
  "urls-file": true,
  "out-dir": true,
  concurrency: true,
  "url-timeout": true,
  "max-urls": true,
  "retry-failed": false,
  restart: false,
  "allow-private-hosts": false,
  "batch-record": true,
  // Per-URL outputs the orchestrator decides.
  format: true,
  f: true,
  output: true,
  o: true,
};

/** The audit arguments every child gets: the user's, minus the batch-only and output flags. */
export function passthroughArgs(rawArgs: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--") break;
    const m = /^--?([^=]+)(=.*)?$/.exec(arg);
    if (!m) continue; // a positional (the url is not given with --urls-file)
    const name = m[1]!;
    const takesValue = BATCH_FLAGS[name];
    if (takesValue === undefined) {
      out.push(arg);
      // A flag value that follows is kept with its flag (the next non-flag token).
      const next = rawArgs[i + 1];
      if (m[2] === undefined && next !== undefined && !next.startsWith("-")) {
        // Boolean flags never take a following token, but we cannot tell here: keep it, children parse it as citty does.
        out.push(next);
        i++;
      }
    } else if (takesValue && m[2] === undefined) {
      i++;
    }
  }
  return out;
}

/** The value of `--name` (or `--name=value`) in raw arguments. */
function flagValue(
  rawArgs: readonly string[],
  name: string
): string | undefined {
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === `--${name}`) return rawArgs[i + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

const hasFlag = (rawArgs: readonly string[], name: string): boolean =>
  rawArgs.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

const FORMAT_EXT: Record<string, string> = {
  json: "json",
  html: "html",
  markdown: "md",
  xml: "xml",
  llm: "xml",
};

/** A short single-line message: control characters stripped, clamped. */
export function cleanError(text: string, max = 300): string {
  const lines = text
    .split(/\r?\n/)
    // oxlint-disable-next-line no-control-regex
    .map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim())
    .filter((l) => l !== "");
  const last = lines[lines.length - 1] ?? "";
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}

/** What a finished child means: the audit's status refined by the exit code (see the exit-code table in the audit docs). */
export function statusFromExit(
  exitCode: number | null,
  record: { status: BatchStatus; reason?: string } | undefined
): { status: BatchStatus; reason?: string } {
  const reason = record?.reason;
  const withReason = (status: BatchStatus) => ({
    status,
    ...(reason !== undefined ? { reason } : {}),
  });
  if (exitCode === 5) return withReason("unreachable");
  if (exitCode === 4) return withReason("redirected");
  if (exitCode === 3) return withReason("blocked");
  if (record && record.status !== "completed" && record.status !== "partial")
    return withReason(record.status);
  if (exitCode === 0 || exitCode === 2)
    return withReason(record?.status ?? "completed");
  return withReason("failed");
}

export interface ChildResult {
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  /** The last bytes of the child's stderr. */
  stderrTail: string;
}

export interface ChildHandle {
  result: Promise<ChildResult>;
  /** Ask the child to stop (SIGTERM). */
  terminate: () => void;
  kill: () => void;
}

export type SpawnChild = (spec: {
  args: string[];
  env: Record<string, string | undefined>;
}) => ChildHandle;

/** The command that runs `squirrel audit` in this same binary (or this same script under bun in development). */
export function selfCommand(): string[] {
  const main = Bun.main;
  const compiled = main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/");
  return compiled ? [process.execPath] : [process.execPath, main];
}

export const spawnSelf: SpawnChild = ({ args, env }) => {
  const proc = Bun.spawn([...selfCommand(), ...args], {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const result = (async (): Promise<ChildResult> => {
    let tail = "";
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail = (tail + decoder.decode(value, { stream: true })).slice(
        -STDERR_TAIL_BYTES
      );
    }
    const code = await proc.exited;
    return {
      exitCode: proc.signalCode ? null : code,
      signal: proc.signalCode,
      stderrTail: tail,
    };
  })();
  return {
    result,
    terminate: () => proc.kill("SIGTERM"),
    kill: () => proc.kill("SIGKILL"),
  };
};

export interface BatchOptions {
  urlsFile: string;
  outDir: string;
  concurrency?: number;
  retryFailed?: boolean;
  restart?: boolean;
  /** Seconds; 0 or undefined = none. */
  urlTimeoutSeconds?: number;
  maxUrls?: number;
  allowPrivateHosts?: boolean;
  format?: string;
  /** The audit arguments every child gets (see {@link passthroughArgs}). */
  passthrough?: string[];
  spawn?: SpawnChild;
  /** Read for `-`. */
  readStdin?: () => Promise<string>;
  log?: (line: string) => void;
  /** Resolves when the batch should stop starting URLs and stop the children (SIGINT/SIGTERM). */
  stopSignal?: AbortSignal;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take `<out-dir>/.batch.lock`; a lock whose process is gone on this host is stale and taken over. Returns a release function. */
function acquireLock(outDir: string): (() => void) | string {
  const path = join(outDir, ".batch.lock");
  const body = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, body);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST")
        return `cannot create ${path}: ${(e as Error).message}`;
      let held: { pid?: unknown; host?: unknown } = {};
      try {
        held = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // unreadable: treated as stale below only when we cannot tell, so refuse
        return `another batch holds ${path} (unreadable lock); delete it if no batch is running`;
      }
      const stale =
        held.host === hostname() &&
        typeof held.pid === "number" &&
        !pidAlive(held.pid);
      if (!stale)
        return `another batch is running on ${outDir} (pid ${String(held.pid)} on ${String(held.host)}); lock file ${path}`;
      try {
        unlinkSync(path);
      } catch {
        // raced: retry
      }
    }
  }
  return `cannot take ${path}`;
}

function readFileCapped(
  path: string,
  maxBytes: number
): string | { error: string } {
  try {
    const fd = openSync(path, "r");
    try {
      // Sized from the open descriptor, so the file cannot change between the check and the read.
      const size = fstatSync(fd).size;
      if (size > maxBytes)
        return {
          error: `${path} is ${size} bytes, over the ${maxBytes} byte limit`,
        };
      const buf = Buffer.alloc(Math.min(size, maxBytes) + 1);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return new TextDecoder("utf-8", { fatal: false }).decode(
        buf.subarray(0, n)
      );
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return {
      error: `cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}`,
    };
  }
}

/** Run a batch. Returns the process exit code (see the exit-code table in `docs/cli/audit.mdx`). */
export async function executeBatch(opts: BatchOptions): Promise<number> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const spawn = opts.spawn ?? spawnSelf;
  const concurrency = Math.max(
    1,
    Math.min(
      MAX_CONCURRENCY,
      opts.concurrency ??
        Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)))
    )
  );
  const format = opts.format ?? "json";
  const ext = FORMAT_EXT[format] ?? "txt";
  const outDir = opts.outDir;

  // 1. The input.
  let content: string;
  if (opts.urlsFile === "-") {
    content = opts.readStdin ? await opts.readStdin() : await Bun.stdin.text();
  } else {
    const read = readFileCapped(opts.urlsFile, BATCH_URLS_FILE_MAX_BYTES);
    if (typeof read !== "string") {
      log(`Error: ${read.error}`);
      return BATCH_EXIT.cannotRun;
    }
    content = read;
  }
  const result = parseUrlsFile(content, {
    allowPrivateHosts: opts.allowPrivateHosts === true,
    maxUrls: opts.maxUrls ?? BATCH_MAX_URLS,
  });
  if (!result.ok) {
    log(
      result.reason === "too-large"
        ? `Error: the urls file is ${result.bytes} bytes, over the ${result.max} byte limit`
        : `Error: the urls file lists more than ${result.max} URLs (raise --max-urls)`
    );
    return BATCH_EXIT.cannotRun;
  }
  const parsed: Extract<UrlsFileResult, { ok: true }> = result;

  // 2. The directory and its lock.
  try {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    log(`Error: cannot create ${outDir}: ${(e as Error).message}`);
    return BATCH_EXIT.cannotRun;
  }
  const lock = acquireLock(outDir);
  if (typeof lock === "string") {
    log(`Error: ${lock}`);
    return BATCH_EXIT.cannotRun;
  }
  let manifestFd = -1;
  try {
    return await runLocked();
  } finally {
    if (manifestFd >= 0) closeSync(manifestFd);
    lock();
  }

  async function runLocked(): Promise<number> {
    const manifestPath = join(outDir, "results.jsonl");
    if (opts.restart) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        renameSync(manifestPath, join(outDir, `results.${stamp}.jsonl`));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    // One descriptor for every read and append: no path is checked and then reused.
    manifestFd = openSync(manifestPath, "a+", 0o600);
    const fd = manifestFd;
    const readManifest = (): string => {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf, 0, size, 0);
      return buf.subarray(0, n).toString("utf8");
    };
    let prior: BatchRecord[] = [];
    {
      const text = readManifest();
      const m = parseManifest(text);
      prior = m.records;
      if (m.skipped > 0)
        log(
          `Note: ${m.skipped} line(s) of results.jsonl were not records and were ignored.`
        );
      // A line cut short by a crash must end before the next record is appended.
      if (text.length > 0 && !text.endsWith("\n")) writeSync(fd, "\n");
    }
    const append = (record: BatchRecord): void => {
      writeSync(fd, formatRecord(record));
    };

    // Rejected lines get a record the first time they are seen.
    const seenKeys = new Set(prior.map((r) => r.key));
    const rejectedKeys: string[] = [];
    for (const r of parsed.rejected) {
      const key = urlKey(r.text);
      rejectedKeys.push(key);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      append({
        v: 1,
        url: r.text,
        key,
        status: "rejected",
        reason: r.reason,
        attempt: 1,
        finishedAt: new Date().toISOString(),
      });
    }

    const plan = planBatch(parsed.urls, prior, {
      retryFailed: opts.retryFailed === true,
    });
    log(
      `Batch: ${parsed.urls.length} URL(s), ${plan.run.length} to run, ${plan.done} already done` +
        (plan.failedKept > 0
          ? `, ${plan.failedKept} failed earlier (--retry-failed runs them again)`
          : "") +
        (parsed.rejectedCount > 0 ? `, ${parsed.rejectedCount} refused` : "") +
        `. Concurrency ${concurrency}, reports in ${outDir}`
    );
    const need =
      Math.min(concurrency, plan.run.length) * PER_CHILD_MEMORY_BYTES;
    if (need > freemem())
      log(
        `Warning: ${concurrency} audits at once can need about ${Math.round(need / 1048576)} MB and about ${Math.round(freemem() / 1048576)} MB is free. Lower --concurrency if the machine struggles.`
      );

    // 3. The pool.
    const queue = plan.run.slice();
    const activeProjects = new Set<string>();
    const children = new Set<ChildHandle>();
    const state = { stopping: opts.stopSignal?.aborted === true };
    const onAbort = (): void => {
      state.stopping = true;
      for (const c of children) c.terminate();
    };
    opts.stopSignal?.addEventListener("abort", onAbort);

    const projectOf = (url: string): string => domainToProjectName(url);

    const runOne = async (entry: BatchUrl, attempt: number): Promise<void> => {
      const startedAt = new Date();
      append({
        v: 1,
        url: entry.url,
        key: entry.key,
        status: "running",
        attempt,
        startedAt: startedAt.toISOString(),
      });
      const tmpReport = join(outDir, `.${entry.key}.tmp`);
      const recordFile = join(outDir, `.${entry.key}.record.json`);
      for (const f of [tmpReport, recordFile]) rmSync(f, { force: true });
      const handle = spawn({
        args: [
          "audit",
          entry.url,
          ...(opts.passthrough ?? []),
          "-f",
          format,
          "-o",
          tmpReport,
          "--batch-record",
          recordFile,
        ],
        env: {},
      });
      children.add(handle);
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      if (opts.urlTimeoutSeconds && opts.urlTimeoutSeconds > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          handle.terminate();
          killTimer = setTimeout(() => handle.kill(), GRACE_MS);
        }, opts.urlTimeoutSeconds * 1000);
      }
      let result: ChildResult;
      try {
        result = await handle.result;
      } catch (e) {
        result = {
          exitCode: null,
          stderrTail: e instanceof Error ? e.message : String(e),
        };
      } finally {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        children.delete(handle);
      }
      const finishedAt = new Date();
      const childRecord = readChildRecord(recordFile);
      rmSync(recordFile, { force: true });
      let status: BatchStatus;
      let reason: string | undefined;
      if (timedOut) {
        status = "timeout";
        reason = "url_timeout";
      } else if (result.exitCode === null) {
        status = "crashed";
        reason = state.stopping
          ? "interrupted"
          : `signal_${result.signal ?? "unknown"}`;
      } else {
        const s = statusFromExit(result.exitCode, childRecord);
        status = s.status;
        reason = s.reason;
      }
      // A report is kept for any child that wrote one, even a cut-short one.
      let report: string | undefined;
      if (existsSync(tmpReport)) {
        if (status === "timeout" || status === "crashed") {
          rmSync(tmpReport, { force: true });
        } else {
          report = `${entry.key}.${ext}`;
          renameSync(tmpReport, join(outDir, report));
        }
      }
      const error = isFailedStatus(status) ? cleanError(result.stderrTail) : "";
      append({
        v: 1,
        url: entry.url,
        key: entry.key,
        status,
        ...(reason !== undefined ? { reason } : {}),
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        attempt,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        ...(report !== undefined ? { report } : {}),
        ...(childRecord?.score !== undefined
          ? { score: childRecord.score }
          : {}),
        ...(childRecord?.pages !== undefined
          ? { pages: childRecord.pages }
          : {}),
        ...(childRecord?.finalUrl !== undefined
          ? { finalUrl: childRecord.finalUrl }
          : {}),
        ...(error !== "" ? { error } : {}),
      });
    };

    await new Promise<void>((resolve) => {
      let running = 0;
      const pump = (): void => {
        // Declared here, not in the loop: it closes over the one item it runs.
        const startNext = (next: {
          entry: BatchUrl;
          attempt: number;
        }): void => {
          const project = projectOf(next.entry.url);
          activeProjects.add(project);
          runOne(next.entry, next.attempt)
            .catch((e) =>
              log(`Error: ${next.entry.url}: ${(e as Error).message}`)
            )
            .finally(() => {
              activeProjects.delete(project);
              running--;
              pump();
            });
        };
        while (!state.stopping && running < concurrency) {
          const idx = queue.findIndex(
            (q) => !activeProjects.has(projectOf(q.entry.url))
          );
          if (idx === -1) break;
          startNext(queue.splice(idx, 1)[0]!);
          running++;
        }
        if (running === 0 && (state.stopping || queue.length === 0)) resolve();
      };
      pump();
    });
    opts.stopSignal?.removeEventListener("abort", onAbort);

    // 4. The summary and the exit code, both read from the manifest so a resumed batch agrees with a fresh one.
    const finalRecords = parseManifest(readManifest()).records;
    const latest = latestRecords(finalRecords);
    const counts = new Map<BatchStatus, number>();
    let gate = false;
    let failed = false;
    let notRun = 0;
    for (const key of [...parsed.urls.map((u) => u.key), ...rejectedKeys]) {
      const r = latest.get(key);
      if (!r) {
        notRun++;
        continue;
      }
      const status = r.status === "running" ? "crashed" : r.status;
      counts.set(status, (counts.get(status) ?? 0) + 1);
      if (
        isFailedStatus(status) ||
        status === "rejected" ||
        status === "skipped-budget"
      )
        failed = true;
      else if (r.exitCode === 2) gate = true;
    }
    const summary = [...counts].map(([s, n]) => `${n} ${s}`).join(", ");
    log(
      `Batch finished: ${summary || "nothing to run"}${notRun > 0 ? `, ${notRun} not run` : ""}. Results: ${manifestPath}`
    );
    if (state.stopping) return BATCH_EXIT.interrupted;
    if (failed || notRun > 0) return BATCH_EXIT.urlFailed;
    return gate ? BATCH_EXIT.gateTripped : BATCH_EXIT.ok;
  }
}

/** The CLI entry: validates the flags, runs the batch and sets the exit code. */
export async function runBatch(input: {
  args: Record<string, unknown>;
  rawArgs: readonly string[];
}): Promise<void> {
  const { args, rawArgs } = input;
  const fail = (message: string): void => {
    console.error(`Error: ${message}`);
    process.exitCode = BATCH_EXIT.cannotRun;
  };
  if (typeof args.url === "string" && args.url !== "")
    return fail("give either a URL or --urls-file, not both");
  const urlsFile = String(args["urls-file"] ?? "");
  if (urlsFile === "")
    return fail("--urls-file needs a file path (or - for stdin)");
  const outDir = args["out-dir"];
  if (typeof outDir !== "string" || outDir === "")
    return fail("--urls-file needs --out-dir <directory>");
  for (const [flag, present] of [
    ["-o/--output", args.output !== undefined],
    ["--resume", args.resume === true],
    ["--project-name", args["project-name"] !== undefined],
    ["--summary", args.summary === true],
  ] as const) {
    if (present)
      return fail(
        `${flag} cannot be used with --urls-file (${flag === "--resume" ? "a batch resumes on its own from results.jsonl" : "a batch writes one report per URL into --out-dir"})`
      );
  }
  const intFlag = (
    name: string,
    min: number,
    max: number
  ): number | undefined | null => {
    const v = args[name];
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const concurrency = intFlag("concurrency", 1, MAX_CONCURRENCY);
  if (concurrency === null)
    return fail(
      `--concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}`
    );
  const maxUrls = intFlag("max-urls", 1, 10_000_000);
  if (maxUrls === null)
    return fail("--max-urls must be a positive whole number");
  let urlTimeout = intFlag("url-timeout", 1, 86_400);
  if (urlTimeout === null)
    return fail("--url-timeout must be a whole number of seconds");
  if (urlTimeout === undefined) {
    const md = Number(flagValue(rawArgs, "max-duration"));
    if (Number.isFinite(md) && md > 0) urlTimeout = Math.ceil(md * 1.5 + 60);
  }
  const format = String(args.format ?? "json");
  if (!hasFlag(rawArgs, "offline")) {
    const { createCloudClientWithSource } = await import("@/tools/cloud");
    if (
      createCloudClientWithSource({ timeoutMs: 1000, maxAttempts: 1 })?.client
    )
      return fail(
        "batch audits are local only for now and you are signed in: add --offline (signed-in batches with a credit estimate and --max-credits are not available yet)"
      );
  }

  const controller = new AbortController();
  let signals = 0;
  const onSignal = (): void => {
    if (++signals > 1) process.exit(BATCH_EXIT.interrupted);
    console.error(
      "Stopping: asking the running audits to finish. Run the same command again to resume."
    );
    controller.abort();
  };
  const emitter = process as NodeJS.EventEmitter;
  emitter.on("SIGINT", onSignal);
  emitter.on("SIGTERM", onSignal);
  try {
    process.exitCode = await executeBatch({
      urlsFile,
      outDir,
      ...(concurrency !== undefined ? { concurrency } : {}),
      retryFailed: args["retry-failed"] === true,
      restart: args.restart === true,
      ...(urlTimeout !== undefined ? { urlTimeoutSeconds: urlTimeout } : {}),
      ...(maxUrls !== undefined ? { maxUrls } : {}),
      allowPrivateHosts: args["allow-private-hosts"] === true,
      format,
      passthrough: passthroughArgs(rawArgs),
      stopSignal: controller.signal,
    });
  } finally {
    emitter.off("SIGINT", onSignal);
    emitter.off("SIGTERM", onSignal);
  }
}
