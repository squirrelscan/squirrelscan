#!/usr/bin/env bun
/**
 * Mirror the agent skills from github.com/squirrelscan/skills into skills/.
 *
 * squirrelscan/skills is the canonical source of the squirrelscan agent skills:
 * `npx skills add squirrelscan/skills` and `/plugin marketplace add
 * squirrelscan/skills` install from it, and skill changes land there first.
 * This repo keeps a copy under skills/ only because its own plugin manifests
 * ship local files: the Claude Code marketplace (`source: "./"`) and the Cursor
 * plugin (`skills: ./skills`).
 *
 * The copy is one way. Never edit skills/ here and never sync it back upstream:
 * syncs used to run in that direction, and the next one would have deleted the
 * entity map guidance that only exists upstream.
 *
 * Everything under upstream skills/ is copied byte for byte, executable bit
 * included, and anything here that upstream does not have is removed. The one
 * local file is skills/README.md, the mirror notice. Both modes refuse (exit 2)
 * an upstream SKILL.md whose frontmatter the skills CLI could not parse, so a
 * broken skill fails the gate instead of shipping in the plugins.
 *
 *   bun run scripts/sync-skills.ts                   # mirror squirrelscan/skills main
 *   bun run scripts/sync-skills.ts --ref <ref>       # a branch, tag or full commit sha
 *   bun run scripts/sync-skills.ts --check           # no writes, exit 1 on drift
 *   bun run scripts/sync-skills.ts --repo ../skills  # a local clone instead of GitHub
 */
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..");
const MIRROR_DIR = "skills";
const UPSTREAM_REPO = "https://github.com/squirrelscan/skills.git";
const DEFAULT_REF = "main";
// The mirror notice. Local to this repo: never compared, never removed.
const NOTICE = "README.md";
// OS litter a local checkout picks up. Not content, so not drift.
const IGNORED = new Set([".DS_Store"]);

export interface MirrorFile {
  bytes: Uint8Array;
  executable: boolean;
  // false for a symlink or anything else that is not a plain file, which
  // upstream never ships, so it always counts as drift.
  regular: boolean;
}

// Keyed by path relative to skills/, "/"-separated.
export type Tree = Map<string, MirrorFile>;

export interface Plan {
  add: string[];
  update: string[];
  remove: string[];
}

function git(args: string[], cwd?: string): Uint8Array {
  const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString().trim()}`);
  }
  return out.stdout;
}

// git fetch needs a URL for --depth to apply to a local clone.
function repoUrl(repo: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.startsWith("git@")
    ? repo
    : `file://${resolve(repo)}`;
}

/** Read upstream skills/ at `ref` without touching any checkout. */
export async function readUpstream(
  repo: string,
  ref: string,
): Promise<{ sha: string; tree: Tree }> {
  const tmp = await mkdtemp(join(tmpdir(), "sync-skills-"));
  try {
    git(["init", "-q", tmp]);
    // `--` so a --repo or --ref value can never be read as a git option.
    git(["fetch", "-q", "--depth", "1", "--no-tags", "--", repoUrl(repo), ref], tmp);
    // ^{commit}: an annotated tag's FETCH_HEAD is the tag object, not the commit.
    const sha = new TextDecoder().decode(git(["rev-parse", "FETCH_HEAD^{commit}"], tmp)).trim();
    const listing = new TextDecoder().decode(
      git(["ls-tree", "-r", "-z", "FETCH_HEAD", "--", `${MIRROR_DIR}/`], tmp),
    );
    const tree: Tree = new Map();
    for (const entry of listing.split("\0")) {
      if (!entry) continue;
      // <mode> SP <type> SP <oid> TAB <path>
      const tab = entry.indexOf("\t");
      const [mode, type, oid] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1).slice(MIRROR_DIR.length + 1);
      const segments = path.split("/");
      if (IGNORED.has(segments.at(-1)!)) continue;
      // git rejects these on checkout, but a tree object can still carry them,
      // and joined onto skills/ they would write outside it.
      if (segments.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")) {
        throw new Error(`upstream path ${JSON.stringify(path)} is not a safe relative path`);
      }
      if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
        throw new Error(
          `upstream ${MIRROR_DIR}/${path} is a ${mode} ${type}; only plain files mirror`,
        );
      }
      if (path === NOTICE) {
        throw new Error(
          `upstream now ships ${MIRROR_DIR}/${NOTICE}, which collides with this repo's mirror notice. ` +
            `Move the notice before syncing.`,
        );
      }
      tree.set(path, {
        bytes: git(["cat-file", "blob", oid!], tmp),
        executable: mode === "100755",
        regular: true,
      });
    }
    if (tree.size === 0) throw new Error(`upstream ${ref} has no ${MIRROR_DIR}/ directory`);
    return { sha, tree };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Refuse to mirror a skill that installers would drop. The skills CLI parses
 * SKILL.md frontmatter as YAML and skips the whole skill, with only a warning,
 * when that fails or name/description are not strings. An unquoted description
 * containing ": " is enough to do it, and upstream shipped exactly that once.
 */
export function assertInstallable(tree: Tree): void {
  const decoder = new TextDecoder();
  for (const [path, file] of tree) {
    const [dir, name, ...rest] = path.split("/");
    if (name !== "SKILL.md" || rest.length) continue;
    const where = `upstream ${MIRROR_DIR}/${path}`;
    const block = decoder.decode(file.bytes).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!block) throw new Error(`${where} has no YAML frontmatter block`);
    let data: unknown;
    try {
      data = Bun.YAML.parse(block[1] ?? "");
    } catch (err) {
      throw new Error(
        `${where} frontmatter is not valid YAML, so \`npx skills add\` would skip the skill ` +
          `(${err instanceof Error ? err.message : String(err)}). Quote the offending value upstream.`,
      );
    }
    const fields = (data ?? {}) as { name?: unknown; description?: unknown };
    if (typeof fields.name !== "string" || typeof fields.description !== "string") {
      throw new Error(`${where} frontmatter needs string name and description fields`);
    }
    // The Agent Skills spec requires the name to match the skill's directory.
    if (fields.name !== dir) {
      throw new Error(
        `${where} is named ${JSON.stringify(fields.name)}, not ${JSON.stringify(dir)}`,
      );
    }
  }
}

/** Read the local mirror, minus the notice and OS litter. */
export async function readMirror(root: string): Promise<Tree> {
  const base = join(root, MIRROR_DIR);
  const tree: Tree = new Map();
  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(join(base, rel), { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (path === NOTICE) continue;
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const full = join(base, path);
        const bytes = new Uint8Array(await Bun.file(full).arrayBuffer());
        tree.set(path, {
          bytes,
          executable: ((await lstat(full)).mode & 0o111) !== 0,
          regular: true,
        });
      } else {
        tree.set(path, { bytes: new Uint8Array(), executable: false, regular: false });
      }
    }
  }
  await walk("");
  return tree;
}

function same(a: MirrorFile, b: MirrorFile): boolean {
  return (
    a.regular && b.regular && a.executable === b.executable && Buffer.from(a.bytes).equals(b.bytes)
  );
}

export function planMirror(upstream: Tree, mirror: Tree): Plan {
  const plan: Plan = { add: [], update: [], remove: [] };
  for (const [path, file] of upstream) {
    const local = mirror.get(path);
    if (!local) plan.add.push(path);
    else if (!same(file, local)) plan.update.push(path);
  }
  for (const path of mirror.keys()) if (!upstream.has(path)) plan.remove.push(path);
  plan.add.sort();
  plan.update.sort();
  plan.remove.sort();
  return plan;
}

export async function applyPlan(root: string, upstream: Tree, plan: Plan): Promise<void> {
  const base = join(root, MIRROR_DIR);
  for (const path of plan.remove) {
    await rm(join(base, path), { force: true });
    // Prune directories the removal emptied (OS litter aside), stopping at
    // skills/ itself.
    let dir = dirname(join(base, path));
    while (dir !== base && (await readdir(dir)).every((name) => IGNORED.has(name))) {
      await rm(dir, { recursive: true, force: true });
      dir = dirname(dir);
    }
  }
  for (const path of [...plan.add, ...plan.update]) {
    const file = upstream.get(path)!;
    const full = join(base, path);
    // Clear whatever is in the way first: a symlink would make Bun.write follow
    // it out of skills/, and a leftover directory (empty, or holding only OS
    // litter) where upstream now has a file would make the write fail. rm does
    // not follow symlinks.
    await rm(full, { recursive: true, force: true });
    await mkdir(dirname(full), { recursive: true });
    await Bun.write(full, file.bytes);
    await chmod(full, file.executable ? 0o755 : 0o644);
  }
}

// Upstream paths this repo's .gitignore drops (it ignores AGENTS.md, CLAUDE.md
// and .claude/ at any depth, among others). A sync writes them to disk, so a
// local --check passes, but they never reach a commit and every clean checkout
// has drifted. Tracked files are never reported, so a force-add clears it.
function gitIgnored(root: string, paths: string[]): string[] {
  // Not a git checkout (the tests' scratch trees): no .gitignore to lose files to.
  const inRepo = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (inRepo.exitCode !== 0) return [];
  const out = Bun.spawnSync(["git", "check-ignore", "-z", "--stdin"], {
    cwd: root,
    stdin: new TextEncoder().encode(paths.map((p) => `${MIRROR_DIR}/${p}` + "\0").join("")),
    stdout: "pipe",
    stderr: "pipe",
  });
  // 0: some are ignored. 1: none are. Anything else is a failure, and a check
  // that fails quietly is one that stopped checking.
  if (out.exitCode === 1) return [];
  if (out.exitCode !== 0)
    throw new Error(`git check-ignore failed: ${out.stderr.toString().trim()}`);
  return out.stdout.toString().split("\0").filter(Boolean);
}

function summarize(plan: Plan): string[] {
  return [
    ...plan.add.map((p) => `  + ${MIRROR_DIR}/${p}`),
    ...plan.update.map((p) => `  ~ ${MIRROR_DIR}/${p}`),
    ...plan.remove.map((p) => `  - ${MIRROR_DIR}/${p}`),
  ];
}

export async function main(argv: string[], root = ROOT): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ref: { type: "string", default: DEFAULT_REF },
      repo: { type: "string", default: UPSTREAM_REPO },
      check: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const { ref, repo, check } = values as { ref: string; repo: string; check: boolean };

  const { sha, tree: upstream } = await readUpstream(repo, ref);
  assertInstallable(upstream);
  const plan = planMirror(upstream, await readMirror(root));
  const changes = summarize(plan);
  const at = `squirrelscan/skills@${sha.slice(0, 12)} (${ref})`;
  const ignored = gitIgnored(root, [...upstream.keys()]);
  const reportIgnored = () =>
    console.error(
      `.gitignore drops ${ignored.length} upstream file(s), so no commit can carry them:\n` +
        `${ignored.map((p) => `  ! ${p}`).join("\n")}\n` +
        `Add a negation for them to .gitignore (or git add -f), then commit.`,
    );

  if (check) {
    if (changes.length) {
      console.error(`${MIRROR_DIR}/ has drifted from ${at}:\n${changes.join("\n")}`);
      console.error(`Run: bun run scripts/sync-skills.ts --ref ${ref}`);
      return 1;
    }
    if (ignored.length) {
      reportIgnored();
      return 1;
    }
    console.log(`${MIRROR_DIR}/ matches ${at}.`);
    return 0;
  }

  if (changes.length) {
    await applyPlan(root, upstream, plan);
    console.log(`Mirrored ${at} into ${MIRROR_DIR}/:\n${changes.join("\n")}`);
    console.log(`Commit with: chore(skills): mirror squirrelscan/skills@${sha.slice(0, 12)}`);
  } else {
    console.log(`${MIRROR_DIR}/ already matches ${at}.`);
  }
  if (ignored.length) {
    reportIgnored();
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    // 2, not 1: a release gate must be able to tell "drifted" from "could not
    // check at all".
    console.error(`sync-skills: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
