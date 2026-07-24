import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { LogLevel } from "@/self/types";

import { LOG_MAX_STRING_LENGTH } from "@/constants";
import { getLogsPath } from "@/self/paths";

import { redactString, redactValue } from "./redact";

// Re-export redactString for backwards compatibility
export { redactString } from "./redact";

export interface LoggerOptions {
  debug: boolean;
  trace: boolean;
}

interface TraceSpan {
  label: string;
  startTime: number;
}

export type LogInterceptor = (message: string) => void;

// Log level priority (lower = more important, always logged)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const loggerState: LoggerOptions & { interceptor?: LogInterceptor } = {
  debug: false,
  trace: false,
};

// Configured log level for file output (default: error)
let configuredLogLevel: LogLevel = "error";

/**
 * Set the log level for file output.
 * Called from CLI after loading settings.
 */
export function setLogLevel(level: LogLevel): void {
  configuredLogLevel = level;
}

/**
 * Get effective log level (ENV overrides configured)
 */
function getEffectiveLogLevel(): LogLevel {
  const envLevel = process.env.SQUIRREL_LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVEL_PRIORITY) {
    return envLevel as LogLevel;
  }
  return configuredLogLevel;
}

/**
 * Check if a log level should be written to file
 */
function shouldLogToFile(level: LogLevel): boolean {
  return (
    LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[getEffectiveLogLevel()]
  );
}

const activeSpans = new Map<string, TraceSpan>();
let traceFile: import("bun").FileSink | null = null;
let debugFile: import("bun").FileSink | null = null;
let spanCounter = 0;

/**
 * Stringify a value for logging, with redaction
 */
function stringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(redactValue(value));
  } catch {
    return String(value);
  }
}

function initTraceFile(): void {
  if (traceFile) return;
  try {
    const logDir = getLogsPath();
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "trace.log");
    traceFile = Bun.file(logPath).writer();
  } catch (e) {
    console.error(`[warn] Could not init trace log: ${(e as Error).message}`);
    loggerState.trace = false;
  }
}

function initDebugFile(): void {
  try {
    const logDir = getLogsPath();
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "debug.log");
    debugFile = Bun.file(logPath).writer();
  } catch {
    // Silent fail - debug logging is best effort
  }
}

/**
 * Ensure debug file is initialized (lazy initialization)
 */
function ensureDebugFile(): void {
  if (!debugFile) {
    initDebugFile();
  }
}

/**
 * Truncate large string values in trace data to prevent slow JSON serialization
 */
function truncateTraceData(
  data: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value.length > LOG_MAX_STRING_LENGTH) {
      result[key] =
        `${value.slice(0, LOG_MAX_STRING_LENGTH)}... (${value.length} chars)`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function writeTrace(
  label: string,
  durationMs?: number,
  data?: Record<string, unknown>
): void {
  if (!loggerState.trace || !traceFile) return;
  const parts = [formatTimestamp(), "[trace]", `[${label}]`];
  if (durationMs !== undefined)
    parts.push(`duration=${durationMs.toFixed(2)}ms`);
  if (data) parts.push(JSON.stringify(truncateTraceData(data)));
  traceFile.write(parts.join(" ") + "\n");
}

/**
 * Write to log file if level is enabled (lazy initializes debug file)
 */
function writeLog(level: LogLevel, message: string): void {
  if (shouldLogToFile(level)) {
    ensureDebugFile();
    debugFile?.write(message);
  }
}

export function configureLogger(options: Partial<LoggerOptions>): void {
  if (typeof options.debug === "boolean") {
    loggerState.debug = options.debug;
  }
  if (typeof options.trace === "boolean") {
    loggerState.trace = options.trace;
    if (options.trace) {
      initTraceFile();
    }
  }
}

/**
 * Set an interceptor to capture log messages
 * Useful for CLI progress display
 */
export function setLogInterceptor(
  interceptor: LogInterceptor | undefined
): void {
  loggerState.interceptor = interceptor;
}

function formatLabel(label: string): string {
  return `[${label}]`;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatPrefix(label: string): string {
  return `${formatTimestamp()} ${formatLabel(label)}`;
}

// ── Console formatting (issue #190) ──────────────────────────────────
// File logs keep the full ISO timestamp (formatPrefix); the console gets a
// short, colored, run-relative prefix instead of the noisy ISO dump. Color is
// gated per destination stream so redirecting one (e.g. `2>err.log`) never
// leaves ANSI escapes in the file: info/debug + intercepted lines go to stdout,
// direct warn/error go to stderr.
const RUN_START = performance.now();
const COLOR_ENABLED = process.env.TERM !== "dumb" && !process.env.NO_COLOR;
const STDOUT_COLOR = COLOR_ENABLED && process.stdout.isTTY === true;
const STDERR_COLOR = COLOR_ENABLED && process.stderr.isTTY === true;

function color(code: string, text: string, on: boolean): string {
  return on ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Run-relative elapsed, e.g. "+0.4s", "+12s", "+7m32s" for long audits. */
function elapsedStamp(): string {
  const total = (performance.now() - RUN_START) / 1000;
  if (total < 10) return `+${total.toFixed(1)}s`;
  const whole = Math.round(total);
  if (whole < 60) return `+${whole}s`;
  return `+${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** Short console prefix; file output uses formatPrefix() (full ISO). `colorOn`
 * reflects the destination stream's TTY state (stdout for info/debug/intercepted
 * lines, stderr for direct warn/error). */
function consolePrefix(level: LogLevel, colorOn: boolean): string {
  const stamp = color("90", `[${elapsedStamp()}]`, colorOn); // dim gray
  switch (level) {
    case "warn":
      return `${stamp} ${color("33", "warn", colorOn)}`;
    case "error":
      return `${stamp} ${color("31", "error", colorOn)}`;
    case "debug":
      return `${stamp} ${color("2", "debug", colorOn)}`;
    default:
      return stamp; // info: just the timestamp, no noisy level tag
  }
}

function output(prefix: string, args: unknown[]): void {
  // stringify, not String: objects logged as real (redacted) JSON on the
  // console, matching the file path — String() prints "[object Object]" (#855).
  const message = [prefix, ...args.map(stringify)].join(" ");
  if (loggerState.interceptor) {
    loggerState.interceptor(message);
  } else {
    console.log(message);
  }
}

export const logger = {
  /**
   * Debug log - writes to file if log_level >= debug, console if --debug flag
   */
  debug: (...args: unknown[]): void => {
    const line = `${formatPrefix("debug")} ${args.map(stringify).join(" ")}\n`;
    writeLog("debug", line);
    if (loggerState.debug) {
      // debug routes through output() → stdout (or the interceptor, also stdout).
      output(consolePrefix("debug", STDOUT_COLOR), args);
    }
  },
  /**
   * Info log - writes to file if log_level >= info, always to console
   */
  info: (...args: unknown[]): void => {
    const line = `${formatPrefix("info")} ${args.map(stringify).join(" ")}\n`;
    writeLog("info", line);
    output(consolePrefix("info", STDOUT_COLOR), args);
  },
  /**
   * Warn log - writes to file if log_level >= warn, always to console
   */
  warn: (...args: unknown[]): void => {
    const line = `${formatPrefix("warn")} ${args.map(stringify).join(" ")}\n`;
    writeLog("warn", line);
    // Intercepted → stdout (progress); otherwise console.warn → stderr.
    const colorOn = loggerState.interceptor ? STDOUT_COLOR : STDERR_COLOR;
    const message = [
      consolePrefix("warn", colorOn),
      ...args.map(stringify),
    ].join(" ");
    if (loggerState.interceptor) {
      loggerState.interceptor(message);
    } else {
      console.warn(message);
    }
  },
  /**
   * Error log - always writes to file (error is always enabled), always to console
   */
  error: (...args: unknown[]): void => {
    const line = `${formatPrefix("error")} ${args.map(stringify).join(" ")}\n`;
    writeLog("error", line);
    // Intercepted → stdout (progress); otherwise console.error → stderr.
    const colorOn = loggerState.interceptor ? STDOUT_COLOR : STDERR_COLOR;
    const message = [
      consolePrefix("error", colorOn),
      ...args.map(stringify),
    ].join(" ");
    if (loggerState.interceptor) {
      loggerState.interceptor(message);
    } else {
      console.error(message);
    }
  },
  /** Write a trace entry without timing (instant event) */
  trace: (label: string, data?: Record<string, unknown>): void => {
    writeTrace(label, undefined, data);
  },
  /**
   * Start a timed trace span. Returns a spanId to pass to traceEnd().
   * Returns empty string if tracing is disabled.
   * Prefer withTrace/withTraceAsync for exception-safe tracing.
   */
  traceStart: (label: string): string => {
    if (!loggerState.trace) return "";
    const spanId = `span_${++spanCounter}`;
    activeSpans.set(spanId, { label, startTime: performance.now() });
    return spanId;
  },
  /**
   * End a timed trace span started with traceStart().
   * No-op if spanId is empty or invalid.
   */
  traceEnd: (spanId: string, data?: Record<string, unknown>): void => {
    if (!spanId) return;
    const span = activeSpans.get(spanId);
    if (!span) return;
    activeSpans.delete(spanId);
    const duration = performance.now() - span.startTime;
    writeTrace(span.label, duration, data);
  },
  /** Flush trace and debug buffers to disk. Call before process exit. */
  flush: async (): Promise<void> => {
    await Promise.all([traceFile?.flush(), debugFile?.flush()]);
  },
  /** @deprecated Use flush() instead */
  flushTrace: async (): Promise<void> => {
    await traceFile?.flush();
  },
  /**
   * Execute a synchronous function with automatic trace timing.
   * Guarantees span cleanup even if fn throws.
   * @param label - Trace label for the span
   * @param fn - Function to execute and time
   * @param getData - Optional function to generate trace data after fn completes
   */
  withTrace: <T>(
    label: string,
    fn: () => T,
    getData?: () => Record<string, unknown>
  ): T => {
    if (!loggerState.trace) return fn();
    const spanId = logger.traceStart(label);
    try {
      return fn();
    } finally {
      logger.traceEnd(spanId, getData?.());
    }
  },
  /**
   * Execute an async function with automatic trace timing.
   * Guarantees span cleanup even if fn throws.
   * @param label - Trace label for the span
   * @param fn - Async function to execute and time
   * @param getData - Optional function to generate trace data after fn completes
   */
  withTraceAsync: async <T>(
    label: string,
    fn: () => Promise<T>,
    getData?: () => Record<string, unknown>
  ): Promise<T> => {
    if (!loggerState.trace) return fn();
    const spanId = logger.traceStart(label);
    try {
      return await fn();
    } finally {
      logger.traceEnd(spanId, getData?.());
    }
  },
  /**
   * Log command start with args - uses info level for file output
   */
  commandStart: (name: string, args: Record<string, unknown>): void => {
    const line = `${formatPrefix("info")} ========== COMMAND START: ${name} ==========\n`;
    writeLog("info", line);
    if (loggerState.debug) {
      console.log(
        consolePrefix("info", STDOUT_COLOR),
        `========== COMMAND START: ${name} ==========`
      );
    }
    // Log args at info level too
    const argsLine = `${formatPrefix("info")} args ${stringify(args)}\n`;
    writeLog("info", argsLine);
    if (loggerState.debug) {
      console.log(consolePrefix("info", STDOUT_COLOR), "args", args);
    }
  },
  /**
   * Log command end with result and duration - uses info level for file output
   */
  commandEnd: (
    name: string,
    result: "success" | "error",
    durationMs?: number
  ): void => {
    const duration =
      durationMs !== undefined ? `, ${durationMs.toFixed(0)}ms` : "";
    const line = `${formatPrefix("info")} ========== COMMAND END: ${name} (${result}${duration}) ==========\n`;
    writeLog("info", line);
    if (loggerState.debug) {
      console.log(
        consolePrefix("info", STDOUT_COLOR),
        `========== COMMAND END: ${name} (${result}${duration}) ==========`
      );
    }
  },
};
