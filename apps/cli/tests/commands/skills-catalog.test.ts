// #2409: `squirrel skills list`, `install <name>`, `--all` and the catalog.
// Scratch home, stubbed fetch: no real ~/.agents, ~/.claude or network.

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
import { join } from "node:path";

import type { SkillsEnv } from "@/self/agent-skills";

import {
  printSkillsList,
  printSkillsStatus,
  runSkillsSync,
} from "@/cli/commands/skills";
import { createTheme } from "@/cli/theme";
import {
  SKILL_NAMES,
  installSkills,
  runSkillsAutoRefresh,
} from "@/self/agent-skills";
import { sha256Hex } from "@/self/skills-manifest";

const theme = createTheme(
  { isTTY: false },
  { LANG: "en_US.UTF-8", TERM_PROGRAM: "test" }
);

const SHA = "c".repeat(40);
const enc = (s: string) => new TextEncoder().encode(s);
const skillMd = (name: string, v: string) =>
  `---\nname: ${name}\ndescription: d\nmetadata:\n  author: squirrelscan\n  version: "${v}"\n---\nbody ${v}\n`;

const TASK = "seo-audit";
const OTHER = "security-headers";
const VERSIONS = {
  squirrelscan: "1.0",
  "audit-website": "1.0",
  [TASK]: "1.0",
  [OTHER]: "1.0",
};

/** A skills repo with a catalog of every skill and a manifest of the core two. */
function remote(
  options: {
    catalog?: "ok" | "missing" | "garbage";
    offline?: boolean;
    versions?: Record<string, string>;
    /** Serve different bytes than the catalog's hash for this skill's SKILL.md. */
    tamper?: string;
  } = {}
) {
  const versions: Record<string, string> = options.versions ?? VERSIONS;
  const files = (name: string) => ({
    "SKILL.md": skillMd(name, versions[name]!),
  });
  const entry = (name: string) => ({
    name,
    version: versions[name],
    description: `Does ${name}.`,
    default: (SKILL_NAMES as readonly string[]).includes(name),
    files: Object.entries(files(name)).map(([path, c]) => ({
      path,
      sha256: sha256Hex(enc(c)),
      size: enc(c).byteLength,
    })),
  });
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
        skills: [...SKILL_NAMES].map(entry),
      });
    }
    if (url === `${raw}catalog.json`) {
      if (options.catalog === "missing")
        return new Response("", { status: 404 });
      if (options.catalog === "garbage") return new Response("<html>");
      return Response.json({
        schema: 1,
        skills: Object.keys(versions).map(entry),
      });
    }
    const [skill, ...rest] = url.slice(`${raw}skills/`.length).split("/");
    const content = (files(skill!) as Record<string, string>)[rest.join("/")];
    if (content === undefined) return new Response("", { status: 404 });
    return new Response(
      enc(options.tamper === skill ? `${content}!` : content)
    );
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

describe("squirrel skills catalog", () => {
  let root: string;
  let e: SkillsEnv;
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;
  let stderr: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-catalog-"));
    e = {
      home: join(root, "home"),
      cwd: join(root, "repo"),
      env: {},
      dataDir: join(root, "home", ".squirrel"),
    };
    mkdirSync(e.home, { recursive: true });
    mkdirSync(e.cwd, { recursive: true });
    logSpy = spyOn(console, "log").mockImplementation(() => {});
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
    logSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  const output = () => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  const dir = (name: string, agent = ".claude") =>
    join(e.home, agent, "skills", name);
  const installed = (name: string, agent = ".claude") =>
    existsSync(join(dir(name, agent), "SKILL.md"));

  test("a bare install is exactly the default set, and works when the catalog is missing or invalid", async () => {
    for (const catalog of ["ok", "missing", "garbage"] as const) {
      rmSync(join(e.home, ".claude"), { recursive: true, force: true });
      rmSync(join(e.home, ".agents"), { recursive: true, force: true });
      await runSkillsSync("install", [], {
        e,
        theme,
        fetch: remote({ catalog }).fetch,
      });
      for (const name of Object.keys(VERSIONS)) {
        expect(installed(name)).toBe(
          (SKILL_NAMES as readonly string[]).includes(name)
        );
      }
    }
  });

  test("a default install with an unreachable catalog fails without writing", async () => {
    expect(
      await captureExit(() =>
        runSkillsSync("install", [], {
          e,
          theme,
          fetch: remote({ offline: true }).fetch,
        })
      )
    ).toBe(1);
    expect(existsSync(join(e.home, ".claude"))).toBe(false);
  });

  test("install <name> installs a task skill; an unknown name lists the valid ones and writes nothing", async () => {
    await runSkillsSync("install", [TASK], { e, theme, fetch: remote().fetch });
    expect(installed(TASK)).toBe(true);
    expect(installed("squirrelscan")).toBe(false);

    rmSync(join(e.home, ".claude"), { recursive: true, force: true });
    rmSync(join(e.home, ".agents"), { recursive: true, force: true });
    const code = await captureExit(() =>
      runSkillsSync("install", ["no-such-skill", TASK], {
        e,
        theme,
        fetch: remote().fetch,
      })
    );
    expect(code).toBe(1);
    const err = stderr.join("");
    expect(err).toContain("no such skill: no-such-skill");
    for (const name of Object.keys(VERSIONS)) expect(err).toContain(name);
    expect(existsSync(join(e.home, ".claude"))).toBe(false);
    expect(existsSync(join(e.home, ".agents"))).toBe(false);
  });

  test("install --all installs the three-skill catalog; --dry-run and --agent still apply", async () => {
    const versions = { squirrelscan: "1.0", [TASK]: "1.0", [OTHER]: "1.0" };
    await runSkillsSync("install", ["--all", "--dry-run"], {
      e,
      theme,
      fetch: remote({ versions }).fetch,
    });
    expect(existsSync(join(e.home, ".claude"))).toBe(false);

    await runSkillsSync("install", ["--all", "--agent", "claude"], {
      e,
      theme,
      fetch: remote({ versions }).fetch,
    });
    for (const name of Object.keys(versions)) {
      expect(installed(name)).toBe(true);
      expect(installed(name, ".agents")).toBe(false);
    }
  });

  test("--all with names is refused", async () => {
    expect(
      await captureExit(() =>
        runSkillsSync("install", ["--all", TASK], {
          e,
          theme,
          fetch: remote().fetch,
        })
      )
    ).toBe(1);
    expect(stderr.join("")).toContain("--all takes no skill names");
  });

  test("a file whose bytes do not match the catalog hash is never written", async () => {
    expect(
      await captureExit(() =>
        runSkillsSync("install", [TASK], {
          e,
          theme,
          fetch: remote({ tamper: TASK }).fetch,
        })
      )
    ).toBe(1);
    expect(installed(TASK)).toBe(false);
  });

  test("update takes a task skill to its new hash and keeps an edited file unless --force", async () => {
    await runSkillsSync("install", [TASK], { e, theme, fetch: remote().fetch });
    const newer = { ...VERSIONS, [TASK]: "1.1" };
    const path = join(dir(TASK), "SKILL.md");

    writeFileSync(path, "my edit");
    await runSkillsSync("update", [], {
      e,
      theme,
      fetch: remote({ versions: newer }).fetch,
    });
    expect(readFileSync(path, "utf8")).toBe("my edit");
    expect(output()).toContain(`${TASK}/SKILL.md`);

    await runSkillsSync("update", ["--force"], {
      e,
      theme,
      fetch: remote({ versions: newer }).fetch,
    });
    expect(readFileSync(path, "utf8")).toBe(skillMd(TASK, "1.1"));
  });

  test("update --check exits 1 for a task skill update", async () => {
    await runSkillsSync("install", [TASK], { e, theme, fetch: remote().fetch });
    expect(
      await captureExit(() =>
        runSkillsSync("update", ["--check"], {
          e,
          theme,
          fetch: remote({ versions: { ...VERSIONS, [TASK]: "1.1" } }).fetch,
        })
      )
    ).toBe(1);
  });

  test("update does not install new skills; update --all installs them where skills already are", async () => {
    await runSkillsSync("install", ["--agent", "claude"], {
      e,
      theme,
      fetch: remote().fetch,
    });
    await runSkillsSync("update", [], { e, theme, fetch: remote().fetch });
    expect(installed(TASK)).toBe(false);

    await runSkillsSync("update", ["--all"], {
      e,
      theme,
      fetch: remote().fetch,
    });
    expect(installed(TASK)).toBe(true);
    expect(installed(OTHER)).toBe(true);
    // Only the location in use: nothing appears under .agents.
    expect(installed(TASK, ".agents")).toBe(false);
  });

  test("the unattended refresh updates installed skills and never installs new ones", async () => {
    await runSkillsSync("install", [TASK], { e, theme, fetch: remote().fetch });
    const outcome = await runSkillsAutoRefresh({
      e,
      suppressed: () => null,
      enabled: () => true,
      fetch: remote({ versions: { ...VERSIONS, [TASK]: "1.1" } }).fetch,
    });
    expect(outcome).toBe("done");
    expect(readFileSync(join(dir(TASK), "SKILL.md"), "utf8")).toBe(
      skillMd(TASK, "1.1")
    );
    expect(installed(OTHER)).toBe(false);
    expect(installed("squirrelscan")).toBe(false);
  });

  test("list --json names every catalog skill with its install state; offline it lists installed skills only", async () => {
    await installSkills({ e, skills: [TASK], fetch: remote().fetch });
    await printSkillsList(["--json"], { e, theme, fetch: remote().fetch });
    const online = JSON.parse(output());
    expect(online.catalog).toBe(true);
    expect(online.skills.map((s: { name: string }) => s.name).sort()).toEqual(
      Object.keys(VERSIONS).sort()
    );
    const task = online.skills.find((s: { name: string }) => s.name === TASK);
    expect(task.default).toBe(false);
    expect(task.description).toBe(`Does ${TASK}.`);
    expect(
      task.installed.map((i: { agent: string }) => i.agent).sort()
    ).toEqual(["agents", "claude"]);
    expect(task.installed[0].scope).toBe("global");
    const core = online.skills.find(
      (s: { name: string }) => s.name === "squirrelscan"
    );
    expect(core.default).toBe(true);
    expect(core.installed).toEqual([]);

    logSpy.mockClear();
    await printSkillsList(["--json"], {
      e,
      theme,
      fetch: remote({ offline: true }).fetch,
    });
    const offline = JSON.parse(output());
    expect(offline.catalog).toBe(false);
    expect(offline.skills.map((s: { name: string }) => s.name)).toEqual([TASK]);

    logSpy.mockClear();
    await printSkillsList([], {
      e,
      theme,
      fetch: remote({ offline: true }).fetch,
    });
    expect(output()).toContain("catalog is unavailable");
  });

  test("status reports a task skill's installed and latest version", async () => {
    await runSkillsSync("install", [TASK], { e, theme, fetch: remote().fetch });
    logSpy.mockClear();
    await printSkillsStatus(["--json"], {
      e,
      theme,
      autoUpdateOn: true,
      fetch: remote({ versions: { ...VERSIONS, [TASK]: "1.1" } }).fetch,
    });
    const status = JSON.parse(output());
    const task = status.skills.find((s: { name: string }) => s.name === TASK);
    expect(task.latest).toBe("1.1");
    expect(task.targets[0].version).toBe("1.0");
    expect(task.targets[0].outdated).toBe(true);
  });
});
