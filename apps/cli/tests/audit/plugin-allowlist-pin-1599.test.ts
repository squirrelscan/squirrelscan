// #1599: the user-level allowlist pins a plugin to one file by path AND content
// hash. A bare id approves nothing; the project config can only select among
// pinned files; what is imported is exactly what was hashed.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import { loadConfiguredPlugins, MAX_PLUGIN_BYTES } from "@/audit/plugins";

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
    { baseDir: projectDir, settingsPath, cacheRoot: join(root, `cache-${seq}`) }
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
    // The unapproved file is not opened, so its hash is for the user to compute.
    expect(said).toContain("shasum -a 256");
    expect(said).not.toContain(sha(src));
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
        cacheRoot: join(root, `cache-${seq}`),
        // The hash has passed; an attacker now overwrites the file on disk.
        afterVerify: () => write(file, pluginSource("swapevil")),
      }
    );
    expect(ruleIds(r)).toEqual(["acme/swapgood"]);
    expect(ran("swapgood")).toBe(true);
    expect(ran("swapevil")).toBe(false);
  });

  test("the verified copy is removed after the load, on success and on failure", async () => {
    const cacheRoot = join(root, `cache-${seq}`);
    const entries = () => (existsSync(cacheRoot) ? readdirSync(cacheRoot) : []);
    const good = pluginSource("clean");
    const file = write(join(pluginDir, "clean.ts"), good);
    settings([{ id: "acme-pack", entry: file, sha256: sha(good) }]);
    await load(file);
    expect(entries()).toEqual([]);
    const broken = `export default { name: "b", version: "1", capabilities: [], register() { throw new Error("nope"); } };`;
    const brokenFile = write(join(pluginDir, "broken.ts"), broken);
    settings([{ id: "acme-pack", entry: brokenFile, sha256: sha(broken) }]);
    await expect(load(brokenFile)).rejects.toThrow('"acme-pack"');
    expect(entries()).toEqual([]);
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

  test("the copy lives in a 0700 directory inside a 0700 cache root that squirrel created", async () => {
    const cacheRoot = join(root, `cache-${seq}`, "nested", "plugin-cache");
    const probe = join(root, `probe-${seq}.json`);
    const src = `import { statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const dir = import.meta.dir;
writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ dir, mode: statSync(dir).mode & 0o777, parentMode: statSync(dirname(dir)).mode & 0o777 }));
export default { name: "p", version: "1", capabilities: [], register() {} };
`;
    const file = write(join(pluginDir, "probe.ts"), src);
    settings([{ id: "acme-pack", entry: file, sha256: sha(src) }]);
    await loadConfiguredPlugins(
      { enabled: true, items: [{ id: "acme-pack", entry: file, allow: [] }] },
      { baseDir: projectDir, settingsPath, cacheRoot }
    );
    const seen = JSON.parse(readFileSync(probe, "utf8")) as {
      dir: string;
      mode: number;
      parentMode: number;
    };
    expect(seen.dir.startsWith(realpathSync(cacheRoot))).toBe(true);
    expect(seen.mode).toBe(0o700);
    expect(seen.parentMode).toBe(0o700);
    expect(statSync(join(root, `cache-${seq}`, "nested")).mode & 0o777).toBe(
      0o700
    );
    expect(readdirSync(cacheRoot)).toEqual([]);
  });

  test("a cache root that others can write to is refused before anything is imported", async () => {
    const cacheRoot = join(root, `cache-${seq}`);
    mkdirSync(cacheRoot, { recursive: true });
    chmodSync(cacheRoot, 0o777);
    const src = pluginSource("loosecache");
    const file = write(join(pluginDir, "loosecache.ts"), src);
    settings([{ id: "acme-pack", entry: file, sha256: sha(src) }]);
    await expect(load(file)).rejects.toThrow(/plugin cache/);
    expect(ran("loosecache")).toBe(false);
  });

  test("a node_modules above the cache is refused: imports from the copy would walk into it", async () => {
    const planted = join(root, `nm-${seq}`);
    mkdirSync(join(planted, "node_modules", "plantedpkg"), { recursive: true });
    const src = pluginSource("ancestor");
    const file = write(join(pluginDir, "ancestor.ts"), src);
    settings([{ id: "acme-pack", entry: file, sha256: sha(src) }]);
    await expect(
      loadConfiguredPlugins(
        { enabled: true, items: [{ id: "acme-pack", entry: file, allow: [] }] },
        {
          baseDir: projectDir,
          settingsPath,
          cacheRoot: join(planted, "plugin-cache"),
        }
      )
    ).rejects.toThrow(/node_modules/);
    expect(ran("ancestor")).toBe(false);
  });

  // The cache must sit outside the OS temp dir for this to mean anything, so it goes in
  // the home directory (a uniquely named sibling that is removed afterwards).
  const homeHasNodeModules = (() => {
    let dir = homedir();
    for (;;) {
      if (existsSync(join(dir, "node_modules"))) return true;
      const up = join(dir, "..");
      if (up === dir) return false;
      dir = up;
    }
  })();

  test.skipIf(homeHasNodeModules)(
    "a node_modules planted in the OS temp dir is not resolved by the plugin",
    async () => {
      const pkg = `squirrel-planted-${process.pid}-${seq}`;
      const tmpNodeModules = join(tmpdir(), "node_modules");
      const hadNodeModules = existsSync(tmpNodeModules);
      const markerFile = join(root, `planted-${seq}.marker`);
      mkdirSync(join(tmpNodeModules, pkg), { recursive: true });
      writeFileSync(
        join(tmpNodeModules, pkg, "package.json"),
        JSON.stringify({ name: pkg, main: "index.js" })
      );
      writeFileSync(
        join(tmpNodeModules, pkg, "index.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "planted code ran");`
      );
      const homeBase = mkdtempSync(
        join(homedir(), ".squirrel-plugin-cache-test-")
      );
      try {
        const src = `import ${JSON.stringify(pkg)};
export default { name: "p", version: "1", capabilities: [], register() {} };
`;
        const file = write(join(pluginDir, "imports-planted.ts"), src);
        settings([{ id: "acme-pack", entry: file, sha256: sha(src) }]);
        await expect(
          loadConfiguredPlugins(
            {
              enabled: true,
              items: [{ id: "acme-pack", entry: file, allow: [] }],
            },
            {
              baseDir: projectDir,
              settingsPath,
              cacheRoot: join(homeBase, ".squirrel", "plugin-cache"),
            }
          )
        ).rejects.toThrow(/"acme-pack"/);
        expect(existsSync(markerFile)).toBe(false);
      } finally {
        rmSync(homeBase, { recursive: true, force: true });
        if (hadNodeModules)
          rmSync(join(tmpNodeModules, pkg), { recursive: true, force: true });
        else rmSync(tmpNodeModules, { recursive: true, force: true });
      }
    }
  );

  describe("config-named paths are not touched before approval", () => {
    const canFifo = process.platform !== "win32";
    const makeFifo = (path: string) => {
      const r = Bun.spawnSync(["mkfifo", path]);
      if (r.exitCode !== 0) throw new Error("mkfifo failed");
    };

    /** loadConfiguredPlugins in a child process, killed after 15 s. */
    async function inChild(entry: string, cacheName = `cache-${seq}`) {
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          join(import.meta.dir, "../helpers/load-plugins-child.ts"),
          JSON.stringify({
            entry,
            baseDir: projectDir,
            settingsPath,
            cacheRoot: join(root, cacheName),
          }),
        ],
        { stdout: "pipe", stderr: "pipe", cwd: join(import.meta.dir, "../..") }
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 15_000);
      const out = await new Response(child.stdout).text();
      await child.exited;
      clearTimeout(timer);
      const line = out.trim().split("\n").at(-1) ?? "";
      return {
        timedOut,
        result: timedOut
          ? undefined
          : (JSON.parse(line) as {
              rules?: number;
              notices?: string[];
              error?: string;
            }),
      };
    }

    test.skipIf(!canFifo)(
      "a FIFO named by the config with an empty allowlist returns promptly with a refusal",
      async () => {
        makeFifo(join(projectDir, "trap.ts"));
        settings([]);
        const { timedOut, result } = await inChild("./trap.ts");
        expect(timedOut).toBe(false);
        expect(result?.rules).toBe(0);
        expect(result?.notices?.join("\n")).toContain("not allowlisted");
      },
      30_000
    );

    test.skipIf(!canFifo)(
      "a FIFO named by the config under a bare-id allowlist is not opened either",
      async () => {
        makeFifo(join(projectDir, "trap2.ts"));
        settings(["acme-pack"]);
        const { timedOut, result } = await inChild("./trap2.ts");
        expect(timedOut).toBe(false);
        expect(result?.rules).toBe(0);
      },
      30_000
    );

    test.skipIf(!canFifo)(
      "a pinned file that is not a regular file (a FIFO) is refused, not read",
      async () => {
        const fifo = join(pluginDir, "pinned-fifo.ts");
        makeFifo(fifo);
        settings([{ id: "acme-pack", entry: fifo, sha256: sha("x") }]);
        const { timedOut, result } = await inChild(fifo);
        expect(timedOut).toBe(false);
        expect(result?.rules).toBe(0);
        expect(result?.notices?.join("\n")).toContain("regular file");
      },
      30_000
    );

    test.skipIf(process.platform === "win32")(
      "a pinned /dev/zero is refused as not a regular file",
      async () => {
        settings([{ id: "acme-pack", entry: "/dev/zero", sha256: sha("x") }]);
        const { timedOut, result } = await inChild("/dev/zero");
        expect(timedOut).toBe(false);
        expect(result?.rules).toBe(0);
        expect(result?.notices?.join("\n")).toContain("regular file");
      },
      30_000
    );

    test("a pinned directory is refused as not a regular file", async () => {
      const dir = join(pluginDir, "a-dir.ts");
      mkdirSync(dir);
      settings([{ id: "acme-pack", entry: dir, sha256: sha("x") }]);
      const r = await load(dir);
      expect(ruleIds(r)).toEqual([]);
      expect(r.notices.join("\n")).toContain("regular file");
    });

    test("a pinned file over the size cap is refused with a clear message and never imported", async () => {
      const big = `${pluginSource("big")}\n// ${"x".repeat(MAX_PLUGIN_BYTES)}\n`;
      const file = write(join(pluginDir, "big.ts"), big);
      settings([{ id: "acme-pack", entry: file, sha256: sha(big) }]);
      const r = await load(file);
      expect(ruleIds(r)).toEqual([]);
      expect(ran("big")).toBe(false);
      expect(r.notices.join("\n")).toContain("larger than 4 MiB");
    });
  });
});
