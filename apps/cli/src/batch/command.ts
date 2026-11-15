// `squirrel audit --urls-file` (repo#2214): reads the list, then runs each URL as a child `squirrel audit`.

import { statSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { readStdinText } from "../cli/stdin";
import { BATCH_URLS_FILE_MAX_BYTES } from "../constants";
import { runBatch, type ChildResult } from "./run";
import { parseUrlsFile } from "./urls-file";

export interface BatchArgs {
  "urls-file": string;
  "out-dir"?: string;
  "skip-existing"?: boolean;
  "retry-failed"?: boolean;
  "allow-private-hosts"?: boolean;
  "batch-delay"?: string;
  "batch-timeout"?: string;
  "batch-concurrency"?: string;
  [flag: string]: unknown;
}

/** Audit flags handed to every child: value flags, then switches. */
const VALUE_FLAGS = [
  "max-pages",
  "max-depth",
  "max-duration",
  "crawl-timeout",
  "concurrency",
  "per-host",
  "level",
  "coverage",
  "render-mode",
  "fail-on",
  "visibility",
  "probe",
  "probe-budget",
];
const SWITCHES = [
  "offline",
  "http",
  "render",
  "passive",
  "aggressive",
  "pentest",
  "no-publish",
  "follow-redirect",
  "no-follow-redirect",
  "no-classifier",
  "no-external-links",
  "no-internal-links",
  "yes",
];

/** The argv of one child: the binary (and its script, under bun), then `audit <url> -f json -o <file>` and the forwarded flags. */
export function childArgv(
  url: string,
  reportFile: string,
  args: Record<string, unknown>,
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1]
): string[] {
  const exe = basename(execPath).toLowerCase();
  const head =
    (exe === "bun" || exe === "bun.exe") && script
      ? [execPath, script]
      : [execPath];
  const forwarded: string[] = [];
  for (const flag of VALUE_FLAGS) {
    const v = args[flag];
    if (typeof v === "string" && v !== "") forwarded.push(`--${flag}`, v);
  }
  for (const flag of SWITCHES) {
    if (args[flag] === true) forwarded.push(`--${flag}`);
  }
  return [...head, "audit", url, "-f", "json", "-o", reportFile, ...forwarded];
}

function positiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${name} must be a whole number of 0 or more`);
  return n;
}

async function spawnChild(
  argv: string[],
  timeoutMs: number
): Promise<ChildResult> {
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
        }, timeoutMs)
      : undefined;
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { exitCode: timedOut || proc.signalCode ? null : code, timedOut };
}

/** Runs the batch and returns the process exit code. */
export async function runBatchCommand(args: BatchArgs): Promise<number> {
  const out = (line: string) => console.log(line);
  try {
    const source = args["urls-file"];
    const outDir = args["out-dir"] ?? "squirrel-batch";
    const concurrency = Math.max(
      1,
      positiveInt(args["batch-concurrency"], "--batch-concurrency", 1)
    );
    const delayMs = positiveInt(args["batch-delay"], "--batch-delay", 1000);
    const timeoutMs =
      positiveInt(args["batch-timeout"], "--batch-timeout", 600) * 1000;
    let text: string;
    if (source === "-") {
      text = (
        await readStdinText({
          maxBytes: BATCH_URLS_FILE_MAX_BYTES + 1,
          idleMs: 10_000,
        })
      ).text;
    } else {
      if (statSync(source).size > BATCH_URLS_FILE_MAX_BYTES)
        throw new Error(
          `${source} is over the ${BATCH_URLS_FILE_MAX_BYTES} byte limit`
        );
      text = readFileSync(source, "utf8");
    }
    const parsed = parseUrlsFile(text, {
      allowPrivateHosts: args["allow-private-hosts"] === true,
    });
    if (!parsed.ok) {
      throw new Error(
        parsed.reason === "too-large"
          ? `urls file is over the ${parsed.max} byte limit`
          : `urls file lists more than ${parsed.max} URLs`
      );
    }
    for (const r of parsed.rejected)
      console.error(`line ${r.line}: refused (${r.reason}): ${r.text}`);
    if (parsed.urls.length === 0) {
      console.error("No auditable URLs in the urls file.");
      return 1;
    }
    const summary = await runBatch({
      urls: parsed.urls,
      rejected: parsed.rejected,
      outDir,
      skipExisting: args["skip-existing"] === true,
      retryFailed: args["retry-failed"] === true,
      concurrency,
      delayMs,
      log: out,
      runChild: (url, reportFile) =>
        spawnChild(childArgv(url, reportFile, args), timeoutMs),
    });
    return summary.exitCode;
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
}
