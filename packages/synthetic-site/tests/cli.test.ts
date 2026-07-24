// CLI-level regression: an invalid numeric flag must surface as a clean
// one-line error + exit 1, not an unhandled top-level throw with a raw stack
// trace. Regression for a bug where main().catch() didn't cover option
// parsing/validation, which ran at module top level before main() existed.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", CLI_PATH, ...args]);
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("cli.ts error handling", () => {
  test("an invalid --pages value exits 1 with a clean message, no stack trace", () => {
    const result = runCli(["--pages", "abc"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Expected a finite number, got "abc"');
    // A raw thrown-error dump includes "at <function> (<file>:<line>:<col>)"
    // frames; a caught-and-printed error message does not.
    expect(result.stderr).not.toContain(" at ");
  });

  test("an invalid --clean-ratio value exits 1 cleanly", () => {
    const result = runCli(["--pages", "10", "--clean-ratio", "Infinity"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Expected a finite number, got "Infinity"');
    expect(result.stderr).not.toContain(" at ");
  });

  test("a valid invocation still runs and prints the issue summary", () => {
    const result = runCli(["--pages", "10", "--seed", "cli-smoke"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Generated");
    expect(result.stdout).toContain('seed="cli-smoke"');
  });
});
