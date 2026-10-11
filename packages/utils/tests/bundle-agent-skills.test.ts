// The agent-skills bundler (`scripts/bundle-agent-skills.ts`), run against a
// synthetic squirrelscan/skills checkout: what it writes, that `--check` passes
// on a fresh bundle and fails on a stale one, and the skills it refuses.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/bundle-agent-skills.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A skills checkout with one skill, and its manifest.json describing the files. */
function checkout(files: Record<string, string | Uint8Array>, manifestOverrides: { version?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-skills-bundle-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, "skills", "demo", path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  const manifest = {
    schema: 1,
    repository: "squirrelscan/skills",
    skills: [
      {
        name: "demo",
        version: manifestOverrides.version ?? "1.0",
        files: Object.entries(files).map(([path, content]) => ({
          path,
          sha256: sha(typeof content === "string" ? Buffer.from(content) : content),
          size: typeof content === "string" ? Buffer.byteLength(content) : content.byteLength,
        })),
      },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return { dir, out: join(dir, "bundle.generated.ts") };
}

function run(args: string[]) {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stderr: proc.stderr.toString() };
}

const SKILL_MD = '---\nname: demo\ndescription: "A demo skill"\nmetadata:\n  version: "1.0"\n---\n\n# Demo\n';

describe("bundle-agent-skills", () => {
  test("writes text and binary files, and --check passes until a file changes", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { dir, out } = checkout({ "SKILL.md": SKILL_MD, "assets/icon.png": png, "references/a.md": "# A\n" });
    expect(run(["--from", dir, "--out", out]).code).toBe(0);

    const { AGENT_SKILLS_BUNDLE } = (await import(out)) as typeof import("../src/agent-skills");
    const [skill] = AGENT_SKILLS_BUNDLE;
    expect(skill?.frontmatter).toEqual({ name: "demo", description: "A demo skill", metadata: { version: "1.0" } });
    expect(skill?.files.map((f) => [f.path, f.encoding])).toEqual([
      ["assets/icon.png", "base64"],
      ["references/a.md", "utf8"],
      ["SKILL.md", "utf8"],
    ]);

    expect(run(["--from", dir, "--out", out, "--check"]).code).toBe(0);
    // A reference edited (with manifest.json regenerated) but not rebundled: stale.
    const edited = checkout({ "SKILL.md": SKILL_MD, "assets/icon.png": png, "references/a.md": "# A, edited\n" });
    const stale = run(["--from", edited.dir, "--out", out, "--check"]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("out of date");
  });

  test("refuses a file that does not match manifest.json", () => {
    const { dir, out } = checkout({ "SKILL.md": SKILL_MD });
    writeFileSync(join(dir, "skills", "demo", "SKILL.md"), `${SKILL_MD}tampered\n`);
    const result = run(["--from", dir, "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not match manifest.json");
  });

  test("refuses a skill over the extension's 512-file limit", () => {
    const files: Record<string, string> = { "SKILL.md": SKILL_MD };
    for (let i = 0; i < 512; i++) files[`references/r${i}.md`] = `# ${i}\n`;
    const { dir, out } = checkout(files);
    const result = run(["--from", dir, "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("over the 512 files / 16 MiB per-skill limit");
  });

  test.each([
    ["no description", "---\nname: demo\n---\n", "has no description"],
    ["a name that is not the directory", "---\nname: other\ndescription: d\n---\n", "frontmatter name is other"],
    ["no frontmatter", "# Demo\n", "has no YAML frontmatter"],
  ])("refuses a SKILL.md with %s", (_label, skillMd, message) => {
    const { dir, out } = checkout({ "SKILL.md": skillMd });
    const result = run(["--from", dir, "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});
