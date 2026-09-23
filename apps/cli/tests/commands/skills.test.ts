// #783: unit tests for `squirrel skills install/update`. Mocks node:child_process
// so no real npx/network call happens; asserts the constructed npx args (`skills
// add <repo> -g` from squirrelscan/skills; `skills update <names>`, after
// re-adding any install recorded from squirrelscan/squirrelscan) and the
// manual-instructions fallback for both the npx-missing and spawn-failure paths.
// The skills lock is read from a scratch XDG_STATE_HOME; run with HOME=<scratch>.

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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const SKILL_REPO = "squirrelscan/skills";
// Pinned to the major the argv was checked against.
const SKILLS = "skills@1";
// `npx skills update` reads positionals as skill names, so a repo there matched
// nothing and the update was a silent no-op.
const UPDATE_CMD = "npx skills@1 update squirrelscan -y";

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

async function runAndCaptureExit(
  // oxlint-disable-next-line typescript/no-explicit-any -- both commands' contexts
  run: ((context: CommandContext<any>) => unknown) | undefined,
  args: Record<string, unknown> = {}
): Promise<ProcessExitSignal | null> {
  try {
    await run?.({ args } as unknown as CommandContext<ArgsDef>);
    return null;
  } catch (e) {
    if (e instanceof ProcessExitSignal) return e;
    throw e;
  }
}

describe("squirrel skills install/update", () => {
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;
  let errorSpy: ReturnType<typeof spyOn<Console, "error">>;

  let stateDir: string;
  let savedXdg: string | undefined;
  let savedNoUpdate: string | undefined;

  // Where the skills CLI keeps its global lock, when XDG_STATE_HOME is set.
  const globalLock = (skills: Record<string, unknown>) => {
    mkdirSync(join(stateDir, "skills"), { recursive: true });
    writeFileSync(
      join(stateDir, "skills", ".skill-lock.json"),
      JSON.stringify({ version: 3, skills })
    );
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "skills-cmd-"));
    savedXdg = process.env.XDG_STATE_HOME;
    savedNoUpdate = process.env.SQUIRREL_NO_UPDATE;
    process.env.XDG_STATE_HOME = stateDir;
    // The project lock is read from the working directory: never the real one.
    spyOn(process, "cwd").mockReturnValue(stateDir);
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
    rmSync(stateDir, { recursive: true, force: true });
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
    if (savedNoUpdate === undefined) delete process.env.SQUIRREL_NO_UPDATE;
    else process.env.SQUIRREL_NO_UPDATE = savedNoUpdate;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    (process.exit as unknown as { mockRestore: () => void }).mockRestore();
    (process.cwd as unknown as { mockRestore: () => void }).mockRestore();
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

    const skillsCall = calls.find((c) => c.args[0] === SKILLS);
    expect(skillsCall).toBeDefined();
    expect(skillsCall?.cmd).toBe("npx");
    expect(skillsCall?.args).toEqual([SKILLS, "add", SKILL_REPO, "-g"]);
    expect(skillsCall?.args).not.toContain("--skill");
    expect(loggedText()).toContain("Skills installed!");
  });

  test("install: links the canonical repo's skills.sh page", async () => {
    await runAndCaptureExit(skillsInstall.run);

    expect(loggedText()).toContain(
      "View skills: https://skills.sh/squirrelscan/skills"
    );
  });

  test("update: constructs `npx skills update <names>`, never a repo", async () => {
    globalLock({ squirrelscan: { source: "squirrelscan/skills" } });

    const exit = await runAndCaptureExit(skillsUpdate.run);
    expect(exit).toBeNull();

    // No scope flag: global and project installs both update.
    expect(
      calls.filter((c) => c.args[0] === SKILLS).map((c) => c.args)
    ).toEqual([[SKILLS, "update", "squirrelscan", "-y"]]);
    expect(loggedText()).toContain("Skills updated!");
  });

  test("update: nothing installed -> says so and points at install, never runs npx", async () => {
    const exit = await runAndCaptureExit(skillsUpdate.run);

    expect(exit).toBeNull();
    expect(calls).toEqual([]);
    expect(loggedText()).toContain("squirrel skills install");
    expect(loggedText()).not.toContain("Skills updated!");
  });

  test("update: an install recorded from squirrelscan/squirrelscan is re-added from squirrelscan/skills first", async () => {
    globalLock({
      squirrelscan: { source: "squirrelscan/squirrelscan" },
      "audit-website": { source: "squirrelscan/skills" },
    });

    const exit = await runAndCaptureExit(skillsUpdate.run);
    expect(exit).toBeNull();

    expect(
      calls.filter((c) => c.args[0] === SKILLS).map((c) => c.args)
    ).toEqual([
      [SKILLS, "add", SKILL_REPO, "--skill", "squirrelscan", "-g", "-y"],
      [SKILLS, "update", "audit-website", "-y"],
    ]);
    expect(loggedText()).toContain(
      "Moving squirrelscan from squirrelscan/squirrelscan to squirrelscan/skills"
    );
    expect(loggedText()).not.toContain("Tip:");
  });

  test("update --auto: silent, and never spawns when auto-update is suppressed", async () => {
    globalLock({ squirrelscan: { source: "squirrelscan/squirrelscan" } });
    process.env.SQUIRREL_NO_UPDATE = "1";

    const exit = await runAndCaptureExit(skillsUpdate.run, { auto: true });

    expect(exit).toBeNull();
    expect(calls).toEqual([]);
    expect(loggedText()).toBe("");
  });

  test("install: npx missing -> manual instructions, exit(0), never calls `skills add`", async () => {
    npxVersionResult = { error: new Error("ENOENT"), status: null };

    const exit = await runAndCaptureExit(skillsInstall.run);

    expect(exit?.code).toBe(0);
    expect(calls.some((c) => c.args[0] === SKILLS)).toBe(false);
    expect(loggedText()).toContain(`npx skills@1 add ${SKILL_REPO} -g`);
  });

  test("update: npx missing -> manual instructions with `update`, exit(0), never calls `skills update`", async () => {
    globalLock({ squirrelscan: { source: "squirrelscan/skills" } });
    npxVersionResult = { error: new Error("ENOENT"), status: null };

    const exit = await runAndCaptureExit(skillsUpdate.run);

    expect(exit?.code).toBe(0);
    expect(calls.some((c) => c.args[0] === SKILLS)).toBe(false);
    expect(loggedText()).toContain(UPDATE_CMD);
  });

  test("install: `skills add` spawn fails -> manual instructions fallback, exit(1)", async () => {
    skillsCommandResult = { status: 1 };

    const exit = await runAndCaptureExit(skillsInstall.run);

    expect(exit?.code).toBe(1);
    expect(loggedText()).toContain("Failed to install skills");
    expect(loggedText()).toContain(`npx skills@1 add ${SKILL_REPO} -g`);
  });

  test("update: `skills update` spawn fails -> manual instructions fallback, exit(1)", async () => {
    globalLock({ squirrelscan: { source: "squirrelscan/skills" } });
    skillsCommandResult = { error: new Error("boom"), status: null };

    const exit = await runAndCaptureExit(skillsUpdate.run);

    expect(exit?.code).toBe(1);
    expect(loggedText()).toContain("Failed to update skills");
    expect(loggedText()).toContain(UPDATE_CMD);
  });

  test("update: a failed migration stops before the update and prints both commands", async () => {
    globalLock({
      squirrelscan: { source: "squirrelscan/squirrelscan" },
      "audit-website": { source: "squirrelscan/skills" },
    });
    skillsCommandResult = { status: 1 };

    const exit = await runAndCaptureExit(skillsUpdate.run);

    expect(exit?.code).toBe(1);
    expect(calls.filter((c) => c.args[0] === SKILLS)).toHaveLength(1);
    expect(loggedText()).toContain(
      "npx skills@1 add squirrelscan/skills --skill squirrelscan -g -y"
    );
    expect(loggedText()).toContain("npx skills@1 update audit-website -y");
  });
});
