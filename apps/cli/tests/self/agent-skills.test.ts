// #2357: the native skills manager. Every test runs against scratch dirs for
// home, cwd and ~/.squirrel, and a stubbed fetch serving a fake
// squirrelscan/skills: nothing here may touch the real ~/.agents, ~/.claude or
// ~/.squirrel, or the network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { UserSettings } from "@/self/types";

import {
  type SkillsEnv,
  SkillsBusyError,
  SkillsUsageError,
  maybeSpawnSkillsRefresh,
  readState,
  runSkillsAutoRefresh,
  skillsNotices,
  skillsStatus,
  syncSkills,
  uninstallSkills,
} from "@/self/agent-skills";
import {
  fetchSkillsManifest,
  isSafeRelativePath,
  parseManifest,
  resolveSkillsRef,
  sha256Hex,
} from "@/self/skills-manifest";

import { version } from "../../package.json";

const SHA = "a".repeat(40);
const enc = (s: string) => new TextEncoder().encode(s);

type Files = Record<string, Record<string, string>>; // skill → path → content

function skillMd(
  name: string,
  v: string,
  body = "body",
  author = "squirrelscan"
): string {
  return `---\nname: ${name}\ndescription: d\nmetadata:\n  author: ${author}\n  version: "${v}"\n---\n${body}\n`;
}

const V1: Files = {
  squirrelscan: {
    "SKILL.md": skillMd("squirrelscan", "1.0"),
    "references/a.md": "ref a v1",
  },
  "audit-website": {
    "SKILL.md": skillMd("audit-website", "2.0"),
    "assets/icon.svg": "<svg/>",
  },
};
const VERSIONS = { squirrelscan: "1.0", "audit-website": "2.0" };
const withA = (content: string): Files => ({
  ...V1,
  squirrelscan: { ...V1.squirrelscan, "references/a.md": content },
});

function manifestFor(files: Files, versions: Record<string, string>) {
  return {
    schema: 1,
    repository: "squirrelscan/skills",
    skills: Object.entries(files).map(([name, f]) => ({
      name,
      version: versions[name],
      files: Object.entries(f)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, content]) => ({
          path,
          sha256: sha256Hex(enc(content)),
          size: enc(content).byteLength,
        })),
    })),
  };
}

/** A fake squirrelscan/skills: refs, manifest and raw files at one commit. */
function fakeRemote(
  files: Files,
  versions: Record<string, string> = VERSIONS,
  tamper?: Record<string, string>
) {
  const requests: string[] = [];
  const fetchStub = (async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/info/refs")) {
      // The real shape: a HEAD line carrying NUL + capabilities, then refs.
      return new Response(
        `001e# service=git-upload-pack\n0000015a${"f".repeat(40)} HEAD${String.fromCharCode(0)}multi_ack symref=HEAD:refs/heads/main\n003f${SHA} refs/heads/main\n0000`
      );
    }
    const raw = `https://raw.githubusercontent.com/squirrelscan/skills/${SHA}/`;
    if (url === `${raw}manifest.json`) {
      return Response.json(manifestFor(files, versions));
    }
    if (url.startsWith(`${raw}skills/`)) {
      const [skill, ...rest] = url
        .slice(`${raw}skills/`.length)
        .split("/")
        .map(decodeURIComponent);
      const path = rest.join("/");
      const content = tamper?.[`${skill}/${path}`] ?? files[skill!]?.[path];
      return content === undefined
        ? new Response("nope", { status: 404 })
        : new Response(enc(content));
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, requests };
}

let root: string;
let e: SkillsEnv;
let agents: string;
let claude: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "native-skills-"));
  e = {
    home: join(root, "home"),
    cwd: join(root, "repo"),
    env: {},
    dataDir: join(root, "home", ".squirrel"),
  };
  agents = join(e.home, ".agents", "skills");
  claude = join(e.home, ".claude", "skills");
  mkdirSync(e.home, { recursive: true });
  mkdirSync(e.cwd, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (path: string) => readFileSync(path, "utf8");
function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const fileDownloads = (requests: string[]) =>
  requests.filter(
    (u) => u.includes("/skills/") && !u.endsWith("manifest.json")
  );
const install = (files: Files = V1) =>
  syncSkills({ mode: "install", e, fetch: fakeRemote(files).fetch });
const targetAt = (
  result: Awaited<ReturnType<typeof syncSkills>>,
  dir: string
) => result.targets.find((t) => t.dir === dir);

describe("install", () => {
  test("writes every skill into both agents' folders as real copies, pinned to one commit", async () => {
    const remote = fakeRemote(V1);
    const result = await syncSkills({
      mode: "install",
      e,
      fetch: remote.fetch,
    });

    expect(result.ref).toBe(SHA);
    for (const dir of [agents, claude]) {
      expect(read(join(dir, "squirrelscan", "references", "a.md"))).toBe(
        "ref a v1"
      );
      expect(read(join(dir, "audit-website", "assets", "icon.svg"))).toBe(
        "<svg/>"
      );
      expect(lstatSync(join(dir, "squirrelscan")).isSymbolicLink()).toBe(false);
    }
    expect(result.targets.map((t) => t.outcome)).toEqual(
      Array(4).fill("installed")
    );
    expect(remote.requests.filter((u) => u.includes("/main/"))).toEqual([]);
    expect(
      readState(e).skills.squirrelscan?.[join(agents, "squirrelscan")]?.version
    ).toBe("1.0");
  });

  test("[skill...], --agent and --project narrow what is written", async () => {
    await syncSkills({
      mode: "install",
      e,
      fetch: fakeRemote(V1).fetch,
      skills: ["audit-website"],
      agents: ["claude"],
      scope: "project",
    });
    expect(
      existsSync(join(e.cwd, ".claude", "skills", "audit-website", "SKILL.md"))
    ).toBe(true);
    expect(existsSync(join(e.cwd, ".agents"))).toBe(false);
    expect(existsSync(join(e.cwd, ".claude", "skills", "squirrelscan"))).toBe(
      false
    );
    expect(existsSync(claude)).toBe(false);
  });

  test("an unknown skill name is refused", async () => {
    await expect(
      syncSkills({
        mode: "install",
        e,
        fetch: fakeRemote(V1).fetch,
        skills: ["nope"],
      })
    ).rejects.toThrow(/no such skill: nope/);
  });

  test("CLAUDE_CONFIG_DIR moves the Claude target", async () => {
    e.env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
    await install();
    expect(
      existsSync(
        join(root, "claude-config", "skills", "squirrelscan", "SKILL.md")
      )
    ).toBe(true);
    expect(existsSync(claude)).toBe(false);
  });

  test("--project means the repo root, not the folder it runs in, and never home", async () => {
    mkdirSync(join(e.cwd, ".git"));
    const repo = e.cwd;
    e.cwd = join(repo, "src", "deep");
    mkdirSync(e.cwd, { recursive: true });
    await syncSkills({
      mode: "install",
      e,
      fetch: fakeRemote(V1).fetch,
      scope: "project",
    });
    expect(
      existsSync(join(repo, ".claude", "skills", "squirrelscan", "SKILL.md"))
    ).toBe(true);
    expect(existsSync(join(e.cwd, ".claude"))).toBe(false);

    e.cwd = e.home;
    await expect(
      syncSkills({
        mode: "install",
        e,
        fetch: fakeRemote(V1).fetch,
        scope: "project",
      })
    ).rejects.toThrow(SkillsUsageError);
  });

  test("project copies belong to their repo: update and uninstall only touch the one they run in", async () => {
    const repoA = e.cwd;
    const repoB = join(root, "repo-b");
    mkdirSync(repoB);
    const inRepo = (cwd: string) =>
      syncSkills({
        mode: "install",
        e: { ...e, cwd },
        fetch: fakeRemote(V1).fetch,
        scope: "project",
        agents: ["claude"],
      });
    await inRepo(repoA);
    await inRepo(repoB);
    const a = (repo: string) =>
      join(repo, ".claude", "skills", "squirrelscan", "references", "a.md");

    await syncSkills({
      mode: "update",
      e: { ...e, cwd: repoB },
      fetch: fakeRemote(withA("ref a v2")).fetch,
    });
    expect(read(a(repoB))).toBe("ref a v2");
    expect(read(a(repoA))).toBe("ref a v1");

    await uninstallSkills({ e: { ...e, cwd: repoB }, scope: "project" });
    expect(existsSync(a(repoB))).toBe(false);
    expect(read(a(repoA))).toBe("ref a v1");
  });

  test("a dry run plans but writes nothing", async () => {
    const result = await syncSkills({
      mode: "install",
      e,
      fetch: fakeRemote(V1).fetch,
      dryRun: true,
    });
    expect(result.targets.map((t) => t.outcome)).toEqual(
      Array(4).fill("installed")
    );
    expect(existsSync(agents)).toBe(false);
    expect(existsSync(e.dataDir)).toBe(false);
  });

  test("one bad download writes nothing at all, for any skill", async () => {
    await install();
    const v2: Files = {
      squirrelscan: { ...V1.squirrelscan, "references/a.md": "ref a v2" },
      "audit-website": {
        ...V1["audit-website"],
        "assets/icon.svg": "<svg v2/>",
      },
    };
    const bad = fakeRemote(v2, VERSIONS, {
      "squirrelscan/references/a.md": "tampered",
    });
    await expect(
      syncSkills({ mode: "update", e, fetch: bad.fetch })
    ).rejects.toThrow(/sha256/);
    expect(read(join(agents, "audit-website", "assets", "icon.svg"))).toBe(
      "<svg/>"
    );
    expect(read(join(claude, "squirrelscan", "references", "a.md"))).toBe(
      "ref a v1"
    );
  });

  test("an unreachable manifest throws before anything is touched", async () => {
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(
      syncSkills({ mode: "install", e, fetch: offline })
    ).rejects.toThrow();
    expect(existsSync(agents)).toBe(false);
  });

  test("a folder holding another author's skill of the same name is left alone", async () => {
    put(
      join(claude, "audit-website", "SKILL.md"),
      skillMd("audit-website", "9", "theirs", "someone")
    );
    const result = await install();
    expect(targetAt(result, join(claude, "audit-website"))?.outcome).toBe(
      "left-alone"
    );
    expect(read(join(claude, "audit-website", "SKILL.md"))).toContain("theirs");
  });
});

describe("update", () => {
  test("downloads only the files that changed", async () => {
    await install();
    const remote = fakeRemote(withA("ref a v2"), {
      ...VERSIONS,
      squirrelscan: "1.1",
    });
    const result = await syncSkills({ mode: "update", e, fetch: remote.fetch });

    expect(fileDownloads(remote.requests)).toEqual([
      `https://raw.githubusercontent.com/squirrelscan/skills/${SHA}/skills/squirrelscan/references/a.md`,
    ]);
    expect(read(join(claude, "squirrelscan", "references", "a.md"))).toBe(
      "ref a v2"
    );
    expect(
      result.targets.find((t) => t.skill === "audit-website")?.outcome
    ).toBe("current");
    expect(result.targets.find((t) => t.skill === "squirrelscan")?.from).toBe(
      "1.0"
    );
  });

  test("a file upstream dropped is removed; a user's own file stays", async () => {
    await install();
    put(join(agents, "squirrelscan", "my-notes.md"), "mine");
    const v2: Files = {
      ...V1,
      squirrelscan: { "SKILL.md": V1.squirrelscan!["SKILL.md"]! },
    };
    await syncSkills({ mode: "update", e, fetch: fakeRemote(v2).fetch });

    expect(existsSync(join(agents, "squirrelscan", "references"))).toBe(false);
    expect(read(join(agents, "squirrelscan", "my-notes.md"))).toBe("mine");
  });

  test("never installs a skill or a target that isn't there", async () => {
    put(
      join(agents, "audit-website", "SKILL.md"),
      skillMd("audit-website", "1.9")
    );
    await syncSkills({ mode: "update", e, fetch: fakeRemote(V1).fetch });

    expect(existsSync(join(agents, "squirrelscan"))).toBe(false);
    expect(existsSync(join(claude, "audit-website"))).toBe(false);
    expect(read(join(agents, "audit-website", "assets", "icon.svg"))).toBe(
      "<svg/>"
    );
  });

  test("nothing installed: no network at all", async () => {
    const remote = fakeRemote(V1);
    const result = await syncSkills({
      mode: "update",
      e,
      fetch: remote.fetch,
    });
    expect(result.targets).toEqual([]);
    expect(remote.requests).toEqual([]);
  });

  test("an edit upstream also changed is kept by default and reported stale", async () => {
    await install();
    put(join(agents, "squirrelscan", "references", "a.md"), "my edit");
    const result = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(withA("ref a v2")).fetch,
    });

    const t = targetAt(result, join(agents, "squirrelscan"));
    expect(t?.stale).toEqual(["references/a.md"]);
    expect(t?.backups).toEqual([]);
    expect(read(join(agents, "squirrelscan", "references", "a.md"))).toBe(
      "my edit"
    );
    expect(read(join(claude, "squirrelscan", "references", "a.md"))).toBe(
      "ref a v2"
    );
    // Still edited, and still out of date, next time.
    const again = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(withA("ref a v2")).fetch,
    });
    expect(targetAt(again, join(agents, "squirrelscan"))?.stale).toEqual([
      "references/a.md",
    ]);
  });

  test("--force backs the edit up, then replaces it", async () => {
    await install();
    put(join(agents, "squirrelscan", "references", "a.md"), "my edit");
    const result = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(withA("ref a v2")).fetch,
      force: true,
    });
    const t = targetAt(result, join(agents, "squirrelscan"));
    expect(t?.outcome).toBe("updated");
    expect(t?.backups).toHaveLength(1);
    expect(t!.backups[0]).toContain(join(e.dataDir, "skills", "backups"));
    expect(read(t!.backups[0]!)).toBe("my edit");
    expect(read(join(agents, "squirrelscan", "references", "a.md"))).toBe(
      "ref a v2"
    );
  });

  test("--force keeps one backup per target: a global and a project copy never share one", async () => {
    await install();
    await syncSkills({
      mode: "install",
      e,
      fetch: fakeRemote(V1).fetch,
      scope: "project",
      agents: ["claude"],
    });
    const projectA = join(e.cwd, ".claude", "skills", "squirrelscan");
    put(join(claude, "squirrelscan", "references", "a.md"), "GLOBAL EDIT");
    put(join(projectA, "references", "a.md"), "PROJECT EDIT");
    const result = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(withA("ref a v2")).fetch,
      force: true,
    });
    const backups = result.targets.flatMap((t) => t.backups);
    expect(new Set(backups).size).toBe(2);
    expect(backups.map((b) => read(b)).sort()).toEqual([
      "GLOBAL EDIT",
      "PROJECT EDIT",
    ]);
    expect(read(join(projectA, "references", "a.md"))).toBe("ref a v2");
  });

  test("a file upstream renamed by case alone ends up under its new name only", async () => {
    const before: Files = {
      ...V1,
      squirrelscan: { ...V1.squirrelscan, "references/Guide.md": "guide" },
    };
    await install(before);
    const after: Files = {
      ...V1,
      squirrelscan: { ...V1.squirrelscan, "references/guide.md": "guide" },
    };
    await syncSkills({ mode: "update", e, fetch: fakeRemote(after).fetch });
    for (const dir of [agents, claude]) {
      expect(
        readdirSync(join(dir, "squirrelscan", "references")).sort()
      ).toEqual(["a.md", "guide.md"]);
    }
    expect(
      Object.keys(
        readState(e).skills.squirrelscan![join(agents, "squirrelscan")]!.files
      ).sort()
    ).toEqual(["SKILL.md", "references/a.md", "references/guide.md"]);
  });

  test("a skill published after this CLI shipped is updated once installed", async () => {
    const withExtra: Files = {
      ...V1,
      extra: { "SKILL.md": skillMd("extra", "0.2") },
    };
    const versions = { ...VERSIONS, extra: "0.2" };
    put(join(agents, "extra", "SKILL.md"), skillMd("extra", "0.1"));
    const result = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(withExtra, versions).fetch,
    });
    expect(targetAt(result, join(agents, "extra"))?.outcome).toBe("adopted");
    expect(read(join(agents, "extra", "SKILL.md"))).toBe(
      skillMd("extra", "0.2")
    );
  });

  test("an edit to a file upstream didn't change is kept silently", async () => {
    await install();
    put(join(agents, "squirrelscan", "SKILL.md"), "my own SKILL.md");
    const result = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(withA("ref a v2")).fetch,
    });
    const t = targetAt(result, join(agents, "squirrelscan"));
    expect(t?.kept).toEqual(["SKILL.md"]);
    expect(t?.stale).toEqual([]);
    expect(read(join(agents, "squirrelscan", "SKILL.md"))).toBe(
      "my own SKILL.md"
    );
  });
});

describe("never writes through a link or over a folder", () => {
  test("a linked folder inside a skill blocks that target", async () => {
    await install();
    const outside = join(root, "outside");
    put(join(outside, "a.md"), "outside");
    rmSync(join(agents, "squirrelscan", "references"), { recursive: true });
    symlinkSync(outside, join(agents, "squirrelscan", "references"), "dir");

    const result = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(withA("ref a v2")).fetch,
    });
    expect(targetAt(result, join(agents, "squirrelscan"))?.outcome).toBe(
      "failed"
    );
    expect(read(join(outside, "a.md"))).toBe("outside");

    await uninstallSkills({ e });
    expect(read(join(outside, "a.md"))).toBe("outside");
  });

  test("a file that is a link blocks that target and the link's target is never touched", async () => {
    await install();
    const outside = join(root, "outside.md");
    put(outside, "outside");
    rmSync(join(agents, "squirrelscan", "references", "a.md"));
    symlinkSync(outside, join(agents, "squirrelscan", "references", "a.md"));
    const result = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(withA("ref a v2")).fetch,
    });
    expect(targetAt(result, join(agents, "squirrelscan"))?.outcome).toBe(
      "failed"
    );
    expect(read(outside)).toBe("outside");
  });

  test("a folder where a file goes blocks that target and loses nothing", async () => {
    await install();
    rmSync(join(agents, "squirrelscan", "references", "a.md"));
    put(
      join(agents, "squirrelscan", "references", "a.md", "precious.md"),
      "precious"
    );
    const result = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(withA("ref a v2")).fetch,
    });
    expect(targetAt(result, join(agents, "squirrelscan"))?.outcome).toBe(
      "failed"
    );
    expect(
      read(join(agents, "squirrelscan", "references", "a.md", "precious.md"))
    ).toBe("precious");
  });
});

describe("takeover of `npx skills` installs", () => {
  test("adopts the ~/.agents copy, replaces the Claude symlink, and leaves the npx lock", async () => {
    put(
      join(agents, "squirrelscan", "SKILL.md"),
      skillMd("squirrelscan", "0.9", "old")
    );
    put(join(agents, "squirrelscan", "references", "a.md"), "ref a v0");
    mkdirSync(claude, { recursive: true });
    symlinkSync(
      join(agents, "squirrelscan"),
      join(claude, "squirrelscan"),
      "dir"
    );
    const lock = join(e.home, ".agents", ".skill-lock.json");
    const other = { source: "someone/else", sourceType: "github" };
    put(
      lock,
      JSON.stringify({
        version: 3,
        skills: {
          squirrelscan: { source: "squirrelscan/squirrelscan" },
          other,
        },
      })
    );

    const result = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(V1).fetch,
    });

    expect(result.targets.map((t) => t.outcome)).toEqual([
      "adopted",
      "adopted",
    ]);
    expect(result.targets[0]?.from).toBe("0.9");
    expect(lstatSync(join(claude, "squirrelscan")).isSymbolicLink()).toBe(
      false
    );
    expect(read(join(claude, "squirrelscan", "references", "a.md"))).toBe(
      "ref a v1"
    );
    expect(read(join(agents, "squirrelscan", "references", "a.md"))).toBe(
      "ref a v1"
    );
    const backedUp = result.targets
      .flatMap((t) => t.backups)
      .map((b) => read(b));
    expect(backedUp.sort()).toEqual([
      skillMd("squirrelscan", "0.9", "old"),
      "ref a v0",
    ]);
    expect(Object.keys(JSON.parse(read(lock)).skills)).toEqual(["other"]);
    expect(result.lockCleaned[0]?.backup).toBe(`${lock}.bak`);
    expect(JSON.parse(read(`${lock}.bak`)).skills.squirrelscan).toBeDefined();
    expect(existsSync(join(agents, "audit-website"))).toBe(false);
  });

  test("the XDG lock is the one cleaned when XDG_STATE_HOME is set; an old lock is left alone", async () => {
    e.env.XDG_STATE_HOME = join(root, "state");
    const ours = {
      squirrelscan: { source: "squirrelscan/skills", sourceType: "github" },
    };
    const xdgLock = join(root, "state", "skills", ".skill-lock.json");
    put(xdgLock, JSON.stringify({ version: 3, skills: ours }));
    const homeLock = join(e.home, ".agents", ".skill-lock.json");
    put(homeLock, JSON.stringify({ version: 3, skills: ours }));
    await install();
    expect(JSON.parse(read(xdgLock)).skills).toEqual({});
    expect(JSON.parse(read(homeLock)).skills.squirrelscan).toBeDefined();

    put(xdgLock, JSON.stringify({ version: 2, skills: ours }));
    await syncSkills({ mode: "update", e, fetch: fakeRemote(V1).fetch });
    expect(JSON.parse(read(xdgLock)).skills.squirrelscan).toBeDefined();
  });

  test("the npx lock keeps someone else's entry of the same name", async () => {
    put(
      join(agents, "audit-website", "SKILL.md"),
      skillMd("audit-website", "9.9", "theirs", "someone")
    );
    const lock = join(e.home, ".agents", ".skill-lock.json");
    const theirs = { source: "someone/skills", sourceType: "github" };
    put(
      lock,
      JSON.stringify({
        version: 3,
        skills: {
          "audit-website": theirs,
          squirrelscan: {
            source: "https://github.com/squirrelscan/skills.git",
          },
        },
      })
    );
    await syncSkills({
      mode: "install",
      e,
      fetch: fakeRemote(V1).fetch,
      agents: ["claude"],
    });
    expect(JSON.parse(read(lock)).skills).toEqual({ "audit-website": theirs });
  });

  test("a symlink to a dev checkout is left alone", async () => {
    const checkout = join(root, "dev", "squirrelscan");
    put(join(checkout, "SKILL.md"), skillMd("squirrelscan", "dev"));
    mkdirSync(agents, { recursive: true });
    symlinkSync(checkout, join(agents, "squirrelscan"), "dir");

    const result = await install();
    expect(targetAt(result, join(agents, "squirrelscan"))?.outcome).toBe(
      "left-alone"
    );
    expect(lstatSync(join(agents, "squirrelscan")).isSymbolicLink()).toBe(true);
    expect(read(join(checkout, "SKILL.md"))).toBe(
      skillMd("squirrelscan", "dev")
    );
  });
});

describe("robustness", () => {
  test("leftovers from an interrupted run are cleared, and a copy moved aside mid-swap comes back", async () => {
    await install();
    const leftNew = join(agents, ".audit-website.squirrel-new-123-abc");
    put(join(leftNew, "SKILL.md"), "half built");
    // Died between its two renames: old moved aside, new not yet in place.
    rmSync(join(claude, "squirrelscan"), { recursive: true });
    put(
      join(claude, ".squirrelscan.squirrel-old-123-abc", "SKILL.md"),
      V1.squirrelscan!["SKILL.md"]!
    );
    put(join(claude, ".squirrelscan.squirrel-new-123-abc", "SKILL.md"), "new");

    await syncSkills({ mode: "update", e, fetch: fakeRemote(V1).fetch });
    expect(existsSync(leftNew)).toBe(false);
    expect(read(join(claude, "squirrelscan", "SKILL.md"))).toBe(
      V1.squirrelscan!["SKILL.md"]!
    );
    expect(readdirSync(claude).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("an old copy left by a finished swap never brings back a skill uninstalled since", async () => {
    await install();
    // The swap finished, but removing the previous copy failed.
    put(
      join(agents, ".audit-website.squirrel-old-9-xyz", "SKILL.md"),
      V1["audit-website"]!["SKILL.md"]!
    );
    await uninstallSkills({ e, skills: ["audit-website"] });

    await syncSkills({ mode: "update", e, fetch: fakeRemote(V1).fetch });
    expect(existsSync(join(agents, "audit-website"))).toBe(false);
    expect(readdirSync(agents).filter((n) => n.startsWith("."))).toEqual([]);
    expect(readState(e).skills["audit-website"]).toBeUndefined();
  });

  test("a lock left by a dead process doesn't block the next run", async () => {
    put(join(e.dataDir, "skills.lock"), "999999");
    await install();
    expect(existsSync(join(agents, "squirrelscan", "SKILL.md"))).toBe(true);
    expect(existsSync(join(e.dataDir, "skills.lock"))).toBe(false);
  });

  test("a live owner's lock, or a fresh one with no owner yet, means busy", async () => {
    const lock = join(e.dataDir, "skills.lock");
    put(lock, `${process.pid} someone-else`);
    await expect(install()).rejects.toThrow(SkillsBusyError);
    expect(read(lock)).toBe(`${process.pid} someone-else`);

    put(lock, "");
    await expect(install()).rejects.toThrow(SkillsBusyError);
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, longAgo, longAgo);
    await install();
    expect(existsSync(lock)).toBe(false);
  });
});

describe("status and uninstall", () => {
  test("status reports versions, latest, outdated and local edits", async () => {
    await install();
    put(join(claude, "squirrelscan", "SKILL.md"), "edited");
    const manifest = parseManifest(
      manifestFor(withA("v2"), { ...VERSIONS, squirrelscan: "1.1" }),
      SHA
    );
    const ss = skillsStatus(manifest, e).find(
      (s) => s.name === "squirrelscan"
    )!;
    expect(ss.latest).toBe("1.1");
    const byDir = Object.fromEntries(
      ss.targets.map((t) => [
        t.dir,
        [t.version, t.managedBy, t.editedFiles, t.outdated],
      ])
    );
    expect(byDir).toEqual({
      [join(agents, "squirrelscan")]: ["1.0", "squirrel", [], true],
      [join(claude, "squirrelscan")]: ["1.0", "squirrel", ["SKILL.md"], true],
    });
  });

  test("status says when a target can't be updated", async () => {
    await install();
    const outside = join(root, "outside");
    mkdirSync(outside);
    rmSync(join(agents, "squirrelscan", "references"), { recursive: true });
    symlinkSync(outside, join(agents, "squirrelscan", "references"), "dir");
    const manifest = parseManifest(manifestFor(withA("v2"), VERSIONS), SHA);
    const t = skillsStatus(manifest, e)
      .find((s) => s.name === "squirrelscan")!
      .targets.find((x) => x.dir === join(agents, "squirrelscan"));
    expect(t?.outdated).toBe(false);
    expect(t?.blocked).toContain("references");
  });

  test("uninstall removes only what squirrel wrote, for the chosen skills and agents", async () => {
    await install();
    put(join(agents, "squirrelscan", "SKILL.md"), "edited");
    put(join(claude, "audit-website", "mine.md"), "mine");
    const partial = await uninstallSkills({
      e,
      agents: ["agents"],
      skills: ["squirrelscan"],
    });
    expect(partial.kept).toEqual([join(agents, "squirrelscan", "SKILL.md")]);
    expect(existsSync(join(claude, "squirrelscan", "SKILL.md"))).toBe(true);

    const rest = await uninstallSkills({ e });
    expect(rest.emptied).toEqual([join(claude, "audit-website")]);
    expect(read(join(claude, "audit-website", "mine.md"))).toBe("mine");
    expect(existsSync(join(claude, "squirrelscan"))).toBe(false);
    expect(readState(e).skills).toEqual({});
  });

  test("a folder uninstall leaves behind for its edits is not taken back by updates, only by install", async () => {
    await install();
    const left = join(claude, "squirrelscan");
    // Still reads as our skill: the edit keeps the frontmatter.
    put(join(left, "SKILL.md"), skillMd("squirrelscan", "1.0", "my notes"));
    const out = await uninstallSkills({ e, agents: ["claude"] });
    expect(out.emptied).toContain(left);
    expect(readState(e).released).toEqual([left]);

    const newer = fakeRemote(withA("ref a v2"));
    const update = await syncSkills({ mode: "update", e, fetch: newer.fetch });
    expect(update.targets.map((t) => t.dir).sort()).toEqual([
      join(agents, "audit-website"),
      join(agents, "squirrelscan"),
    ]);
    expect(existsSync(join(left, "references"))).toBe(false);
    const leftStatus = skillsStatus(undefined, e)
      .find((s) => s.name === "squirrelscan")!
      .targets.find((t) => t.dir === left);
    expect(leftStatus).toMatchObject({ released: true, outdated: false });

    await syncSkills({
      mode: "install",
      e,
      fetch: newer.fetch,
      agents: ["claude"],
      skills: ["squirrelscan"],
    });
    expect(read(join(left, "references", "a.md"))).toBe("ref a v2");
    expect(readState(e).released).toBeUndefined();
  });

  test("status marks a copy squirrel did not install as out of date when update would take it over", async () => {
    put(join(claude, "squirrelscan", "SKILL.md"), V1.squirrelscan["SKILL.md"]!);
    const manifest = await fetchSkillsManifest({ fetch: fakeRemote(V1).fetch });
    const t = skillsStatus(manifest, e)
      .find((s) => s.name === "squirrelscan")!
      .targets.find((x) => x.dir === join(claude, "squirrelscan"));
    expect(t).toMatchObject({ managedBy: "unmanaged", outdated: true });
    const check = await syncSkills({
      mode: "update",
      e,
      fetch: fakeRemote(V1).fetch,
      dryRun: true,
    });
    expect(check.targets.map((x) => x.outcome)).toEqual(["adopted"]);
  });
});

describe("runSkillsAutoRefresh", () => {
  const auto = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    runSkillsAutoRefresh({
      e,
      fetch: fetchImpl,
      suppressed: () => null,
      enabled: () => true,
      ...extra,
    });

  test("updates what is installed, keeps local edits, stays out of project installs", async () => {
    await install();
    await syncSkills({
      mode: "install",
      e,
      fetch: fakeRemote(V1).fetch,
      scope: "project",
      agents: ["claude"],
    });
    put(join(claude, "squirrelscan", "references", "a.md"), "my edit");
    expect(await auto(fakeRemote(withA("ref a v2")).fetch)).toBe("done");

    expect(read(join(agents, "squirrelscan", "references", "a.md"))).toBe(
      "ref a v2"
    );
    expect(read(join(claude, "squirrelscan", "references", "a.md"))).toBe(
      "my edit"
    );
    expect(
      read(
        join(e.cwd, ".claude", "skills", "squirrelscan", "references", "a.md")
      )
    ).toBe("ref a v1");
  });

  test("files it backs up while taking over are reported by status afterwards", async () => {
    put(
      join(agents, "squirrelscan", "SKILL.md"),
      skillMd("squirrelscan", "0.9", "old")
    );
    expect(await auto(fakeRemote(V1).fetch)).toBe("done");
    expect(skillsNotices(e)).toHaveLength(1);
    expect(skillsNotices(e)[0]).toContain("backed up 1 file(s)");
    await syncSkills({ mode: "update", e, fetch: fakeRemote(V1).fetch });
    expect(skillsNotices(e)).toEqual([]);
  });

  test("nothing installed: no network, and once per version", async () => {
    const remote = fakeRemote(V1);
    expect(await auto(remote.fetch)).toBe("none_installed");
    expect(remote.requests).toEqual([]);
    await install();
    expect(await auto(fakeRemote(V1).fetch)).toBe("done");
    expect(await auto(fakeRemote(V1).fetch)).toBe("already_ran");
    expect(readdirSync(join(e.dataDir, "skills-refresh"))).toEqual([version]);
  });

  test("suppressed or opted out does nothing and claims nothing", async () => {
    await install();
    const remote = fakeRemote(V1);
    expect(
      await auto(remote.fetch, { suppressed: () => "running in CI" })
    ).toBe("suppressed");
    expect(await auto(remote.fetch, { enabled: () => false })).toBe("disabled");
    expect(existsSync(join(e.dataDir, "skills-refresh"))).toBe(false);
    expect(remote.requests).toEqual([]);
  });

  test("a hung network is cut off at the budget and the install is left as it was", async () => {
    await install();
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await auto(hang, { budgetMs: 50 })).toBe("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(read(join(agents, "squirrelscan", "references", "a.md"))).toBe(
      "ref a v1"
    );
  });
});

describe("maybeSpawnSkillsRefresh", () => {
  const settings = (overrides: Partial<UserSettings>): UserSettings =>
    ({
      auto_update: true,
      skills_auto_update: true,
      auto_update_applied: {
        from_version: "0.0.1",
        to_version: version,
        at: "x",
      },
      ...overrides,
    }) as UserSettings;
  const fakeSpawn = () => {
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> =
      [];
    const spawn = ((
      _cmd: string,
      args: string[],
      options: Record<string, unknown>
    ) => {
      calls.push({ args, options });
      return { once: () => {}, unref: () => {} };
    }) as unknown as typeof import("node:child_process").spawn;
    return { spawn, calls };
  };

  test("starts the detached refresh on the run that is the freshly updated version", () => {
    const fake = fakeSpawn();
    const markerDir = join(root, "markers");
    expect(
      maybeSpawnSkillsRefresh(settings({}), {
        spawn: fake.spawn,
        suppressed: () => null,
        markerDir,
      })
    ).toBe(true);
    expect(fake.calls[0]?.args).toEqual(["skills", "update", "--auto"]);
    expect(fake.calls[0]?.options).toMatchObject({
      detached: true,
      stdio: "ignore",
    });
  });

  test("stays out of the way otherwise", () => {
    const fake = fakeSpawn();
    const markerDir = join(root, "markers");
    const run = (s: UserSettings, suppressed: string | null = null) =>
      maybeSpawnSkillsRefresh(s, {
        spawn: fake.spawn,
        suppressed: () => suppressed,
        markerDir,
      });
    expect(run(settings({ auto_update_applied: null }))).toBe(false);
    expect(run(settings({ auto_update: false }))).toBe(false);
    expect(run(settings({ skills_auto_update: false }))).toBe(false);
    expect(run(settings({}), "SQUIRREL_NO_UPDATE is set")).toBe(false);
    put(join(markerDir, version), "");
    expect(run(settings({}))).toBe(false);
    expect(fake.calls).toEqual([]);
  });
});

describe("manifest", () => {
  const good = () => manifestFor(V1, VERSIONS);

  test("accepts the real shape", () => {
    expect(parseManifest(good(), SHA).skills.map((s) => s.name)).toEqual([
      "squirrelscan",
      "audit-website",
    ]);
  });

  test.each([
    ["a parent segment", "../escape.md"],
    ["an absolute path", "/etc/passwd"],
    ["a Windows separator", "refs\\a.md"],
    ["a Windows drive", "C:x.md"],
    ["a trailing dot Windows drops", "notes."],
    ["a Windows device name", "refs/CON.md"],
    ["an empty segment", "a//b.md"],
  ])("rejects %s", (_why, path) => {
    const doc = good();
    doc.skills[0]!.files.push({ path, sha256: "0".repeat(64), size: 1 });
    expect(() => parseManifest(doc, SHA)).toThrow(/unsafe path/);
    expect(isSafeRelativePath(path)).toBe(false);
  });

  test("rejects a file where another file needs a folder, no SKILL.md, a bad hash, a bad name", () => {
    const underFile = good();
    underFile.skills[0]!.files.push({
      path: "references",
      sha256: "0".repeat(64),
      size: 1,
    });
    expect(() => parseManifest(underFile, SHA)).toThrow(/sits under a file/);
    const noSkillMd = good();
    noSkillMd.skills[0]!.files = noSkillMd.skills[0]!.files.filter(
      (f) => f.path !== "SKILL.md"
    );
    expect(() => parseManifest(noSkillMd, SHA)).toThrow(/no SKILL.md/);
    const badHash = good();
    badHash.skills[0]!.files[0]!.sha256 = "xyz";
    expect(() => parseManifest(badHash, SHA)).toThrow(/bad sha256/);
    const badName = good();
    badName.skills[0]!.name = "../x";
    expect(() => parseManifest(badName, SHA)).toThrow(/bad skill name/);
  });

  test("resolves main from the ref advertisement, and falls back to main without it", async () => {
    expect(await resolveSkillsRef({ fetch: fakeRemote(V1).fetch })).toBe(SHA);
    const down = (async () =>
      new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await resolveSkillsRef({ fetch: down })).toBe("main");
  });

  test("a response bigger than it may be is refused, not read whole", async () => {
    const size = 3 * 1024 * 1024;
    const huge = (async () =>
      new Response("x".repeat(size), {
        headers: { "content-length": String(size) },
      })) as unknown as typeof fetch;
    await expect(fetchSkillsManifest({ fetch: huge })).rejects.toThrow(
      /too large/
    );
  });
});
