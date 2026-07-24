// #783: unit tests for `squirrel skills install/update`. Mocks node:child_process
// so no real npx/network call happens; asserts the constructed npx args (skills
// add/update <repo> -g — no --skill flag after the two-skill split, #781) and
// the manual-instructions fallback for both the npx-missing and spawn-failure
// paths.

import type { ArgsDef, CommandContext } from "citty";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as realChildProcess from "node:child_process";

interface SpawnCall {
  cmd: string;
  args: string[];
}

let calls: SpawnCall[] = [];
let npxVersionResult: { error?: Error; status: number | null } = { status: 0 };
let skillsCommandResult: { error?: Error; status: number | null } = {
  status: 0,
};

// Process-wide for the whole `bun test` run (Bun doesn't scope mock.module
// per file) — spread the real module's other exports (spawn, exec, etc.) so
// files that import them (e.g. updater.ts/login.ts, transitively) don't hit
// a missing-export SyntaxError when run in the same process as this file.
// Only spawnSync is faked.
mock.module("node:child_process", () => ({
  ...realChildProcess,
  spawnSync: (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return args[0] === "--version" ? npxVersionResult : skillsCommandResult;
  },
}));

const { skillsInstall, skillsUpdate } = await import("@/cli/commands/skills");

const SKILL_REPO = "https://github.com/squirrelscan/squirrelscan";

// process.exit is typed `never` — a plain no-op mock would let execution fall
// through the (unreachable-per-types, but not per a mocked runtime) code after
// each call, since skills.ts relies on real process.exit to halt. Throw
// instead, matching real "never returns" semantics, so control flow stops
// exactly where it would in production.
class ProcessExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const EMPTY_CONTEXT = {} as CommandContext<ArgsDef>;

async function runAndCaptureExit(
  run: ((context: CommandContext<ArgsDef>) => unknown) | undefined
): Promise<ProcessExitSignal | null> {
  try {
    await run?.(EMPTY_CONTEXT);
    return null;
  } catch (e) {
    if (e instanceof ProcessExitSignal) return e;
    throw e;
  }
}

describe("squirrel skills install/update", () => {
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;
  let errorSpy: ReturnType<typeof spyOn<Console, "error">>;

  beforeEach(() => {
    calls = [];
    npxVersionResult = { status: 0 };
    skillsCommandResult = { status: 0 };
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ProcessExitSignal(code);
    }) as typeof process.exit);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    (process.exit as unknown as { mockRestore: () => void }).mockRestore();
  });

  // Defense-in-depth, not a full guarantee: Bun's mock.module patches the
  // process-wide module registry, and restoring here doesn't reliably
  // re-establish identity for files ALREADY loaded before this one — but it
  // stops a spawnSync-touching test added later (in file execution order)
  // from silently hitting this suite's stale stub state instead of erroring.
  afterAll(() => {
    mock.module("node:child_process", () => realChildProcess);
  });

  function loggedText(): string {
    return logSpy.mock.calls
      .map((call) => call.join(" "))
      .concat(errorSpy.mock.calls.map((call) => call.join(" ")))
      .join("\n");
  }

  test("install: constructs `npx skills add <repo> -g`, no --skill flag", async () => {
    const exit = await runAndCaptureExit(skillsInstall.run);
    expect(exit).toBeNull();

    const skillsCall = calls.find((c) => c.args[0] === "skills");
    expect(skillsCall).toBeDefined();
    expect(skillsCall?.cmd).toBe("npx");
    expect(skillsCall?.args).toEqual(["skills", "add", SKILL_REPO, "-g"]);
    expect(skillsCall?.args).not.toContain("--skill");
    expect(loggedText()).toContain("Skills installed!");
  });

  test("update: constructs `npx skills update <repo> -g`, no --skill flag", async () => {
    const exit = await runAndCaptureExit(skillsUpdate.run);
    expect(exit).toBeNull();

    const skillsCall = calls.find((c) => c.args[0] === "skills");
    expect(skillsCall?.args).toEqual(["skills", "update", SKILL_REPO, "-g"]);
    expect(skillsCall?.args).not.toContain("--skill");
    expect(loggedText()).toContain("Skills updated!");
  });

  test("install: npx missing -> manual instructions, exit(0), never calls `skills add`", async () => {
    npxVersionResult = { error: new Error("ENOENT"), status: null };

    const exit = await runAndCaptureExit(skillsInstall.run);

    expect(exit?.code).toBe(0);
    expect(calls.some((c) => c.args[0] === "skills")).toBe(false);
    expect(loggedText()).toContain(`npx skills add ${SKILL_REPO} -g`);
  });

  test("update: npx missing -> manual instructions with `update`, exit(0), never calls `skills update`", async () => {
    npxVersionResult = { error: new Error("ENOENT"), status: null };

    const exit = await runAndCaptureExit(skillsUpdate.run);

    expect(exit?.code).toBe(0);
    expect(calls.some((c) => c.args[0] === "skills")).toBe(false);
    expect(loggedText()).toContain(`npx skills update ${SKILL_REPO} -g`);
  });

  test("install: `skills add` spawn fails -> manual instructions fallback, exit(1)", async () => {
    skillsCommandResult = { status: 1 };

    const exit = await runAndCaptureExit(skillsInstall.run);

    expect(exit?.code).toBe(1);
    expect(loggedText()).toContain("Failed to install skills");
    expect(loggedText()).toContain(`npx skills add ${SKILL_REPO} -g`);
  });

  test("update: `skills update` spawn fails -> manual instructions fallback, exit(1)", async () => {
    skillsCommandResult = { error: new Error("boom"), status: null };

    const exit = await runAndCaptureExit(skillsUpdate.run);

    expect(exit?.code).toBe(1);
    expect(loggedText()).toContain("Failed to update skills");
    expect(loggedText()).toContain(`npx skills update ${SKILL_REPO} -g`);
  });
});
