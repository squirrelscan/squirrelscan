// `squirrel self uninstall` deletes files, so these tests drive the real
// controller against a temp HOME and check both what goes and what stays.
//
// Bun reads `os.homedir()` once at process start and ignores a later
// `process.env.HOME`, so HOME alone would leave every squirrel path pointing at
// the developer's real ~/.squirrel. Mock the function itself (the pattern in
// tests/mcp/entity-tools.test.ts), and refuse to run a test at all unless the
// resolved paths are inside the temp HOME.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";

const realHomedir = realOs.homedir;

function osModule(homedirFn: () => string): Record<string, unknown> {
  const patched = { ...realOs, homedir: homedirFn };
  return { ...patched, default: patched };
}

let home = "";
mock.module("node:os", () => osModule(() => home));

afterAll(() => {
  mock.module("node:os", () => osModule(realHomedir));
});

const { getSquirrelPaths } = await import("@/self/paths");
const { executeUninstall, planUninstall, runSelfUninstall, isInside } =
  await import("@/controllers/self/uninstall");

// A scratch root holding the temp HOME and an "outside" tree next to it. The
// outside tree is what a hostile or stray symlink points at; nothing in it may
// ever be deleted.
let root: string;
let outside: string;
/** Where Windows-mode tests park the running exe: inside the scratch root. */
let aside: string;
const windows = () => ({ isWindows: true, asideDir: aside }) as const;
const originalEnv = { ...process.env };

interface Layout {
  data: string;
  releases: string;
  bin: string;
  link: string;
  settings: string;
  cache: string;
}

function layout(): Layout {
  const p = getSquirrelPaths();
  return {
    data: p.data,
    releases: p.releases,
    bin: p.bin,
    link: join(p.bin, "squirrel"),
    settings: join(p.data, "settings.json"),
    cache: p.cache,
  };
}

/** Lay out a managed install the way `self install` does. */
function install(versions: string[] = ["1.0.0"]): Layout {
  const l = layout();
  mkdirSync(l.bin, { recursive: true });
  for (const v of versions) {
    mkdirSync(join(l.releases, v), { recursive: true });
    writeFileSync(join(l.releases, v, "squirrel"), `binary-${v}`);
  }
  symlinkSync(join(l.releases, versions.at(-1)!, "squirrel"), l.link);
  writeFileSync(
    l.settings,
    JSON.stringify({ channel: "stable", auth: { token: "test-token" } }) // pragma: allowlist secret
  );
  mkdirSync(join(l.data, "projects", "example"), { recursive: true });
  writeFileSync(join(l.data, "projects", "example", "project.db"), "db");
  mkdirSync(l.cache, { recursive: true });
  writeFileSync(join(l.cache, "entry"), "cached");
  return l;
}

/** The running binary, as a managed install sees it. */
function managedExec(l: Layout, version = "1.0.0"): string {
  return join(l.releases, version, "squirrel");
}

/** Every path under `dir`, for "nothing else changed" comparisons. */
function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      out.push(full);
      if (e.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** A file's text, or "dir". One read per path, no check-then-use. */
function contentOf(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EISDIR") return "dir";
    throw error;
  }
}

beforeEach(() => {
  root = realpathSync(
    mkdtempSync(join(realOs.tmpdir(), "squirrel-uninstall-test-"))
  );
  home = join(root, "home");
  outside = join(root, "outside");
  mkdirSync(home);
  mkdirSync(join(outside, "precious"), { recursive: true });
  writeFileSync(join(outside, "precious", "keep.txt"), "do not delete");
  writeFileSync(join(outside, "squirrel"), "someone else's binary");
  aside = join(root, "aside");
  mkdirSync(aside);
  process.env = { ...originalEnv, HOME: home };
  delete process.env.XDG_CACHE_HOME;

  // Hard stop: never let a test run against the real home directory.
  const p = getSquirrelPaths();
  for (const path of [p.data, p.bin, p.releases, p.cache]) {
    if (!isInside(path, home, false)) {
      throw new Error(`squirrel path escaped the temp HOME: ${path}`);
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(root, { recursive: true, force: true });
});

const noPrompt = {
  isInteractive: false,
  recordedBinDir: null,
} as const;

describe("default uninstall", () => {
  test("removes the link and the release binaries, keeps settings, credentials and audits", async () => {
    const l = install(["1.0.0", "1.1.0"]);
    const result = await runSelfUninstall(
      { purge: false, yes: true },
      { ...noPrompt, execPath: managedExec(l, "1.1.0") }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("removed");
    expect(result.data.failed).toEqual([]);
    expect(() => lstatSync(l.link)).toThrow();
    expect(existsSync(l.releases)).toBe(false);
    expect(readFileSync(l.settings, "utf8")).toContain("test-token");
    expect(existsSync(join(l.data, "projects", "example", "project.db"))).toBe(
      true
    );
    expect(existsSync(l.cache)).toBe(true);
    expect(existsSync(l.bin)).toBe(true);
  });

  test("removes a dangling link whose release was pruned", async () => {
    const l = install(["1.0.0"]);
    rmSync(join(l.releases, "1.0.0"), { recursive: true });
    mkdirSync(join(l.releases, "1.1.0"));
    writeFileSync(join(l.releases, "1.1.0", "squirrel"), "binary-1.1.0");

    const result = await runSelfUninstall(
      { purge: false, yes: true },
      { ...noPrompt, execPath: managedExec(l, "1.1.0") }
    );

    expect(result.ok).toBe(true);
    expect(() => lstatSync(l.link)).toThrow();
  });

  test("removes the link in the recorded install_bin_dir as well as the default", async () => {
    const l = install(["1.0.0"]);
    const customBin = join(home, "custom-bin");
    mkdirSync(customBin);
    const customLink = join(customBin, "squirrel");
    symlinkSync(managedExec(l), customLink);

    const result = await runSelfUninstall(
      { purge: false, yes: true },
      {
        isInteractive: false,
        recordedBinDir: customBin,
        execPath: managedExec(l),
      }
    );

    expect(result.ok).toBe(true);
    expect(() => lstatSync(customLink)).toThrow();
    expect(() => lstatSync(l.link)).toThrow();
  });

  test("reads install_bin_dir from settings.json when not injected", async () => {
    const l = install(["1.0.0"]);
    const customBin = join(home, "custom-bin");
    mkdirSync(customBin);
    symlinkSync(managedExec(l), join(customBin, "squirrel"));
    writeFileSync(l.settings, JSON.stringify({ install_bin_dir: customBin }));

    const plan = planUninstall({ purge: false }, { execPath: managedExec(l) });
    expect(plan.targets.map((t) => t.path)).toContain(
      join(customBin, "squirrel")
    );
  });
});

describe("--purge", () => {
  test("also removes ~/.squirrel (settings, credentials, audits) and the cache", async () => {
    const l = install(["1.0.0"]);
    const result = await runSelfUninstall(
      { purge: true, yes: true },
      { ...noPrompt, execPath: managedExec(l) }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.failed).toEqual([]);
    expect(() => lstatSync(l.link)).toThrow();
    expect(existsSync(l.data)).toBe(false);
    expect(existsSync(l.cache)).toBe(false);
    // The bin dir is shared with other tools: only our link goes.
    expect(existsSync(l.bin)).toBe(true);
  });

  test("leaves a symlinked ~/.squirrel alone instead of following it", async () => {
    const elsewhere = join(outside, "dotfiles-squirrel");
    mkdirSync(join(elsewhere, "releases", "1.0.0"), { recursive: true });
    writeFileSync(join(elsewhere, "releases", "1.0.0", "squirrel"), "bin");
    writeFileSync(join(elsewhere, "settings.json"), "{}");
    symlinkSync(elsewhere, join(home, ".squirrel"));
    const l = layout();

    const plan = planUninstall(
      { purge: true },
      { ...noPrompt, execPath: managedExec(l) }
    );

    expect(plan.targets.some((t) => t.kind === "data")).toBe(false);
    expect(plan.skipped.map((s) => s.path)).toContain(l.data);
  });
});

describe("safety", () => {
  test("a target swapped between planning and deleting is left alone", () => {
    const l = install(["1.0.0"]);
    const plan = planUninstall(
      { purge: false },
      { ...noPrompt, execPath: managedExec(l) }
    );
    expect(plan.targets.map((t) => t.kind)).toContain("releases");

    // Same path, different directory: the dev/ino recorded at planning time
    // no longer matches, so the delete must not go ahead.
    // Rename the original aside rather than deleting it, so the filesystem
    // cannot hand its inode to the replacement.
    renameSync(l.releases, join(home, "releases-moved"));
    mkdirSync(join(l.releases, "swapped"), { recursive: true });
    writeFileSync(join(l.releases, "swapped", "keep.txt"), "not planned");

    const outcome = executeUninstall(plan, { isWindows: false });

    expect(outcome.failed.map((f) => f.path)).toContain(l.releases);
    expect(readFileSync(join(l.releases, "swapped", "keep.txt"), "utf8")).toBe(
      "not planned"
    );
  });

  test("never deletes a link that points outside the managed releases", async () => {
    const l = install(["1.0.0"]);
    rmSync(l.link);
    symlinkSync(join(outside, "squirrel"), l.link);

    const result = await runSelfUninstall(
      { purge: false, yes: true },
      { ...noPrompt, execPath: managedExec(l) }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lstatSync(l.link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "squirrel"), "utf8")).toBe(
      "someone else's binary"
    );
    expect(result.data.plan.skipped.map((s) => s.path)).toContain(l.link);
    // The release binaries were still ours to remove.
    expect(existsSync(l.releases)).toBe(false);
  });

  test("never deletes a dangling link whose text points outside the releases", async () => {
    const l = install(["1.0.0"]);
    rmSync(l.link);
    symlinkSync(join(outside, "gone"), l.link);

    const plan = planUninstall(
      { purge: false },
      { ...noPrompt, execPath: managedExec(l) }
    );
    expect(plan.targets.some((t) => t.path === l.link)).toBe(false);
    expect(plan.skipped.map((s) => s.path)).toContain(l.link);
  });

  test("never deletes a plain file at the link path on POSIX", async () => {
    const l = install(["1.0.0"]);
    rmSync(l.link);
    writeFileSync(l.link, "a hand-placed binary");

    const result = await runSelfUninstall(
      { purge: false, yes: true },
      { ...noPrompt, execPath: managedExec(l), isWindows: false }
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(l.link, "utf8")).toBe("a hand-placed binary");
  });

  test("a symlinked releases dir is skipped, not followed", async () => {
    const l = layout();
    mkdirSync(l.data, { recursive: true });
    mkdirSync(join(outside, "releases", "1.0.0"), { recursive: true });
    writeFileSync(join(outside, "releases", "1.0.0", "squirrel"), "bin");
    symlinkSync(join(outside, "releases"), l.releases);

    const plan = planUninstall(
      { purge: false },
      { ...noPrompt, execPath: join(outside, "releases", "1.0.0", "squirrel") }
    );
    expect(plan.targets.some((t) => t.kind === "releases")).toBe(false);
    expect(plan.skipped.map((s) => s.path)).toContain(l.releases);
  });

  test("a symlink inside releases is unlinked, its target survives", async () => {
    const l = install(["1.0.0"]);
    symlinkSync(join(outside, "precious"), join(l.releases, "1.0.0", "escape"));

    const result = await runSelfUninstall(
      { purge: true, yes: true },
      { ...noPrompt, execPath: managedExec(l) }
    );

    expect(result.ok).toBe(true);
    expect(existsSync(l.releases)).toBe(false);
    expect(readFileSync(join(outside, "precious", "keep.txt"), "utf8")).toBe(
      "do not delete"
    );
  });

  test("touches nothing outside the temp HOME", async () => {
    const l = install(["1.0.0", "2.0.0"]);
    symlinkSync(join(outside, "precious"), join(l.data, "linked-out"));
    symlinkSync(join(outside, "precious"), join(l.cache, "linked-out"));
    const before = snapshot(outside);
    const contents = before.map(contentOf);

    const result = await runSelfUninstall(
      { purge: true, yes: true },
      { ...noPrompt, execPath: managedExec(l, "2.0.0") }
    );

    expect(result.ok).toBe(true);
    expect(snapshot(outside)).toEqual(before);
    expect(before.map(contentOf)).toEqual(contents);
    // Inside HOME only the managed paths went; the shared bin dir stays.
    expect(existsSync(l.data)).toBe(false);
    expect(existsSync(l.cache)).toBe(false);
    expect(existsSync(l.bin)).toBe(true);
  });
});

describe("the running binary must be the managed install", () => {
  test("a binary outside the managed releases refuses and deletes nothing", async () => {
    const l = install(["1.0.0"]);
    const before = snapshot(home);

    const result = await runSelfUninstall(
      { purge: true, yes: true },
      { ...noPrompt, execPath: join(outside, "squirrel") }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_MANAGED_INSTALL");
    expect(snapshot(home)).toEqual(before);
    expect(lstatSync(l.link).isSymbolicLink()).toBe(true);
  });

  test("running through the managed symlink counts as managed", async () => {
    const l = install(["1.0.0"]);
    const result = await runSelfUninstall(
      { purge: false, yes: true },
      { ...noPrompt, execPath: l.link }
    );
    expect(result.ok).toBe(true);
    expect(existsSync(l.releases)).toBe(false);
  });

  test("Windows: the copy at the link path is removed when it is the running exe", async () => {
    const l = install(["1.0.0"]);
    rmSync(l.link);
    writeFileSync(l.link, "binary-1.0.0");
    // A leftover from a Windows self update (updater.ts renames exes aside).
    writeFileSync(`${l.link}.old-123`, "old");

    const result = await runSelfUninstall(
      { purge: false, yes: true },
      { ...noPrompt, ...windows(), execPath: l.link, pid: 999 }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.failed).toEqual([]);
    expect(existsSync(l.link)).toBe(false);
    expect(existsSync(`${l.link}.old-123`)).toBe(false);
    expect(existsSync(`${l.link}.old-999`)).toBe(false);
    expect(readdirSync(aside)).toEqual([]);
  });

  // A locked exe cannot be deleted, so it must be moved OUT of the tree
  // before that tree is deleted. The injected unlink plays the lock.
  const locked = (path: string) => {
    if (path.startsWith(aside)) {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), {
        code: "EBUSY",
      });
    }
    rmSync(path);
  };

  test("Windows: a running exe under releases (a real symlink) is moved out before releases goes", async () => {
    const l = install(["1.0.0"]);

    const result = await runSelfUninstall(
      { purge: false, yes: true },
      {
        ...noPrompt,
        ...windows(),
        execPath: managedExec(l),
        pid: 7,
        unlinkAside: locked,
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.failed).toEqual([]);
    expect(existsSync(l.releases)).toBe(false);
    const parked = join(aside, "squirrel-uninstalled-7-squirrel");
    expect(result.data.leftover).toEqual([parked]);
    expect(readFileSync(parked, "utf8")).toBe("binary-1.0.0");
  });

  test("Windows --purge: the running copy in the data dir's bin is moved out before the data dir goes", async () => {
    const l = install(["1.0.0"]);
    // Windows' default bin dir is %LOCALAPPDATA%\squirrel\bin, inside the
    // data dir; the recorded bin dir reproduces that layout here.
    const dataBin = join(l.data, "bin");
    mkdirSync(dataBin);
    const copy = join(dataBin, "squirrel");
    writeFileSync(copy, "binary-1.0.0");

    const result = await runSelfUninstall(
      { purge: true, yes: true },
      {
        ...windows(),
        isInteractive: false,
        recordedBinDir: dataBin,
        execPath: copy,
        pid: 8,
        unlinkAside: locked,
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.failed).toEqual([]);
    expect(existsSync(l.data)).toBe(false);
    expect(result.data.leftover).toEqual([
      join(aside, "squirrel-uninstalled-8-squirrel"),
    ]);
  });

  test("Windows: a copy that is not the running exe and lies outside the data dir is left alone", async () => {
    const l = install(["1.0.0"]);
    rmSync(l.link);
    writeFileSync(l.link, "someone else's exe");

    const plan = planUninstall(
      { purge: false },
      { ...noPrompt, execPath: managedExec(l), isWindows: true }
    );
    expect(plan.targets.some((t) => t.path === l.link)).toBe(false);
    expect(plan.skipped.map((s) => s.path)).toContain(l.link);
  });
});

describe("confirmation", () => {
  test("non-interactive without --yes refuses and deletes nothing", async () => {
    const l = install(["1.0.0"]);
    const before = snapshot(home);

    const result = await runSelfUninstall(
      { purge: false, yes: false },
      { ...noPrompt, execPath: managedExec(l) }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(snapshot(home)).toEqual(before);
  });

  test("interactive asks first and a no deletes nothing", async () => {
    const l = install(["1.0.0"]);
    const before = snapshot(home);
    let asked: string[] = [];

    const result = await runSelfUninstall(
      { purge: false, yes: false },
      {
        isInteractive: true,
        recordedBinDir: null,
        execPath: managedExec(l),
        confirm: async (plan) => {
          asked = plan.targets.map((t) => t.path);
          return false;
        },
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("cancelled");
    expect(asked).toEqual([l.link, l.releases]);
    expect(snapshot(home)).toEqual(before);
  });

  test("interactive yes deletes", async () => {
    const l = install(["1.0.0"]);
    const result = await runSelfUninstall(
      { purge: false, yes: false },
      {
        isInteractive: true,
        recordedBinDir: null,
        execPath: managedExec(l),
        confirm: async () => true,
      }
    );
    expect(result.ok).toBe(true);
    expect(existsSync(l.releases)).toBe(false);
  });

  test("--yes never calls the prompt", async () => {
    const l = install(["1.0.0"]);
    let called = false;
    const result = await runSelfUninstall(
      { purge: false, yes: true },
      {
        isInteractive: true,
        recordedBinDir: null,
        execPath: managedExec(l),
        confirm: async () => {
          called = true;
          return false;
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(called).toBe(false);
    expect(existsSync(l.releases)).toBe(false);
  });
});

describe("a missing install", () => {
  test("finds nothing to remove and succeeds, even from an unmanaged binary", async () => {
    const result = await runSelfUninstall(
      { purge: true, yes: false },
      { ...noPrompt, execPath: join(outside, "squirrel") }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("nothing-to-remove");
    expect(snapshot(home)).toEqual([]);
  });

  test("running it twice is idempotent", async () => {
    const l = install(["1.0.0"]);
    const deps = { ...noPrompt, execPath: managedExec(l) };

    const first = await runSelfUninstall({ purge: false, yes: true }, deps);
    const afterFirst = snapshot(home);
    const second = await runSelfUninstall({ purge: false, yes: true }, deps);

    expect(first.ok && first.data.status).toBe("removed");
    expect(second.ok && second.data.status).toBe("nothing-to-remove");
    expect(snapshot(home)).toEqual(afterFirst);
    expect(existsSync(l.settings)).toBe(true);
  });
});
