/**
 * The published description of the agent skills: squirrelscan/skills'
 * manifest.json (every skill's version, every file's sha256 and size), and the
 * files it lists. Fetched over plain HTTPS from GitHub, no API and no token.
 *
 * Everything is read at one commit. `main` is resolved through git's smart
 * HTTP ref advertisement (no API rate limit), then the manifest and every file
 * come from raw.githubusercontent.com/<owner>/<repo>/<sha>/. Raw `main` URLs
 * are CDN-cached per URL for minutes, so right after a push a branch-named
 * manifest and branch-named files can disagree; pinned URLs cannot.
 */
import { version as cliVersion } from "../../package.json";

export const SKILLS_REPOSITORY = "squirrelscan/skills";
const REFS_URL = `https://github.com/${SKILLS_REPOSITORY}.git/info/refs?service=git-upload-pack`;
const RAW_BASE = `https://raw.githubusercontent.com/${SKILLS_REPOSITORY}`;

// Sanity bounds on what a manifest may ask us to write. The real skills are a
// few dozen KB; anything near these is a broken or hostile manifest.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_SKILL = 500;
const MAX_MANIFEST_BYTES = 1024 * 1024;
// The ref advertisement lists every branch and pull-request ref, so it grows.
const MAX_REFS_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
// Names Windows reserves in any folder, with or without an extension.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface ManifestFile {
  /** Relative to the skill directory, "/"-separated. */
  path: string;
  sha256: string;
  size: number;
}

export interface ManifestSkill {
  name: string;
  version: string;
  files: ManifestFile[];
}

export interface SkillsManifest {
  /** The commit everything was read at, or "main" when it couldn't be pinned. */
  ref: string;
  skills: ManifestSkill[];
}

export interface FetchDeps {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export class SkillsFetchError extends Error {}

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * A manifest path is written under the skill directory, so it must stay there:
 * relative, "/"-separated, no empty/"."/".." segment, nothing a Windows path
 * would read as a drive, a stream or a reserved character.
 */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 255) return false;
  // Separators and characters Windows can't hold, plus control characters.
  if (/[\\:*?"<>|]/.test(path)) return false;
  if ([...path].some((c) => c.charCodeAt(0) < 0x20)) return false;
  return path
    .split("/")
    .every(
      (s) =>
        s !== "" &&
        s !== "." &&
        s !== ".." &&
        !/[. ]$/.test(s) &&
        !WINDOWS_DEVICE.test(s)
    );
}

/** Validate a parsed manifest.json, or throw saying what is wrong with it. */
export function parseManifest(raw: unknown, ref: string): SkillsManifest {
  const fail = (why: string): never => {
    throw new SkillsFetchError(`skills manifest is invalid: ${why}`);
  };
  const doc = raw as { schema?: unknown; skills?: unknown } | null;
  if (!doc || doc.schema !== 1) fail("unsupported schema");
  if (!Array.isArray(doc!.skills) || !doc!.skills.length) fail("no skills");

  const skills: ManifestSkill[] = [];
  const names = new Set<string>();
  for (const entry of doc!.skills as Array<Record<string, unknown>>) {
    const name = entry?.name;
    if (typeof name !== "string" || !SKILL_NAME.test(name))
      fail("bad skill name");
    if (names.has(name as string)) fail(`duplicate skill ${name}`);
    names.add(name as string);
    const version = entry.version;
    if (typeof version !== "string" || !version || version.length > 64) {
      fail(`${name}: bad version`);
    }
    const files = entry.files;
    if (
      !Array.isArray(files) ||
      !files.length ||
      files.length > MAX_FILES_PER_SKILL
    ) {
      fail(`${name}: bad file list`);
    }
    const seen = new Set<string>();
    let total = 0;
    const parsed: ManifestFile[] = [];
    for (const f of files as Array<Record<string, unknown>>) {
      const { path, sha256, size } = f ?? {};
      if (typeof path !== "string" || !isSafeRelativePath(path)) {
        fail(`${name}: unsafe path ${JSON.stringify(path)}`);
      }
      if (seen.has((path as string).toLowerCase()))
        fail(`${name}: duplicate path ${path}`);
      seen.add((path as string).toLowerCase());
      if (typeof sha256 !== "string" || !SHA256.test(sha256))
        fail(`${name}/${path}: bad sha256`);
      if (
        !Number.isSafeInteger(size) ||
        (size as number) < 0 ||
        (size as number) > MAX_FILE_BYTES
      ) {
        fail(`${name}/${path}: bad size`);
      }
      total += size as number;
      parsed.push({
        path: path as string,
        sha256: sha256 as string,
        size: size as number,
      });
    }
    if (total > MAX_SKILL_BYTES) fail(`${name}: too large`);
    if (!parsed.some((f) => f.path === "SKILL.md"))
      fail(`${name}: no SKILL.md`);
    // A path that is also another path's directory can't be written as both.
    for (const f of parsed) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        if (seen.has(parts.slice(0, i).join("/").toLowerCase())) {
          fail(`${name}: ${f.path} sits under a file`);
        }
      }
    }
    skills.push({
      name: name as string,
      version: version as string,
      files: parsed,
    });
  }
  return { ref, skills };
}

/** The body, refused past `max` bytes instead of read whole into memory. */
async function readCapped(
  response: Response,
  max: number
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    throw new SkillsFetchError(`response too large (${declared} bytes)`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new SkillsFetchError(`response too large (over ${max} bytes)`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function request(url: string, deps: FetchDeps): Promise<Response> {
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (deps.signal) signals.push(deps.signal);
  return (deps.fetch ?? fetch)(url, {
    headers: { "User-Agent": `squirrel/${cliVersion}` },
    signal: AbortSignal.any(signals),
  });
}

/**
 * The commit `main` points at, read from git's smart-HTTP ref advertisement.
 * Falls back to "main" when that fails: the files are hash-verified anyway, so
 * the worst an unpinned read can do is fail and leave the install as it was.
 */
export async function resolveSkillsRef(deps: FetchDeps = {}): Promise<string> {
  try {
    const response = await request(REFS_URL, deps);
    if (response.ok) {
      // pkt-lines: "<len><sha> <ref>", the first one followed by NUL + caps.
      const text = new TextDecoder().decode(
        await readCapped(response, MAX_REFS_BYTES)
      );
      for (const line of text.split("\n")) {
        const ref = line.split(String.fromCharCode(0))[0] ?? "";
        const match = ref.match(/([0-9a-f]{40}) refs\/heads\/main$/);
        if (match?.[1]) return match[1];
      }
    }
  } catch (error) {
    if (deps.signal?.aborted) throw error;
  }
  return "main";
}

export async function fetchSkillsManifest(
  deps: FetchDeps = {}
): Promise<SkillsManifest> {
  const ref = await resolveSkillsRef(deps);
  const response = await request(`${RAW_BASE}/${ref}/manifest.json`, deps);
  if (!response.ok) {
    throw new SkillsFetchError(
      `could not fetch the skills manifest (HTTP ${response.status})`
    );
  }
  const body = await readCapped(response, MAX_MANIFEST_BYTES);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new SkillsFetchError("the skills manifest is not JSON");
  }
  return parseManifest(raw, ref);
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** One skill file at the manifest's commit, or throw if its bytes don't match. */
export async function downloadSkillFile(
  manifest: SkillsManifest,
  skill: string,
  file: ManifestFile,
  deps: FetchDeps = {}
): Promise<Uint8Array> {
  const path = ["skills", skill, ...file.path.split("/")]
    .map(encodeURIComponent)
    .join("/");
  const response = await request(`${RAW_BASE}/${manifest.ref}/${path}`, deps);
  if (!response.ok) {
    throw new SkillsFetchError(
      `could not download ${skill}/${file.path} (HTTP ${response.status})`
    );
  }
  const bytes = await readCapped(response, file.size);
  if (bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) {
    throw new SkillsFetchError(
      `${skill}/${file.path} does not match its sha256 in the manifest`
    );
  }
  return bytes;
}
