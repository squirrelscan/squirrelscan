// pub#510: a rule option of the wrong type stops `squirrel audit` before any
// request, naming the table and the key, driven through citty's real parser.
// It used to fail after the crawl with a bare zod issue list.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { runCommand } from "citty";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { audit } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

// #626: every squirrel path under one scratch dir, removed afterwards.
const scratch = isolateSquirrelHome("squirrel-rule-options").root;
const configPath = join(scratch, "squirrel.toml");
let previousConfig: string | undefined;

beforeAll(() => {
  previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
});

afterAll(() => {
  setGlobalConfigPath(previousConfig);
});

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalEnv = { ...process.env };
let requested: string[] = [];
let stderr: string[] = [];
let restoreConsole: () => void = () => {};

beforeEach(() => {
  requested = [];
  stderr = [];
  process.exitCode = 0;
  // Anonymous and offline: nothing here may reach a real API.
  delete process.env.SQUIRREL_API_TOKEN;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  // The site is a stubbed fetch keyed by name: send its hosts by name
  // rather than resolving and pinning them (repo#3430).
  process.env.SQUIRREL_NO_HOST_PINNING = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    }
  );
  restoreConsole = () => {
    log.mockRestore();
    error.mockRestore();
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(input.toString());
    return new Response("<html><body>h</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  restoreConsole();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  process.exitCode = originalExitCode ?? 0;
  process.env = { ...originalEnv };
});

async function runAudit(config: string): Promise<void> {
  writeFileSync(configPath, config);
  const rawArgs = [
    "https://example.com/",
    "-m",
    "1",
    "-C",
    "quick",
    "--offline",
    "-y",
  ];
  try {
    await runCommand(audit, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

describe("squirrel audit with a wrong-typed rule option", () => {
  test("stops before any request, naming the table and the key", async () => {
    await runAudit(`[rule_options."core/meta-title"]
min_length = "thirty"

[rule_options."performance/ttfb"]
warn_threshold = 300
`);
    expect(process.exitCode).toBe(1);
    expect(
      requested.filter((url) => new URL(url).hostname === "example.com")
    ).toEqual([]);
    const output = stderr.join("\n");
    expect(output).toContain(
      '[rule_options."core/meta-title"] min_length: Invalid input: expected number, received string'
    );
    // The table that changes nothing is a warning beside it, not a second error.
    expect(output).toContain(
      'Warning: [rule_options."performance/ttfb"]: no rule has this id'
    );
    expect(output).not.toContain('"code": "invalid_type"');
  });
});
