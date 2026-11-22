// Crash reporting for the CLI and the MCP server (repo#705, phase 3).
//
// An uncaught exception or unhandled rejection prints a friendly message with
// a `cli_<id>` reference, sends one crash event through our own API (never a
// third-party DSN: the API forwards it to error tracking server-side), and
// exits non-zero. The event respects every telemetry opt-out and --offline.
//
// Kept light on purpose: this module is installed on every invocation,
// including the light path (`--version`, `mcp`), so the telemetry graph is
// imported only once a crash actually happens.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

/** Crash events must fit the API's 16 KB anonymous body cap with room to spare. */
export const CRASH_STACK_MAX_BYTES = 8 * 1024;
const MAX_FRAMES = 50;
const MAX_FRAME_CHARS = 300;
/** How long a crash waits for its report before exiting anyway. */
const CRASH_SEND_TIMEOUT_MS = 2_000;

const REPO_ISSUES_URL = "https://github.com/squirrelscan/squirrelscan/issues";

export type CrashSource =
  | "uncaught_exception"
  | "unhandled_rejection"
  | "command"
  | "mcp_tool";

export interface CrashReport {
  /** `cli_` plus 12 hex characters: what the user quotes to support. */
  reference: string;
  /** The error's class name, never its message. */
  error_type: string;
  /** Stack frames only (no message line): function, file name and line:col; URLs, emails and directories removed. */
  stack?: string;
  /** The subcommand name (`audit`, `mcp`), never its arguments. */
  command?: string;
  /** `${platform}-${arch}`, e.g. `darwin-arm64`. */
  platform: string;
  source: CrashSource;
}

export function newCrashReference(): string {
  return `cli_${randomBytes(6).toString("hex")}`;
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return (error.name || error.constructor?.name || "Error").slice(0, 128);
  }
  // A rejection with a non-Error value: report its type, never its content.
  return `NonError:${error === null ? "null" : typeof error}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reduce a stack to code locations: the message line(s) are dropped (an error
 * message can carry a URL, a path or page content), and what remains is
 * scrubbed of URLs, emails and directories, then capped.
 */
export function scrubStack(
  stack: string | undefined,
  home: string = homedir()
): string | undefined {
  if (!stack) return undefined;
  const homePattern =
    home && home.length > 1 ? new RegExp(escapeRegExp(home), "g") : null;
  const frames: string[] = [];
  let bytes = 0;
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    let frame = line
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, "<url>")
      .replace(/[^\s@()]+@[^\s@()]+\.[a-z]{2,}/gi, "<email>");
    if (homePattern) frame = frame.replace(homePattern, "~");
    // Directories go too: only the file name and line:col are kept, which is
    // all a release sourcemap needs and never names a local path.
    frame = frame.replace(/[^\s()]*[\\/]/g, "");
    frame = frame.slice(0, MAX_FRAME_CHARS);
    if (bytes + frame.length + 1 > CRASH_STACK_MAX_BYTES) break;
    frames.push(frame);
    bytes += frame.length + 1;
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.length > 0 ? frames.join("\n") : undefined;
}

const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The subcommand name from argv, when it looks like one: never a URL or a path. */
export function commandFromArgs(args: string[]): string | undefined {
  const first = args.find((a) => !a.startsWith("-"));
  return first && COMMAND_PATTERN.test(first) ? first : undefined;
}

export function buildCrashReport(
  error: unknown,
  options: {
    reference: string;
    source: CrashSource;
    args?: string[];
    home?: string;
  }
): CrashReport {
  const stack =
    error instanceof Error ? scrubStack(error.stack, options.home) : undefined;
  const command = commandFromArgs(options.args ?? process.argv.slice(2));
  return {
    reference: options.reference,
    error_type: errorName(error),
    ...(stack && { stack }),
    ...(command && { command }),
    platform: `${process.platform}-${process.arch}`,
    source: options.source,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function debugEnabled(): boolean {
  const level = process.env.SQUIRREL_LOG_LEVEL?.toLowerCase();
  return level === "debug" || Boolean(process.env.SQUIRREL_DEBUG);
}

/**
 * The friendly crash message. stderr only: in `squirrel mcp` stdout is the
 * JSON-RPC channel. The message stays local; it is never sent.
 */
export function formatCrashMessage(error: unknown, reference: string): string {
  const lines = [
    "",
    `✗ squirrel hit an unexpected error: ${errorMessage(error)}`,
    `  Reference: ${reference}`,
    `  This is a bug in squirrel, not in your site. If it keeps happening, open an issue at ${REPO_ISSUES_URL} and quote the reference.`,
  ];
  if (debugEnabled() && error instanceof Error && error.stack) {
    lines.push("", error.stack);
  } else {
    lines.push("  Run with SQUIRREL_LOG_LEVEL=debug to print the stack trace.");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Send one crash report through the API. Lazy-imports telemetry so the light
 * path never pays for it. Never throws; resolves after the send settles.
 */
export async function reportCrash(
  error: unknown,
  options: { reference: string; source: CrashSource; args?: string[] }
): Promise<void> {
  try {
    const args = options.args ?? process.argv.slice(2);
    // --offline promises zero network, crashes included.
    if (args.includes("--offline")) return;
    const { sendCrashReport } = await import("./telemetry");
    await sendCrashReport(buildCrashReport(error, { ...options, args }));
  } catch {
    // A crash report must never turn into a second crash.
  }
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Not unref'd: the timer must hold the process open while the report is
    // in flight, or an emptied event loop would exit 0 before process.exit(1).
    const timer = setTimeout(resolve, ms);
    promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let crashing = false;

/**
 * Print the friendly message, report, and exit 1. A second crash while the
 * first is being reported exits straight away.
 */
export async function handleFatalError(
  error: unknown,
  source: CrashSource
): Promise<never> {
  if (crashing) process.exit(1);
  crashing = true;
  const reference = newCrashReference();
  try {
    process.stderr.write(formatCrashMessage(error, reference));
  } catch {
    // stderr closed: still report and exit.
  }
  await withTimeout(
    reportCrash(error, { reference, source }),
    CRASH_SEND_TIMEOUT_MS
  );
  process.exit(1);
}

let installed = false;

/** Install the process-wide handlers once. Safe to call more than once. */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (error) => {
    void handleFatalError(error, "uncaught_exception");
  });
  process.on("unhandledRejection", (reason) => {
    void handleFatalError(reason, "unhandled_rejection");
  });
}
