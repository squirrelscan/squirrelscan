#!/usr/bin/env bun
/**
 * Bundle the squirrelscan agent skills for the MCP Skills extension
 * (`io.modelcontextprotocol/skills`): both MCP servers, the local `squirrel mcp`
 * and the hosted one, serve these exact bytes, so they always agree.
 *
 * Reads a checkout of squirrelscan/skills (its `manifest.json` is the list of
 * files, the same list the CLI installs from), verifies every file against the
 * manifest's sha256 and size, parses each SKILL.md frontmatter once here (the
 * hosted server runs on Workers, which has no YAML parser), and writes
 * `packages/utils/src/agent-skills/bundle.generated.ts`.
 *
 *   bun run scripts/bundle-agent-skills.ts [--from <skills checkout>]
 *   bun run scripts/bundle-agent-skills.ts --check   # exit 1 when stale
 *
 * `--from` defaults to `../skills`, where the squirrelscan monorepo mounts the
 * skills repo next to this one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

interface Manifest {
  repository: string;
  skills: Array<{ name: string; version: string; files: ManifestFile[] }>;
}

const root = resolve(import.meta.dir, "..");
const fromIndex = process.argv.indexOf("--from");
const skillsRoot = resolve(fromIndex > 0 ? process.argv[fromIndex + 1]! : join(root, "..", "skills"));
const target = join(root, "packages", "utils", "src", "agent-skills", "bundle.generated.ts");

const MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".json": "application/json",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".ts": "text/typescript",
  ".js": "text/javascript",
};
const BINARY = new Set(["image/png", "image/jpeg", "image/webp"]);

function mimeType(path: string): string {
  const dot = path.lastIndexOf(".");
  const type = dot >= 0 ? MIME_TYPES[path.slice(dot).toLowerCase()] : undefined;
  if (!type) throw new Error(`no MIME type for ${path}: add its extension to MIME_TYPES`);
  return type;
}

/** The frontmatter between the leading `---` fences, parsed as YAML. */
function frontmatter(skillMd: string, skill: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillMd);
  if (!match) throw new Error(`${skill}/SKILL.md has no YAML frontmatter`);
  const parsed = Bun.YAML.parse(match[1]!) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${skill}/SKILL.md frontmatter is not a mapping`);
  }
  return parsed as Record<string, unknown>;
}

function git(args: string[]): string | null {
  const out = Bun.spawnSync(["git", ...args], { cwd: skillsRoot, stdout: "pipe", stderr: "pipe" });
  return out.exitCode === 0 ? out.stdout.toString().trim() : null;
}

const manifestPath = join(skillsRoot, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`No skills checkout at ${skillsRoot} (manifest.json missing). Pass --from <path>.`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

const skills = manifest.skills
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((skill) => {
    const files = skill.files
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => {
        const bytes = readFileSync(join(skillsRoot, "skills", skill.name, file.path));
        const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        if (sha256 !== file.sha256 || bytes.length !== file.size) {
          throw new Error(`${skill.name}/${file.path} does not match manifest.json: run the skills repo's manifest script`);
        }
        const type = mimeType(file.path);
        if (BINARY.has(type)) {
          return { path: file.path, mimeType: type, encoding: "base64" as const, content: bytes.toString("base64") };
        }
        // Served as `text`, which a client turns back into UTF-8: only exact if the
        // file round-trips, so anything else is served as a blob.
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${skill.name}/${file.path} does not round-trip as UTF-8`);
        return { path: file.path, mimeType: type, encoding: "utf8" as const, content: text };
      });
    // The extension's per-skill limits: a skill over either is not guaranteed
    // to load anywhere, so it is refused here rather than served.
    const total = skill.files.reduce((sum, f) => sum + f.size, 0);
    if (files.length > 512 || total > 16 * 1024 * 1024) {
      throw new Error(`${skill.name} has ${files.length} files / ${total} bytes: over the 512 files / 16 MiB per-skill limit`);
    }
    const skillMd = files.find((f) => f.path === "SKILL.md");
    if (!skillMd || skillMd.encoding !== "utf8") throw new Error(`${skill.name} has no SKILL.md`);
    const fm = frontmatter(skillMd.content, skill.name);
    if (fm.name !== skill.name) throw new Error(`${skill.name}/SKILL.md frontmatter name is ${String(fm.name)}`);
    if (typeof fm.description !== "string" || !fm.description) throw new Error(`${skill.name}/SKILL.md has no description`);
    return { name: skill.name, version: skill.version, frontmatter: fm, files };
  });

const source = {
  repository: manifest.repository,
  commit: git(["rev-parse", "HEAD"]) ?? "unknown",
};

// File contents and the commit sha read as high-entropy strings to the public
// repo's secret scan (detect-secrets): they are published skill files, so each
// such line carries the scanner's inline allowlist marker.
const allowlisted = (json: string) =>
  json.replace(/^(\s*"(?:content|commit)": .*)$/gm, "$1 // pragma: allowlist secret");

const output = `// GENERATED by scripts/bundle-agent-skills.ts from ${source.repository}. Do not edit.
// Regenerate after a skills change: bun run scripts/bundle-agent-skills.ts

import type { BundledSkill } from "./types";

export const AGENT_SKILLS_SOURCE = ${allowlisted(JSON.stringify(source, null, 2))} as const;

export const AGENT_SKILLS_BUNDLE: readonly BundledSkill[] = ${allowlisted(JSON.stringify(skills, null, 2))};
`;

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  // The commit line moves with every skills commit; the content is what matters.
  const strip = (s: string) => s.replace(/"commit": "[^"]*"/, '"commit": ""');
  if (strip(current) !== strip(output)) {
    console.error(`${target} is out of date with ${skillsRoot}. Run: bun run scripts/bundle-agent-skills.ts`);
    process.exit(1);
  }
  console.log(`Agent skills bundle is up to date (${skills.length} skills).`);
} else {
  await Bun.write(target, output);
  console.log(`Wrote ${skills.length} skills (${skills.reduce((n, s) => n + s.files.length, 0)} files) to ${target}`);
}
