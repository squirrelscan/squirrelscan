// #2357: `squirrel skills [status|install|update|uninstall]`, the command layer
// over the native manager, against the interface approved in the issue.
// Scratch home, stubbed fetch: no real ~/.agents, ~/.claude or ~/.squirrel, no
// network, and no npx anywhere.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SkillsEnv } from "@/self/agent-skills";

import { installAgentSkills } from "@/cli/commands/setup";
import {
  parseSkillsArgs,
  printSkillsStatus,
  runSkillsSync,
  runSkillsRoot,
  runSkillsUninstall,
  skills,
} from "@/cli/commands/skills";
import { createTheme } from "@/cli/theme";
import { installedSkillRoots } from "@/self/agent-skills";
import { sha256Hex } from "@/self/skills-manifest";

// Plain output with Unicode glyphs, whatever the terminal running the tests.
const theme = createTheme(
  { isTTY: false },
  { LANG: "en_US.UTF-8", TERM_PROGRAM: "test" }
);

const SHA = "b".repeat(40);
const enc = (s: string) => new TextEncoder().encode(s);
const skillMd = (name: string, v: string) =>
  `---\nname: ${name}\ndescription: d\nmetadata:\n  author: squirrelscan\n  version: "${v}"\n---\nbody\n`;

function remote(
  options: {
    offline?: boolean;
    tamper?: boolean;
    versions?: Record<string, string>;
  } = {}
) {
  const versions = options.versions ?? {
    squirrelscan: "1.4.1",
    "audit-website": "2.1",
  };
  const files: Record<string, Record<string, string>> = Object.fromEntries(
    Object.entries(versions).map(([name, v]) => [
      name,
      { "SKILL.md": skillMd(name, v) },
    ])
  );
  const requests: string[] = [];
  const fetchStub = (async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (options.offline) throw new TypeError("getaddrinfo ENOTFOUND");
    if (url.includes("/info/refs")) {
      return new Response(`003f${SHA} refs/heads/main\n`);
    }
    const raw = `https://raw.githubusercontent.com/squirrelscan/skills/${SHA}/`;
    if (url === `${raw}manifest.json`) {
      return Response.json({
        schema: 1,
        repository: "squirrelscan/skills",
        skills: Object.entries(files).map(([name, f]) => ({
          name,
          version: versions[name],
          files: Object.entries(f).map(([path, c]) => ({
            path,
            sha256: sha256Hex(enc(c)),
            size: enc(c).byteLength,
          })),
        })),
      });
    }
    const [skill, ...rest] = url.slice(`${raw}skills/`.length).split("/");
    const content = files[skill!]?.[rest.join("/")];
    if (content === undefined) return new Response("", { status: 404 });
    return new Response(options.tamper ? enc(`${content}!`) : enc(content));
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, requests };
}

class ProcessExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

async function captureExit(
  run: () => Promise<unknown>
): Promise<number | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof ProcessExitSignal) return error.code ?? 0;
    throw error;
  }
}

describe("squirrel skills", () => {
  let root: string;
  let e: SkillsEnv;
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;
  let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
  let stderr: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-cmd-"));
    e = {
      home: join(root, "home"),
      cwd: join(root, "repo"),
      env: {},
      dataDir: join(root, "home", ".squirrel"),
    };
    mkdirSync(e.home, { recursive: true });
    mkdirSync(e.cwd, { recursive: true });
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    stderr = [];
    spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ProcessExitSignal(code);
    }) as typeof process.exit);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
    (process.exit as unknown as { mockRestore: () => void }).mockRestore();
    (
      process.stderr.write as unknown as { mockRestore: () => void }
    ).mockRestore();
  });

  const output = () =>
    [
      ...[...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(" ")),
      ...stderr,
    ].join("\n");

  test("has install, update, status and uninstall, and nothing runs npx", () => {
    expect(Object.keys(skills.subCommands ?? {})).toEqual([
      "install",
      "update",
      "status",
      "uninstall",
    ]);
    const src = (file: string) =>
      readFileSync(join(import.meta.dir, "../../src", file), "utf8");
    // The command and the fetcher spawn nothing; the manager spawns only
    // itself (the detached `skills update --auto` child), never npx.
    expect(src("cli/commands/skills.ts")).not.toMatch(/child_process/);
    expect(src("self/skills-manifest.ts")).not.toMatch(/child_process/);
    expect(src("self/agent-skills.ts")).not.toMatch(/["']npx["']/);
  });

  test("argument parsing: skills, repeatable --agent, --agent all, and unknown flags refused", () => {
    const parsed = parseSkillsArgs(
      ["audit-website", "--agent", "claude", "--agent=agents", "--dry-run"],
      ["--agent", "--dry-run"]
    );
    expect(parsed.skills).toEqual(["audit-website"]);
    expect(parsed.agents).toEqual(["claude", "agents"]);
    expect(parsed.flags.has("--dry-run")).toBe(true);
    expect(parseSkillsArgs(["--agent", "all"], ["--agent"]).agents).toEqual([
      "claude",
      "agents",
    ]);
    expect(() => parseSkillsArgs(["--dryrun"], ["--dry-run"])).toThrow(
      /unknown option --dryrun/
    );
    expect(() => parseSkillsArgs(["--agent", "cursor"], ["--agent"])).toThrow(
      /unknown agent cursor/
    );
    expect(() => parseSkillsArgs(["--force=false"], ["--force"])).toThrow(
      /--force takes no value/
    );
  });

  test("a mistyped flag stops the command before it writes anything", async () => {
    const net = remote();
    const exit = await captureExit(() =>
      runSkillsSync("install", ["--dryrun"], { e, theme, fetch: net.fetch })
    );
    expect(exit).toBe(1);
    expect(net.requests).toEqual([]);
    expect(existsSync(join(e.home, ".agents"))).toBe(false);
  });

  test("install writes both skills into both folders and says so", async () => {
    expect(
      await captureExit(() =>
        runSkillsSync("install", [], { e, theme, fetch: remote().fetch })
      )
    ).toBeNull();
    for (const dir of [".agents", ".claude"]) {
      expect(
        existsSync(join(e.home, dir, "skills", "squirrelscan", "SKILL.md"))
      ).toBe(true);
    }
    expect(output()).toMatch(
      /✓ squirrelscan 1\.4\.1 +→ ~.\.claude.skills, ~.\.agents.skills/
    );
    expect(output()).toContain("Restart your agent to load them.");
  });

  test("install --project --agent claude --dry-run writes nothing", async () => {
    await runSkillsSync(
      "install",
      ["audit-website", "--project", "--agent", "claude", "--dry-run"],
      {
        e,
        theme,
        fetch: remote().fetch,
      }
    );
    expect(output()).toContain("Dry run: nothing was written.");
    expect(output()).toContain("~ would install audit-website 2.1");
    expect(existsSync(join(e.cwd, ".claude"))).toBe(false);
  });

  test("a bad download fails the command and changes nothing", async () => {
    const exit = await captureExit(() =>
      runSkillsSync("install", [], {
        e,
        theme,
        fetch: remote({ tamper: true }).fetch,
      })
    );
    expect(exit).toBe(1);
    expect(existsSync(join(e.home, ".agents", "skills", "squirrelscan"))).toBe(
      false
    );
    expect(output()).toContain("Nothing was changed");
  });

  test("update with nothing installed says so and touches no network", async () => {
    const net = remote();
    expect(
      await captureExit(() =>
        runSkillsSync("update", [], { e, theme, fetch: net.fetch })
      )
    ).toBeNull();
    expect(net.requests).toEqual([]);
    expect(output()).toContain("squirrel skills install");
  });

  test("update --check reports and exits 1 only when an update is available", async () => {
    await runSkillsSync("install", [], { e, theme, fetch: remote().fetch });
    logSpy.mockClear();
    expect(
      await captureExit(() =>
        runSkillsSync("update", ["--check"], {
          e,
          theme,
          fetch: remote().fetch,
        })
      )
    ).toBeNull();
    expect(output()).toContain("Skills are current.");

    const newer = remote({
      versions: { squirrelscan: "1.5", "audit-website": "2.1" },
    });
    expect(
      await captureExit(() =>
        runSkillsSync("update", ["--check"], { e, theme, fetch: newer.fetch })
      )
    ).toBe(1);
    expect(output()).toContain("↑ squirrelscan 1.4.1 → 1.5");
    // --check never writes.
    expect(
      readFileSync(
        join(e.home, ".agents", "skills", "squirrelscan", "SKILL.md"),
        "utf8"
      )
    ).toContain('"1.4.1"');
  });

  test("update --check exits 2, never 1, when the check itself fails", async () => {
    await runSkillsSync("install", [], { e, theme, fetch: remote().fetch });
    expect(
      await captureExit(() =>
        runSkillsSync("update", ["--check"], {
          e,
          theme,
          fetch: remote({ offline: true }).fetch,
        })
      )
    ).toBe(2);
    expect(
      await captureExit(() =>
        runSkillsSync("update", ["--check", "--frce"], {
          e,
          theme,
          fetch: remote().fetch,
        })
      )
    ).toBe(2);

    // A target that can't be written is reported, not called current.
    const skill = join(e.home, ".agents", "skills", "squirrelscan");
    rmSync(join(skill, "SKILL.md"));
    mkdirSync(join(skill, "SKILL.md"));
    logSpy.mockClear();
    expect(
      await captureExit(() =>
        runSkillsSync("update", ["--check"], {
          e,
          theme,
          fetch: remote().fetch,
        })
      )
    ).toBe(2);
    expect(output()).toMatch(/✗ squirrelscan in ~.\.agents.skills: /);
    expect(output()).not.toContain("Skills are current.");
  });

  test("update keeps an edited file and says how to replace it; --force does", async () => {
    await runSkillsSync("install", [], { e, theme, fetch: remote().fetch });
    const skillPath = join(
      e.home,
      ".claude",
      "skills",
      "squirrelscan",
      "SKILL.md"
    );
    writeFileSync(skillPath, "my edit");
    const newer = () =>
      remote({ versions: { squirrelscan: "1.5", "audit-website": "2.1" } })
        .fetch;
    logSpy.mockClear();
    await runSkillsSync("update", [], { e, theme, fetch: newer() });
    expect(output()).toMatch(
      /! squirrelscan\/SKILL\.md in ~.\.claude.skills was edited locally, kept it\./
    );
    expect(output()).toContain(
      "Use --force to replace it (your copy is backed up first)."
    );
    expect(output()).toContain("✓ audit-website 2.1 is current");
    expect(readFileSync(skillPath, "utf8")).toBe("my edit");

    logSpy.mockClear();
    await runSkillsSync("update", ["--force"], { e, theme, fetch: newer() });
    expect(readFileSync(skillPath, "utf8")).toContain('"1.5"');
    expect(output()).toContain("Backed up 1 file(s)");
  });

  test("install over an edited copy points at update --force, the command that has it", async () => {
    await runSkillsSync("install", [], { e, theme, fetch: remote().fetch });
    writeFileSync(
      join(e.home, ".claude", "skills", "squirrelscan", "SKILL.md"),
      "my edit"
    );
    logSpy.mockClear();
    await runSkillsSync("install", [], {
      e,
      theme,
      fetch: remote({
        versions: { squirrelscan: "1.5", "audit-website": "2.1" },
      }).fetch,
    });
    expect(output()).toContain(
      "Run `squirrel skills update --force` to replace it"
    );
  });

  test("update --json prints the result", async () => {
    await runSkillsSync("install", [], { e, theme, fetch: remote().fetch });
    logSpy.mockClear();
    await runSkillsSync("update", ["--json"], {
      e,
      theme,
      fetch: remote().fetch,
    });
    const json = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
    expect(
      json.targets.every((t: { outcome: string }) => t.outcome === "current")
    ).toBe(true);
  });

  test("status is a table of installed and latest versions, offline too", async () => {
    await runSkillsSync("install", [], { e, theme, fetch: remote().fetch });
    logSpy.mockClear();
    await printSkillsStatus([], {
      e,
      theme,
      fetch: remote({
        versions: { squirrelscan: "1.4.1", "audit-website": "2.2" },
      }).fetch,
      autoUpdateOn: true,
    });
    expect(output()).toContain(
      "squirrelscan skills  (github.com/squirrelscan/skills @ bbbbbbb)"
    );
    expect(output()).toMatch(
      /audit-website +2\.1 +2\.2 ↑ +~.\.claude.skills, ~.\.agents.skills/
    );
    expect(output()).toMatch(/squirrelscan +1\.4\.1 +1\.4\.1 +~/);
    expect(output()).toContain(
      "1 update available: run `squirrel skills update`."
    );
    expect(output()).toContain(
      "Auto-update is on: skills update with the CLI."
    );

    logSpy.mockClear();
    await printSkillsStatus(["--json"], {
      e,
      theme,
      fetch: remote({ offline: true }).fetch,
      autoUpdateOn: false,
    });
    const json = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(json.autoUpdate).toBe(false);
    expect(
      json.skills.find((s: { name: string }) => s.name === "squirrelscan")
        .targets
    ).toHaveLength(2);
  });

  test("bare `squirrel skills` is status; after a subcommand it stays quiet", async () => {
    await runSkillsSync("install", [], { e, theme, fetch: remote().fetch });
    logSpy.mockClear();
    await runSkillsRoot([], {
      e,
      theme,
      fetch: remote().fetch,
      autoUpdateOn: true,
    });
    expect(output()).toContain(
      `squirrelscan skills  (github.com/squirrelscan/skills @ ${SHA.slice(0, 7)})`
    );
    expect(output()).toContain("Skills are current.");

    logSpy.mockClear();
    await runSkillsRoot(["install"], { e, theme, fetch: remote().fetch });
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("setup's installAgentSkills is the native install: both skills, both default folders", async () => {
    const net = remote();
    const result = await installAgentSkills({ e, fetch: net.fetch });
    const roots = [
      join(e.home, ".claude", "skills"),
      join(e.home, ".agents", "skills"),
    ];
    expect(result).toEqual({ ok: true, targets: roots });
    expect(installedSkillRoots(e)).toEqual(roots);

    const offline = await installAgentSkills({
      e: { ...e, home: join(root, "other-home") },
      fetch: remote({ offline: true }).fetch,
    });
    expect(offline.ok).toBe(false);
    expect(offline.error).toContain("ENOTFOUND");
  });

  test("uninstall removes what it installed, for the chosen agent", async () => {
    await runSkillsSync("install", [], { e, theme, fetch: remote().fetch });
    const mine = join(e.home, ".claude", "skills", "audit-website", "notes.md");
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(mine, "mine");
    await runSkillsUninstall(["--agent", "agents"], { e, theme });
    expect(existsSync(join(e.home, ".agents", "skills", "squirrelscan"))).toBe(
      false
    );
    expect(existsSync(join(e.home, ".claude", "skills", "squirrelscan"))).toBe(
      true
    );

    await runSkillsUninstall([], { e, theme });
    expect(readFileSync(mine, "utf8")).toBe("mine");
    expect(output()).toContain("other files there stay");
  });
});
