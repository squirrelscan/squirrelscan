/** One file of a bundled skill, as `scripts/bundle-agent-skills.ts` wrote it. */
export interface BundledSkillFile {
  /** Relative to the skill's directory, "/"-separated. */
  path: string;
  mimeType: string;
  /** `utf8` files are served as `text`, `base64` ones as `blob`. */
  encoding: "utf8" | "base64";
  content: string;
}

/** One skill from squirrelscan/skills, bundled at build time. */
export interface BundledSkill {
  name: string;
  version: string;
  /** SKILL.md's YAML frontmatter, parsed once at bundle time, every field kept. */
  frontmatter: Record<string, unknown>;
  files: BundledSkillFile[];
}

/** A file of a skill, with the digest and size of the bytes `resources/read` serves. */
export interface SkillResource {
  uri: string;
  /** `sha256:` and 64 lowercase hex characters. */
  digest: string;
  size: number;
}

/** A `skills/list` / `skills/get` entry (the extension's `Skill`). */
export interface SkillEntry {
  /** URI of the skill's SKILL.md. */
  uri: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  resources: SkillResource[];
}

/** `resources/read` contents for one skill file. */
export type SkillFileContents =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string };
