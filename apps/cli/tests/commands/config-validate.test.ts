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
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "@/cli/commands/config";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

// #626: the command reads credentials and settings; keep them in a scratch home.
const dir = isolateSquirrelHome("squirrel-config-validate").root;
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

// Built at runtime: a nested-quantifier literal reads as a ReDoS to static analysis, and is the point of the test.
const BACKREF = "regex:(a)\\\\1";

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

  // #1262: the `[[ignore]]` table.
  test("a valid [[ignore]] table is valid", async () => {
    await validate(`[[ignore]]
rule = "security/cookie-flags"
items = ["localization", "cart_currency"]
reason = "Shopify sets these"
`);
    expect(exitCode).toBeNull();
    expect(stdout).toEqual([`Config valid: ${join(dir, "squirrel.toml")}`]);
  });

  test("reports an entry that names no rule, one that names compromise detection, and an unsafe regex", async () => {
    await validate(`[[ignore]]
rule = "performance/ttfb"
urls = ["/apps/"]

[[ignore]]
rule = "integrity/*"
items = ["a"]

[[ignore]]
rule = "security/cookie-flags"
items = ["${BACKREF}"]
`);
    expect(exitCode).toBe(1);
    expect(stderr).toEqual([
      'Invalid config: [[ignore]] entry 1 (performance/ttfb): no rule matches, so the entry changes nothing (did you mean "perf/ttfb"?)',
      expect.stringContaining(
        "[[ignore]] entry 2 (integrity/*): compromise detection cannot be ignored"
      ),
      expect.stringContaining(
        `[[ignore]] entry 3 (security/cookie-flags) items: "regex:(a)\\1" is a regex the linear-time matcher cannot run (back-references;`
      ),
    ]);
  });

  test("an entry with neither items nor urls, and selectors, are refused by the schema", async () => {
    await validate(`[[ignore]]
rule = "security/cookie-flags"
`);
    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("an ignore entry needs items or urls");
    stderr = [];
    exitCode = null as number | null;
    await validate(`[[ignore]]
rule = "a11y/select-name"
selectors = ["localization-form select"]
items = ["x"]
`);
    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("selectors are not supported yet");
  });

  test("the per-rule ignore option names are pointed at [[ignore]]", async () => {
    await validate(`[rule_options."security/cookie-flags"]
ignore_items = ["localization"]
`);
    expect(exitCode).toBe(1);
    expect(stderr).toEqual([
      expect.stringContaining(
        'ignore_items: waivers are not a rule option, so it changes nothing; use [[ignore]] with rule = "security/cookie-flags"'
      ),
    ]);
  });
});
