// The skills refresh that rides the CLI's auto-update, and the lock reading and
// planning `squirrel skills update` shares with it. Every spawn is a stub: no
// test here may run a real `npx skills` against a real ~/.agents or ~/.claude.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UserSettings } from "@/self/types";

import {
  type InstalledSkill,
  maybeSpawnSkillsRefresh,
  planSkillsRefresh,
  readInstalledSkills,
  runSkillsAutoRefresh,
  skillLockPaths,
} from "@/self/agent-skills";

import { version } from "../../package.json";

let dir: string;
let paths: { global: string; project: string };
let markerDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-skills-"));
  paths = {
    global: join(dir, "state", "skills", ".skill-lock.json"),
    project: join(dir, "repo", "skills-lock.json"),
  };
  mkdirSync(join(dir, "state", "skills"), { recursive: true });
  mkdirSync(join(dir, "repo"), { recursive: true });
  // Never the real ~/.squirrel.
  markerDir = join(dir, "squirrel", "skills-refresh");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function lock(path: string, skills: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ version: 3, skills }));
}

const LEGACY = { source: "squirrelscan/squirrelscan", sourceType: "github" };
const CANONICAL = { source: "squirrelscan/skills", sourceType: "github" };

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

/** A spawn stub whose children exit with `codes` in turn; `null` never exits. */
function fakeSpawn(codes: Array<number | null>) {
  const calls: SpawnCall[] = [];
  const kills: string[] = [];
  const spawn = ((
    command: string,
    args: string[],
    options: Record<string, unknown>
  ) => {
    calls.push({ command, args, options });
    // Just the ChildProcess surface agent-skills.ts touches.
    const listeners = new Map<string, (code: number) => void>();
    const child = {
      pid: undefined,
      once: (event: string, listener: (code: number) => void) => {
        listeners.set(event, listener);
        return child;
      },
      kill: (signal: string) => {
        kills.push(signal);
        return true;
      },
      unref: () => {},
    };
    const code = codes[calls.length - 1];
    if (code !== null) setTimeout(() => listeners.get("exit")?.(code ?? 0), 1);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls, kills };
}

describe("skillLockPaths", () => {
  test("global lock under $XDG_STATE_HOME when set, else ~/.agents; project lock in cwd", () => {
    expect(
      skillLockPaths({ XDG_STATE_HOME: "/state" }, "/home/u", "/repo")
    ).toEqual({
      global: "/state/skills/.skill-lock.json",
      project: "/repo/skills-lock.json",
    });
    expect(skillLockPaths({}, "/home/u", "/repo").global).toBe(
      "/home/u/.agents/.skill-lock.json"
    );
  });
});

describe("readInstalledSkills", () => {
  test("reads our skills from both locks and flags squirrelscan/squirrelscan installs", async () => {
    lock(paths.global, {
      squirrelscan: LEGACY,
      "audit-website": CANONICAL,
      "someone-elses": LEGACY,
    });
    lock(paths.project, {
      "audit-website": {
        source: "x",
        sourceUrl: "https://github.com/squirrelscan/squirrelscan.git",
      },
    });
    expect(await readInstalledSkills(paths)).toEqual([
      { name: "squirrelscan", scope: "global", legacy: true },
      { name: "audit-website", scope: "global", legacy: false },
      { name: "audit-website", scope: "project", legacy: true },
    ]);
  });

  test("an ssh clone URL of squirrelscan/squirrelscan is legacy too", async () => {
    lock(paths.global, {
      squirrelscan: {
        source: "x",
        sourceUrl: "git@github.com:squirrelscan/squirrelscan.git",
      },
    });
    expect(await readInstalledSkills(paths)).toEqual([
      { name: "squirrelscan", scope: "global", legacy: true },
    ]);
  });

  test("a global lock older than skills 1.x reads (version < 3) counts as empty, as it does there", async () => {
    writeFileSync(
      paths.global,
      JSON.stringify({ version: 2, skills: { squirrelscan: LEGACY } })
    );
    writeFileSync(
      paths.project,
      JSON.stringify({ skills: { squirrelscan: LEGACY } })
    );
    expect(await readInstalledSkills(paths)).toEqual([]);
  });

  test("missing, garbage, null and look-alike sources read as nothing legacy", async () => {
    writeFileSync(paths.global, "{not json");
    writeFileSync(paths.project, "null");
    expect(await readInstalledSkills(paths)).toEqual([]);
    lock(paths.global, {
      squirrelscan: { source: "evil-squirrelscan/squirrelscan" },
    });
    expect(await readInstalledSkills(paths)).toEqual([
      { name: "squirrelscan", scope: "global", legacy: false },
    ]);
  });
});

describe("planSkillsRefresh", () => {
  const g = (
    name: InstalledSkill["name"],
    legacy: boolean
  ): InstalledSkill => ({
    name,
    scope: "global",
    legacy,
  });
  const p = (
    name: InstalledSkill["name"],
    legacy: boolean
  ): InstalledSkill => ({
    name,
    scope: "project",
    legacy,
  });

  test("global only: re-add legacy installs from squirrelscan/skills, update the rest", () => {
    expect(
      planSkillsRefresh(
        [
          g("squirrelscan", true),
          g("audit-website", false),
          p("audit-website", true),
        ],
        ["global"]
      )
    ).toEqual([
      ["add", "squirrelscan/skills", "--skill", "squirrelscan", "-g", "-y"],
      ["update", "audit-website", "-g", "-y"],
    ]);
  });

  test("both scopes: a project re-add has no -g, and the update covers both scopes", () => {
    expect(
      planSkillsRefresh(
        [p("squirrelscan", true), g("squirrelscan", false)],
        ["global", "project"]
      )
    ).toEqual([
      ["add", "squirrelscan/skills", "--skill", "squirrelscan", "-y"],
      ["update", "squirrelscan", "-y"],
    ]);
  });

  test("never names a skill that is not installed", () => {
    expect(planSkillsRefresh([], ["global"])).toEqual([]);
    expect(planSkillsRefresh([p("squirrelscan", false)], ["global"])).toEqual(
      []
    );
    const plan = planSkillsRefresh([g("audit-website", true)], ["global"]);
    expect(plan.flat()).not.toContain("squirrelscan");
  });
});

describe("runSkillsAutoRefresh", () => {
  const deps = (spawn: ReturnType<typeof fakeSpawn>["spawn"]) => ({
    paths,
    markerDir,
    spawn,
    suppressed: () => null,
    which: () => "/usr/bin/npx",
  });

  test("moves a legacy global install, updates the other, ignores project installs", async () => {
    lock(paths.global, { squirrelscan: LEGACY, "audit-website": CANONICAL });
    lock(paths.project, { squirrelscan: LEGACY });
    const fake = fakeSpawn([0, 0]);
    expect(await runSkillsAutoRefresh(deps(fake.spawn))).toBe("done");
    expect(fake.calls.map((c) => [c.command, ...c.args])).toEqual([
      [
        "/usr/bin/npx",
        "--yes",
        "skills@1",
        "add",
        "squirrelscan/skills",
        "--skill",
        "squirrelscan",
        "-g",
        "-y",
      ],
      [
        "/usr/bin/npx",
        "--yes",
        "skills@1",
        "update",
        "audit-website",
        "-g",
        "-y",
      ],
    ]);
    // Never prompts: nothing to read from.
    expect(fake.calls[0]?.options.stdio).toBe("ignore");
  });

  test("does nothing when suppressed, when nothing is installed, or without npx", async () => {
    lock(paths.global, { squirrelscan: CANONICAL });
    const fake = fakeSpawn([0]);
    expect(
      await runSkillsAutoRefresh({
        ...deps(fake.spawn),
        suppressed: () => "running in CI",
      })
    ).toBe("suppressed");
    // Suppressed runs never claim the version.
    expect(existsSync(markerDir)).toBe(false);
    expect(
      await runSkillsAutoRefresh({ ...deps(fake.spawn), which: () => null })
    ).toBe("no_npx");
    rmSync(markerDir, { recursive: true, force: true });
    lock(paths.global, { unrelated: CANONICAL });
    expect(await runSkillsAutoRefresh(deps(fake.spawn))).toBe("none_installed");
    expect(fake.calls).toEqual([]);
  });

  test("runs once per CLI version: a second run, or a parallel one, finds it claimed", async () => {
    lock(paths.global, { squirrelscan: CANONICAL });
    const fake = fakeSpawn([0, 0]);
    expect(await runSkillsAutoRefresh(deps(fake.spawn))).toBe("done");
    expect(await runSkillsAutoRefresh(deps(fake.spawn))).toBe("already_ran");
    expect(fake.calls).toHaveLength(1);
    expect(readdirSync(markerDir)).toEqual([version]);
  });

  test("claiming a version clears older versions' markers", async () => {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, "0.0.1"), "");
    const fake = fakeSpawn([0]);
    expect(await runSkillsAutoRefresh(deps(fake.spawn))).toBe("none_installed");
    expect(readdirSync(markerDir)).toEqual([version]);
  });

  test("a failing command stops the run and reports, without throwing", async () => {
    lock(paths.global, { squirrelscan: LEGACY, "audit-website": CANONICAL });
    const fake = fakeSpawn([1, 0]);
    expect(await runSkillsAutoRefresh(deps(fake.spawn))).toBe("failed");
    expect(fake.calls).toHaveLength(1);
  });

  test("a hung command is killed at the budget, its whole process group on POSIX", async () => {
    lock(paths.global, { squirrelscan: CANONICAL });
    const fake = fakeSpawn([null]);
    const started = Date.now();
    expect(
      await runSkillsAutoRefresh({ ...deps(fake.spawn), budgetMs: 50 })
    ).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fake.kills).toEqual(["SIGKILL"]);
  });

  test("a spawn that throws is a failed refresh, not a crash", async () => {
    lock(paths.global, { squirrelscan: CANONICAL });
    const throwing = (() => {
      throw new Error("EAGAIN");
    }) as unknown as typeof import("node:child_process").spawn;
    expect(await runSkillsAutoRefresh(deps(throwing))).toBe("failed");
  });
});

describe("maybeSpawnSkillsRefresh", () => {
  const settings = (overrides: Partial<UserSettings>): UserSettings =>
    ({
      auto_update: true,
      auto_update_applied: {
        from_version: "0.0.1",
        to_version: version,
        at: "x",
      },
      ...overrides,
    }) as UserSettings;

  test("starts the detached refresh on the run that is the freshly updated version", () => {
    const fake = fakeSpawn([0]);
    expect(
      maybeSpawnSkillsRefresh(settings({}), {
        spawn: fake.spawn,
        suppressed: () => null,
        markerDir,
      })
    ).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual(["skills", "update", "--auto"]);
    expect(fake.calls[0]?.options).toMatchObject({
      detached: true,
      stdio: "ignore",
    });
  });

  test("stays out of the way otherwise", () => {
    const fake = fakeSpawn([0]);
    const run = (s: UserSettings, suppressed: string | null = null) =>
      maybeSpawnSkillsRefresh(s, {
        spawn: fake.spawn,
        suppressed: () => suppressed,
        markerDir,
      });
    expect(run(settings({ auto_update_applied: null }))).toBe(false);
    expect(
      run(
        settings({
          auto_update_applied: {
            from_version: "a",
            to_version: "0.0.0",
            at: "x",
          },
        })
      )
    ).toBe(false);
    expect(run(settings({ auto_update: false }))).toBe(false);
    expect(run(settings({}), "SQUIRREL_NO_UPDATE is set")).toBe(false);
    // This version already refreshed (the marker the child claims).
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, version), "");
    expect(run(settings({}))).toBe(false);
    expect(fake.calls).toEqual([]);
  });
});
