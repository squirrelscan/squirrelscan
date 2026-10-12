// pub#510: `squirrel config validate` checks `[rule_options]`, and checks the
// file `--config-file` names, which is the file `squirrel audit` reads.
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "@/cli/commands/config";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "squirrel-config-validate-"));
let previousConfig: string | undefined;
const originalExit = process.exit;
let stdout: string[] = [];
let stderr: string[] = [];
let exitCode: number | null = null;
let restoreConsole: () => void = () => {};

beforeAll(() => {
  previousConfig = getGlobalConfigPath();
});

afterAll(() => {
  setGlobalConfigPath(previousConfig);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  stdout = [];
  stderr = [];
  exitCode = null;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  });
  const error = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    }
  );
  restoreConsole = () => {
    log.mockRestore();
    error.mockRestore();
  };
});

afterEach(() => {
  restoreConsole();
  process.exit = originalExit;
});

/** `squirrel --config-file <file> config validate`. */
async function validate(toml: string): Promise<void> {
  const file = join(dir, "squirrel.toml");
  writeFileSync(file, toml);
  setGlobalConfigPath(file);
  try {
    await runCommand(config, { rawArgs: ["validate"] });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    exitCode = err.code;
  }
}

describe("squirrel config validate", () => {
  test("reports each rule option problem, naming the table and the key, and exits 1", async () => {
    await validate(`[rule_options."core/meta-title"]
min_length = "thirty"

[rule_options."performance/ttfb"]
warn_threshold = 300

[rule_options."core/meta-description"]
no_such_option = 5
`);
    expect(exitCode).toBe(1);
    expect(stdout.join("\n")).not.toContain("Config valid");
    expect(stderr).toEqual([
      'Invalid config: [rule_options."core/meta-title"] min_length: Invalid input: expected number, received string',
      'Invalid config: [rule_options."performance/ttfb"]: no rule has this id, so the table changes nothing (did you mean "perf/ttfb"?)',
      'Invalid config: [rule_options."core/meta-description"] no_such_option: not an option of core/meta-description, so it changes nothing (options: min_length, max_length)',
    ]);
  });

  test("a file with valid rule options is valid", async () => {
    await validate(`[rule_options."core/meta-title"]
min_length = 20
`);
    expect(exitCode).toBeNull();
    expect(stdout).toEqual([`Config valid: ${join(dir, "squirrel.toml")}`]);
  });
});
