/**
 * The squirrelscan agent skills over MCP: the Skills extension
 * (`io.modelcontextprotocol/skills`, SEP-2640).
 *
 * The skills are squirrelscan/skills, bundled at build time by
 * `scripts/bundle-agent-skills.ts` into `bundle.generated.ts`. Both MCP servers,
 * the local `squirrel mcp` and the hosted one, serve them from here, so a client
 * gets the same bytes from either. Nothing here is generated at request time and
 * nothing comes from a user: an entry's digests describe the exact bytes
 * `resources/read` returns, so a host can verify every file and bind its
 * approval to them.
 *
 * Runtime-neutral (Bun and Workers): no YAML parser (frontmatter is parsed at
 * bundle time) and WebCrypto for the digests.
 */
import type { BundledSkill, SkillEntry, SkillFileContents, SkillResource } from "./types";

import { AGENT_SKILLS_BUNDLE, AGENT_SKILLS_SOURCE } from "./bundle.generated";

export type {
  BundledSkill,
  BundledSkillFile,
  SkillEntry,
  SkillFileContents,
  SkillResource,
} from "./types";
export { AGENT_SKILLS_BUNDLE, AGENT_SKILLS_SOURCE };

/** The extension's identifier, declared under `capabilities.extensions`. */
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

/** The extension's per-skill limits: what every conforming host accepts. */
export const SKILL_LIMITS = { maxResources: 512, maxBytes: 16 * 1024 * 1024 } as const;

/**
 * `ttlMs` / `cacheScope` for `skills/list`, `skills/get` and the skill files.
 * The bundle only changes with a deploy or a CLI release, and nothing in it
 * depends on who is asking.
 */
export const SKILLS_CACHE = { ttlMs: 60 * 60 * 1000, cacheScope: "public" } as const;

/** `skill://<name>/<path>`, the extension's resource URI for a skill file. */
export function skillUri(skill: string, path: string): string {
  return `skill://${skill}/${path}`;
}

/** One served file: the URI it is read at and the exact bytes behind it. */
export interface SkillFile {
  uri: string;
  skill: string;
  path: string;
  mimeType: string;
  bytes: Uint8Array;
  contents: SkillFileContents;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let files: Map<string, SkillFile> | undefined;

/** Every file of every bundled skill, keyed by URI. */
export function agentSkillFiles(
  bundle: readonly BundledSkill[] = AGENT_SKILLS_BUNDLE,
): ReadonlyMap<string, SkillFile> {
  if (bundle === AGENT_SKILLS_BUNDLE && files) return files;
  const out = new Map<string, SkillFile>();
  for (const skill of bundle) {
    for (const file of skill.files) {
      const uri = skillUri(skill.name, file.path);
      const contents: SkillFileContents =
        file.encoding === "base64"
          ? { uri, mimeType: file.mimeType, blob: file.content }
          : { uri, mimeType: file.mimeType, text: file.content };
      const bytes =
        file.encoding === "base64"
          ? decodeBase64(file.content)
          : new TextEncoder().encode(file.content);
      out.set(uri, { uri, skill: skill.name, path: file.path, mimeType: file.mimeType, bytes, contents });
    }
  }
  if (bundle === AGENT_SKILLS_BUNDLE) files = out;
  return out;
}

/** `resources/read` contents for a skill file, or undefined when the URI is not one. */
export function readAgentSkillFile(uri: string): SkillFileContents | undefined {
  return agentSkillFiles().get(uri)?.contents;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The `skills/list` entries, one per bundled skill, sorted by name. Each
 * entry's `resources` lists every file of the skill, SKILL.md included, with
 * the digest and size of the bytes this module serves for it.
 */
export async function buildSkillEntries(
  bundle: readonly BundledSkill[] = AGENT_SKILLS_BUNDLE,
): Promise<SkillEntry[]> {
  const served = agentSkillFiles(bundle);
  return Promise.all(
    bundle.map(async (skill) => {
      const resources: SkillResource[] = await Promise.all(
        skill.files.map(async (file) => {
          const { uri, bytes } = served.get(skillUri(skill.name, file.path))!;
          return { uri, digest: `sha256:${await sha256(bytes)}`, size: bytes.byteLength };
        }),
      );
      return {
        uri: skillUri(skill.name, "SKILL.md"),
        frontmatter: skill.frontmatter as SkillEntry["frontmatter"],
        resources,
      };
    }),
  );
}

let entries: Promise<SkillEntry[]> | undefined;

/** {@link buildSkillEntries} over the bundle, computed once per process. */
export function agentSkillEntries(): Promise<SkillEntry[]> {
  entries ??= buildSkillEntries();
  return entries;
}

/** The entry for the skill whose SKILL.md is at `uri`, or undefined. */
export async function agentSkillEntry(uri: string): Promise<SkillEntry | undefined> {
  return (await agentSkillEntries()).find((entry) => entry.uri === uri);
}
