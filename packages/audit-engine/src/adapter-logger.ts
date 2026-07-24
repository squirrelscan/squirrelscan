// Injectable adapter logger, extracted from adapter.ts so sibling modules
// (report-stream.ts) can log through the SAME instance without importing
// adapter.ts and forming a module cycle. adapter.ts re-exports `setAdapterLogger`
// + `AdapterLogger` so the package barrel is unchanged.

/** Minimal logger — configurable via setAdapterLogger() */
export interface AdapterLogger {
  trace: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  traceStart: (name: string) => string;
  traceEnd: (span: string, meta?: Record<string, unknown>) => void;
  withTrace: <T>(name: string, fn: () => T, meta?: () => Record<string, unknown>) => T;
}

const noopLogger: AdapterLogger = {
  trace: () => {},
  error: () => {},
  warn: () => {},
  traceStart: () => "",
  traceEnd: () => {},
  withTrace: (_name, fn) => fn(),
};

// Live binding: importers see reassignments made by setAdapterLogger (ESM), so a
// module that captured `logger` at import time still logs through the injected one.
export let logger: AdapterLogger = noopLogger;

export function setAdapterLogger(l: AdapterLogger): void {
  logger = l;
}
