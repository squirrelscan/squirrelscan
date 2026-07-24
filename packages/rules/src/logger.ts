// Logger shim for rules package — CLI injects rich logger at runtime
// These no-op stubs are used when rules run outside the CLI context

// Set SQUIRREL_RULE_PROFILE=1 to emit per-rule timings to stderr (used when
// profiling the rules phase, e.g. via apps/cli/scripts/bench-audit.ts).
const profileRules = !!process.env.SQUIRREL_RULE_PROFILE;

export const logger = {
  debug: (category: string, data?: Record<string, unknown>) => {
    if (profileRules && category === "rule") {
      console.error(`[rule-profile] ${JSON.stringify(data)}`);
    }
  },
  trace: (_message: string, _data?: Record<string, unknown>) => {},
  warn: (_message: string, _data?: Record<string, unknown>) => {},
  error: (_message: string, ..._args: unknown[]) => {},
  withTrace: <T>(_name: string, fn: () => T, _meta?: () => Record<string, unknown>): T => fn(),
  withTraceAsync: async <T>(_name: string, fn: () => Promise<T>, _meta?: () => Record<string, unknown>): Promise<T> => fn(),
  traceStart: (_name: string): string => "",
  traceEnd: (_spanId: string, _data?: Record<string, unknown>) => {},
};
