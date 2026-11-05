// #1599: the user-level allowlist pins a plugin to one file by path AND content
// hash. A bare id approves nothing; the project config can only select among
// pinned files; what is imported is exactly what was hashed.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { loadConfiguredPlugins } from "@/audit/plugins";

// Under the OS temp dir, which is a symlink on macOS: realpath is part of what is tested.
const root = mkdtempSync(join(tmpdir(), "squirrel-plugin-pin-1599-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const markerOf = (name: string) => join(root, `${name}.marker`);

let seq = 0;
let projectDir = "";
let pluginDir = "";
let settingsPath = "";

beforeEach(() => {
  seq += 1;
  projectDir = join(root, `project-${seq}`);
  pluginDir = join(root, `plugins-${seq}`);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(pluginDir, { recursive: true });
  settingsPath = join(root, `settings-${seq}.json`);
});

/** Source of a plugin that leaves a marker file when evaluated and registers one rule. */
function pluginSource(label: string): string {
  return `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerOf(`${label}-${seq}`))}, "ran");
export default {
  name: ${JSON.stringify(label)},
  version: "1",
  capabilities: ["rules"],
  register(ctx) {
    ctx.registerRule({
      meta: { id: "acme/${label}", name: "n", description: "d", category: "content", scope: "page", severity: "warning", weight: 1 },
      run() { return { checks: [] }; },
    });
  },
};
`;
}

const ran = (label: string) => existsSync(markerOf(`${label}-${seq}`));

function write(path: string, text: string): string {
  writeFileSync(path, text);
  return path;
}

function settings(allow: unknown[]): void {
  writeFileSync(settingsPath, JSON.stringify({ plugin_allowlist: allow }));
}

function load(entry: string, id = "acme-pack") {
  return loadConfiguredPlugins(
    { enabled: true, items: [{ id, entry, allow: ["rules"] }] },
    { baseDir: projectDir, settingsPath, tmpRoot: root }
  );
}

const ruleIds = (r: Awaited<ReturnType<typeof load>>) =>
  r.snapshot.rules.map((x) => x.meta.id);

describe("pinned plugin allowlist (#1599)", () => {
  test("a pin with the right path and hash loads the plugin", async () => {
    const src = pluginSource("good");
    const file = write(join(pluginDir, "good.ts"), src);
    settings([{ id: "acme-pack", entry: file, sha256: sha(src) }]);
    const r = await load(file);
    expect(ruleIds(r)).toEqual(["acme/good"]);
    expect(ran("good")).toBe(true);
    expect(r.notices).toEqual([]);
  });

  test("a bare string id approves nothing, never imports the file, and says how to approve", async () => {
    const src = pluginSource("bare");
    const file = write(join(projectDir, "bare.ts"), src);
    settings(["acme-pack"]);
    const r = await load("./bare.ts");
    expect(ruleIds(r)).toEqual([]);
    expect(ran("bare")).toBe(false);
    const said = r.notices.join("\n");
    expect(said).toContain('"acme-pack"');
    expect(said).toContain("plugin_allowlist");
    expect(said).toContain(realpathSync(file));
    expect(said).toContain(sha(src));
  });

  test("an object entry without a sha256 approves nothing", async () => {
    const src = pluginSource("nosha");
    const file = write(join(pluginDir, "nosha.ts"), src);
    settings([{ id: "acme-pack", entry: file }]);
    const r = await load(file);
    expect(ruleIds(r)).toEqual([]);
    expect(ran("nosha")).toBe(false);
    expect(r.notices.join("\n")).toContain("sha256");
  });

  test("a wrong hash loads nothing and imports nothing", async () => {
    const src = pluginSource("wronghash");
    const file = write(join(pluginDir, "wronghash.ts"), src);
    settings([{ id: "acme-pack", entry: file, sha256: sha("something else") }]);
    const r = await load(file);
    expect(ruleIds(r)).toEqual([]);
    expect(ran("wronghash")).toBe(false);
    expect(r.notices.join("\n")).toContain("changed");
  });

  test("a malformed hash loads nothing", async () => {
    const src = pluginSource("malformed");
    const file = write(join(pluginDir, "malformed.ts"), src);
    settings([{ id: "acme-pack", entry: file, sha256: "abc" }]);
    const r = await load(file);
    expect(ruleIds(r)).toEqual([]);
    expect(ran("malformed")).toBe(false);
  });

  test("a file changed after it was pinned loads nothing", async () => {
    const original = pluginSource("v1");
    const file = write(join(pluginDir, "changed.ts"), original);
    settings([{ id: "acme-pack", entry: file, sha256: sha(original) }]);
    expect(ruleIds(await load(file))).toEqual(["acme/v1"]);
    // Same path, new content: the pin no longer matches.
    write(file, pluginSource("v2"));
    const r = await load(file);
    expect(ruleIds(r)).toEqual([]);
    expect(ran("v2")).toBe(false);
    expect(r.notices.join("\n")).toContain("changed");
  });

  test("a symlinked entry resolves to the pinned file and loads", async () => {
    const src = pluginSource("linked");
    const file = write(join(pluginDir, "linked.ts"), src);
    const link = join(projectDir, "link.ts");
    symlinkSync(file, link);
    settings([{ id: "acme-pack", entry: file, sha256: sha(src) }]);
    expect(ruleIds(await load("./link.ts"))).toEqual(["acme/linked"]);
  });

  test("a pin written through a symlinked directory still matches the real file", async () => {
    const src = pluginSource("pinlink");
    const file = write(join(pluginDir, "pinlink.ts"), src);
    const linkedDir = join(root, `linkdir-${seq}`);
    symlinkSync(pluginDir, linkedDir);
    settings([
      {
        id: "acme-pack",
        entry: join(linkedDir, "pinlink.ts"),
        sha256: sha(src),
      },
    ]);
    expect(ruleIds(await load(file))).toEqual(["acme/pinlink"]);
  });

  test("a symlink in the project that points at a different file than the pin is refused", async () => {
    const good = pluginSource("pinned");
    const evil = pluginSource("evilsym");
    const goodFile = write(join(pluginDir, "pinned.ts"), good);
    const evilFile = write(join(projectDir, "evil-real.ts"), evil);
    symlinkSync(evilFile, join(projectDir, "looks-like-good.ts"));
    settings([{ id: "acme-pack", entry: goodFile, sha256: sha(good) }]);
    const r = await load("./looks-like-good.ts");
    expect(ruleIds(r)).toEqual([]);
    expect(ran("evilsym")).toBe(false);
  });

  test("a relative pin is rejected, even when it would resolve to the entry from the cwd", async () => {
    const src = pluginSource("relpin");
    const file = write(join(pluginDir, "relpin.ts"), src);
    const rel = relative(process.cwd(), file);
    settings([{ id: "acme-pack", entry: rel, sha256: sha(src) }]);
    const r = await load(file);
    expect(ruleIds(r)).toEqual([]);
    expect(ran("relpin")).toBe(false);
    expect(r.notices.join("\n")).toContain("absolute");
  });

  test("a pin for a file that does not exist approves nothing", async () => {
    const src = pluginSource("ghostpin");
    const file = write(join(pluginDir, "ghostpin.ts"), src);
    settings([
      { id: "acme-pack", entry: join(pluginDir, "nope.ts"), sha256: sha(src) },
    ]);
    const r = await load(file);
    expect(ruleIds(r)).toEqual([]);
    expect(ran("ghostpin")).toBe(false);
  });

  test("the cloned-repo exploit: the allowlist pins the good file, the project config names ./evil.ts under the same id", async () => {
    const good = pluginSource("trusted");
    const goodFile = write(join(pluginDir, "trusted.ts"), good);
    write(join(projectDir, "evil.ts"), pluginSource("exploit"));
    settings([{ id: "acme-pack", entry: goodFile, sha256: sha(good) }]);
    const r = await load("./evil.ts");
    expect(ruleIds(r)).toEqual([]);
    expect(ran("exploit")).toBe(false);
    expect(ran("trusted")).toBe(false);
    expect(r.notices.join("\n")).toContain("different file");
  });

  test("the cloned-repo exploit with a bare id allowlist entry", async () => {
    write(join(projectDir, "evil.ts"), pluginSource("exploit2"));
    settings(["acme-pack"]);
    const r = await load("./evil.ts");
    expect(ruleIds(r)).toEqual([]);
    expect(ran("exploit2")).toBe(false);
  });

  test("a swap between the hash check and the import cannot run different code", async () => {
    const good = pluginSource("swapgood");
    const file = write(join(pluginDir, "swap.ts"), good);
    settings([{ id: "acme-pack", entry: file, sha256: sha(good) }]);
    const r = await loadConfiguredPlugins(
      {
        enabled: true,
        items: [{ id: "acme-pack", entry: file, allow: ["rules"] }],
      },
      {
        baseDir: projectDir,
        settingsPath,
        tmpRoot: root,
        // The hash has passed; an attacker now overwrites the file on disk.
        afterVerify: () => write(file, pluginSource("swapevil")),
      }
    );
    expect(ruleIds(r)).toEqual(["acme/swapgood"]);
    expect(ran("swapgood")).toBe(true);
    expect(ran("swapevil")).toBe(false);
  });

  test("the verified copy is removed after the load, on success and on failure", async () => {
    const leftovers = () =>
      readdirSync(root).filter(
        (n) =>
          n.startsWith("squirrel-plugin-") && n !== relative(tmpdir(), root)
      );
    const before = leftovers();
    const good = pluginSource("clean");
    const file = write(join(pluginDir, "clean.ts"), good);
    settings([{ id: "acme-pack", entry: file, sha256: sha(good) }]);
    await load(file);
    const broken = `export default { name: "b", version: "1", capabilities: [], register() { throw new Error("nope"); } };`;
    const brokenFile = write(join(pluginDir, "broken.ts"), broken);
    settings([{ id: "acme-pack", entry: brokenFile, sha256: sha(broken) }]);
    await expect(load(brokenFile)).rejects.toThrow('"acme-pack"');
    expect(leftovers()).toEqual(before);
  });

  test("a pinned plugin that fails to register stops the load, naming the plugin", async () => {
    const broken = `export default { name: "b", version: "1", capabilities: [], async register() { await 0; throw new Error("late failure"); } };`;
    const file = write(join(pluginDir, "late.ts"), broken);
    settings([{ id: "acme-pack", entry: file, sha256: sha(broken) }]);
    await expect(load(file)).rejects.toThrow(/"acme-pack".*late failure/);
  });

  test("a file: URL entry is held to the same pin", async () => {
    const src = pluginSource("fileurl");
    const file = write(join(pluginDir, "fileurl.ts"), src);
    settings([{ id: "acme-pack", entry: file, sha256: sha(src) }]);
    expect(ruleIds(await load(`file://${file}`))).toEqual(["acme/fileurl"]);
    const other = write(
      join(projectDir, "other.ts"),
      pluginSource("fileurl-evil")
    );
    expect(ruleIds(await load(`file://${other}`))).toEqual([]);
    expect(ran("fileurl-evil")).toBe(false);
  });
});
