// scripts/sync-skills.ts keeps skills/ an exact one-way mirror of
// squirrelscan/skills. These run it against a throwaway upstream repo, so
// nothing here touches the network or this checkout's skills/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { main, planMirror, readMirror, readUpstream } from "./sync-skills";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

let dir: string;
let upstream: string;
let target: string;

function git(args: string[], cwd: string): void {
  const out = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
}

async function put(root: string, path: string, content: string | Uint8Array, mode = 0o644) {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await Bun.write(full, content);
  await chmod(full, mode);
}

async function commitUpstream(files: Record<string, string | Uint8Array>, exec: string[] = []) {
  for (const [path, content] of Object.entries(files)) {
    await put(upstream, path, content, exec.includes(path) ? 0o755 : 0o644);
  }
  git(["add", "-A"], upstream);
  git(["commit", "-q", "-m", "upstream"], upstream);
}

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, path)));
    else out.push(path);
  }
  return out.sort();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sync-skills-test-"));
  upstream = join(dir, "upstream");
  target = join(dir, "target");
  await mkdir(upstream, { recursive: true });
  git(["init", "-q", "-b", "main"], upstream);
  await commitUpstream(
    {
      "README.md": "# upstream repo readme, not mirrored\n",
      "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: a\n---\nnew\n",
      "skills/alpha/assets/icon.png": PNG,
      "skills/beta/run.sh": "#!/bin/sh\necho hi\n",
    },
    ["skills/beta/run.sh"],
  );
  await put(target, "skills/README.md", "mirror notice\n");
  await put(target, "skills/alpha/SKILL.md", "---\nname: alpha\ndescription: a\n---\nstale\n");
  await put(target, "skills/gone/SKILL.md", "removed upstream\n");
  await put(target, "skills/gone/references/x.md", "removed upstream\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sync-skills", () => {
  // The release gate reads the exit code, so pin it on the real entry point.
  // --check never writes, so running it against this checkout is safe.
  test("exits 1 on drift and 2 when it cannot check", () => {
    const script = join(import.meta.dir, "sync-skills.ts");
    const drift = Bun.spawnSync(["bun", script, "--check", "--repo", upstream], { stderr: "pipe" });
    expect(drift.exitCode).toBe(1);
    expect(drift.stderr.toString()).toContain("has drifted");
    const missing = Bun.spawnSync(["bun", script, "--check", "--repo", upstream, "--ref", "nope"], {
      stderr: "pipe",
    });
    expect(missing.exitCode).toBe(2);
    expect(Bun.spawnSync(["bun", script, "--bogus"], { stderr: "pipe" }).exitCode).toBe(2);
  });

  test("reads only upstream skills/, with bytes and the executable bit", async () => {
    const { sha, tree } = await readUpstream(upstream, "main");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect([...tree.keys()].sort()).toEqual([
      "alpha/SKILL.md",
      "alpha/assets/icon.png",
      "beta/run.sh",
    ]);
    expect(tree.get("alpha/assets/icon.png")?.bytes).toEqual(PNG);
    expect(tree.get("beta/run.sh")?.executable).toBe(true);
    expect(tree.get("alpha/SKILL.md")?.executable).toBe(false);
  });

  test("plans adds, updates and removals, and never counts the notice", async () => {
    const { tree } = await readUpstream(upstream, "main");
    const mirror = await readMirror(target);
    expect(mirror.has("README.md")).toBe(false);
    expect(planMirror(tree, mirror)).toEqual({
      add: ["alpha/assets/icon.png", "beta/run.sh"],
      update: ["alpha/SKILL.md"],
      remove: ["gone/SKILL.md", "gone/references/x.md"],
    });
  });

  test("--check exits 1 on drift and writes nothing", async () => {
    expect(await main(["--check", "--repo", upstream], target)).toBe(1);
    expect(await Bun.file(join(target, "skills/alpha/SKILL.md")).text()).toContain("stale");
    expect(await Bun.file(join(target, "skills/gone/SKILL.md")).exists()).toBe(true);
  });

  test("a sync makes skills/ an exact mirror, keeps the notice, then --check passes", async () => {
    expect(await main(["--repo", upstream], target)).toBe(0);
    expect(await listFiles(join(target, "skills"))).toEqual([
      "README.md",
      "alpha/SKILL.md",
      "alpha/assets/icon.png",
      "beta/run.sh",
    ]);
    expect(await Bun.file(join(target, "skills/README.md")).text()).toBe("mirror notice\n");
    expect(
      new Uint8Array(await Bun.file(join(target, "skills/alpha/assets/icon.png")).arrayBuffer()),
    ).toEqual(PNG);
    expect((await lstat(join(target, "skills/beta/run.sh"))).mode & 0o111).not.toBe(0);
    expect(await main(["--check", "--repo", upstream], target)).toBe(0);
  });

  test("a lost executable bit is drift", async () => {
    await main(["--repo", upstream], target);
    await chmod(join(target, "skills/beta/run.sh"), 0o644);
    expect(await main(["--check", "--repo", upstream], target)).toBe(1);
  });

  test("a local symlink is drift and the sync replaces it with the file", async () => {
    await main(["--repo", upstream], target);
    const outside = join(dir, "outside.txt");
    await Bun.write(outside, "outside\n");
    await rm(join(target, "skills/beta/run.sh"));
    await symlink(outside, join(target, "skills/beta/run.sh"));
    expect(await main(["--check", "--repo", upstream], target)).toBe(1);
    expect(await main(["--repo", upstream], target)).toBe(0);
    expect((await lstat(join(target, "skills/beta/run.sh"))).isSymbolicLink()).toBe(false);
    expect(await Bun.file(outside).text()).toBe("outside\n");
  });

  test("a local directory where upstream now has a file is replaced, OS litter and all", async () => {
    await mkdir(join(target, "skills/beta/run.sh"), { recursive: true });
    await Bun.write(join(target, "skills/beta/run.sh/.DS_Store"), "litter");
    expect(await main(["--repo", upstream], target)).toBe(0);
    expect((await lstat(join(target, "skills/beta/run.sh"))).isFile()).toBe(true);
    expect(await main(["--check", "--repo", upstream], target)).toBe(0);
  });

  test("a symlinked skill directory is replaced, never written through", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await rm(join(target, "skills/alpha"), { recursive: true });
    await symlink(outside, join(target, "skills/alpha"));
    expect(await main(["--repo", upstream], target)).toBe(0);
    expect((await lstat(join(target, "skills/alpha"))).isDirectory()).toBe(true);
    expect(await readdir(outside)).toEqual([]);
    expect(await main(["--check", "--repo", upstream], target)).toBe(0);
  });

  test("syncs a ref other than the default", async () => {
    const { sha: first } = await readUpstream(upstream, "main");
    await commitUpstream({
      "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: a\n---\nnewer\n",
    });
    expect(await main(["--repo", upstream, "--ref", first], target)).toBe(0);
    expect(await Bun.file(join(target, "skills/alpha/SKILL.md")).text()).toBe(
      "---\nname: alpha\ndescription: a\n---\nnew\n",
    );
    expect(await main(["--check", "--repo", upstream], target)).toBe(1);
  });

  test("fails when this repo's .gitignore would keep an upstream file out of every commit", async () => {
    git(["init", "-q", "-b", "main"], target);
    await Bun.write(join(target, ".gitignore"), "AGENTS.md\n");
    await commitUpstream({ "skills/alpha/AGENTS.md": "agent notes\n" });
    expect(await main(["--repo", upstream], target)).toBe(1);
    // Written, so a local --check sees no drift; the ignore rule is what fails it.
    expect(await Bun.file(join(target, "skills/alpha/AGENTS.md")).exists()).toBe(true);
    expect(await main(["--check", "--repo", upstream], target)).toBe(1);
    git(["add", "-f", "skills/alpha/AGENTS.md"], target);
    expect(await main(["--check", "--repo", upstream], target)).toBe(0);
  });

  test("refuses a SKILL.md whose frontmatter installers cannot parse, and writes nothing", async () => {
    await commitUpstream({
      "skills/alpha/SKILL.md":
        "---\nname: alpha\ndescription: Audits sites. Also covers the map: a graph.\n---\nbody\n",
    });
    await expect(main(["--repo", upstream], target)).rejects.toThrow(/not valid YAML/);
    await expect(main(["--check", "--repo", upstream], target)).rejects.toThrow(/not valid YAML/);
    expect(await Bun.file(join(target, "skills/alpha/SKILL.md")).text()).toContain("stale");
  });

  test("refuses a SKILL.md whose name does not match its directory", async () => {
    await commitUpstream({ "skills/alpha/SKILL.md": "---\nname: other\ndescription: x\n---\n" });
    await expect(main(["--repo", upstream], target)).rejects.toThrow(/not "alpha"/);
  });

  test("refuses an upstream skills/README.md, which would overwrite the notice", async () => {
    await commitUpstream({ "skills/README.md": "upstream readme\n" });
    await expect(readUpstream(upstream, "main")).rejects.toThrow(
      /collides with this repo's mirror notice/,
    );
  });

  test("refuses an upstream symlink rather than mirroring it as a file", async () => {
    await symlink("SKILL.md", join(upstream, "skills/alpha/link.md"));
    git(["add", "-A"], upstream);
    git(["commit", "-q", "-m", "link"], upstream);
    await expect(readUpstream(upstream, "main")).rejects.toThrow(/only plain files mirror/);
  });
});
