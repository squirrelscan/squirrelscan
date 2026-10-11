import { describe, expect, test } from "bun:test";

import {
  AGENT_SKILLS_BUNDLE,
  SKILL_LIMITS,
  type BundledSkill,
  agentSkillFiles,
  buildSkillEntries,
  readAgentSkillFile,
  skillUri,
} from "../src/agent-skills";

const sha = (bytes: Uint8Array) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;

describe("agent skills manifest", () => {
  test("digests and sizes cover the raw bytes, text and binary alike", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const text = "---\nname: demo\ndescription: d\n---\n\nhéllo\n";
    const bundle: BundledSkill[] = [
      {
        name: "demo",
        version: "1",
        frontmatter: { name: "demo", description: "d" },
        files: [
          { path: "SKILL.md", mimeType: "text/markdown", encoding: "utf8", content: text },
          {
            path: "assets/a.png",
            mimeType: "image/png",
            encoding: "base64",
            content: Buffer.from(png).toString("base64"),
          },
        ],
      },
    ];
    const [entry] = await buildSkillEntries(bundle);
    const textBytes = new TextEncoder().encode(text);
    expect(entry).toEqual({
      uri: "skill://demo/SKILL.md",
      frontmatter: { name: "demo", description: "d" },
      resources: [
        { uri: "skill://demo/SKILL.md", digest: sha(textBytes), size: textBytes.byteLength },
        { uri: "skill://demo/assets/a.png", digest: sha(png), size: png.byteLength },
      ],
    });
    const files = agentSkillFiles(bundle);
    expect(files.get("skill://demo/assets/a.png")?.contents).toEqual({
      uri: "skill://demo/assets/a.png",
      mimeType: "image/png",
      blob: Buffer.from(png).toString("base64"),
    });
  });

  test("the bundled skills are complete, named for their directory and within the limits", () => {
    expect(AGENT_SKILLS_BUNDLE.map((s) => s.name).sort()).toEqual(["audit-website", "squirrelscan"]);
    for (const skill of AGENT_SKILLS_BUNDLE) {
      expect(skill.frontmatter.name).toBe(skill.name);
      expect(typeof skill.frontmatter.description).toBe("string");
      expect(skill.files.map((f) => f.path)).toContain("SKILL.md");
      expect(skill.files.length).toBeLessThanOrEqual(SKILL_LIMITS.maxResources);
      const bytes = [...agentSkillFiles().values()]
        .filter((f) => f.skill === skill.name)
        .reduce((n, f) => n + f.bytes.byteLength, 0);
      expect(bytes).toBeLessThanOrEqual(SKILL_LIMITS.maxBytes);
    }
    expect(readAgentSkillFile(skillUri("squirrelscan", "SKILL.md"))).toBeDefined();
    expect(readAgentSkillFile("skill://squirrelscan/nope.md")).toBeUndefined();
  });
});
