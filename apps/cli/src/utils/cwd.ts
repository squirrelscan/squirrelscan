// Bun 1.4 propagates the underlying getcwd(3) failure from `process.cwd()`
// (EACCES once an ancestor of the process's cwd loses +x under us); Bun 1.3
// returned a cached path and never threw. That turned a call every command
// makes on its way in — including one that only fills a debug-log field — into
// a way to abort the whole run, so callers that cannot act on the error read
// the cwd through here instead.
//
// Callers that must report the errno (findLocalSettingsPath in self/paths.ts)
// keep their own try/catch so the code survives into their Result.
export function cwdOr(fallback: string): string {
  try {
    return process.cwd();
  } catch {
    return fallback;
  }
}

// What the log field shows when the cwd can no longer be resolved. A literal
// rather than "" so a log line reads as "we could not tell" instead of "root".
export const CWD_UNAVAILABLE = "<unavailable>";
