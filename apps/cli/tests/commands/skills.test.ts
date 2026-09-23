// #783: unit tests for `squirrel skills install/update`. Mocks node:child_process
// so no real npx/network call happens; asserts the constructed npx args (`skills
// add <repo> -g` from the canonical squirrelscan/skills repo, `skills update
// <names>`; no --skill flag after the two-skill split, #781) and the
// manual-instructions fallback for both the npx-missing and spawn-failure paths.

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

const { installedFromLegacyRepo, skillsInstall, skillsUpdate } =
  await import("@/cli/commands/skills");

const SKILL_REPO = "squirrelscan/skills";
// `npx skills update` reads positionals as skill names, so a repo there matched
// nothing and the update was a silent no-op.
const UPDATE_CMD = "npx skills update squirrelscan audit-website";

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

  test("install: links the canonical repo's skills.sh page", async () => {
    await runAndCaptureExit(skillsInstall.run);

    expect(loggedText()).toContain(
      "View skills: https://skills.sh/squirrelscan/skills"
    );
  });

  test("update: constructs `npx skills update <names>`, never a repo", async () => {
    const exit = await runAndCaptureExit(skillsUpdate.run);
    expect(exit).toBeNull();

    const skillsCall = calls.find((c) => c.args[0] === "skills");
    // No -g: names without a scope flag update global and project installs.
    expect(skillsCall?.args).toEqual([
      "skills",
      "update",
      "squirrelscan",
      "audit-website",
    ]);
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
    expect(loggedText()).toContain(UPDATE_CMD);
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
    expect(loggedText()).toContain(UPDATE_CMD);
  });
});

// The skills CLI records each skill's source in its lock files. An install from
// before squirrelscan/skills was canonical points at squirrelscan/squirrelscan.
describe("installedFromLegacyRepo", () => {
  let dir: string;
  const lockAt = (name: string, skills: unknown): string => {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify(skills === undefined ? null : { version: 3, skills })
    );
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skills-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("true for an owner/repo or URL source of squirrelscan/squirrelscan", async () => {
    const byName = lockAt("a.json", {
      "audit-website": { source: "squirrelscan/squirrelscan" },
    });
    const byUrl = lockAt("b.json", {
      squirrelscan: {
        source: "x",
        sourceUrl: "https://github.com/squirrelscan/squirrelscan.git",
      },
    });
    expect(await installedFromLegacyRepo([byName])).toBe(true);
    expect(await installedFromLegacyRepo([byUrl])).toBe(true);
  });

  test("false for the canonical repo, other skills, and missing or odd lock files", async () => {
    const canonical = lockAt("c.json", {
      squirrelscan: { source: "squirrelscan/skills" },
      "audit-website": {
        sourceUrl: "https://github.com/squirrelscan/skills.git",
      },
      other: { source: "squirrelscan/squirrelscan" },
      "not-ours": { source: "evil-squirrelscan/squirrelscan" },
    });
    const nullLock = lockAt("d.json", undefined);
    const garbage = join(dir, "e.json");
    writeFileSync(garbage, "{not json");
    expect(
      await installedFromLegacyRepo([
        canonical,
        nullLock,
        garbage,
        join(dir, "missing.json"),
      ])
    ).toBe(false);
  });

  test("`squirrel skills update` prints the one-line switch hint for a legacy install", async () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    mkdirSync(join(dir, "skills"));
    lockAt("skills/.skill-lock.json", {
      squirrelscan: { source: "squirrelscan/squirrelscan" },
    });
    calls = [];
    npxVersionResult = { status: 0 };
    skillsCommandResult = { status: 0 };
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsUpdate.run?.({} as CommandContext<ArgsDef>);
      const logged = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain(
        "Run 'squirrel skills install' once to switch to squirrelscan/skills"
      );
    } finally {
      logSpy.mockRestore();
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  });
});
