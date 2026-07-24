import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import {
  getSquirrelPaths,
  getSettingsPath,
  getProjectsPath,
  getCachePath,
  getReleasePath,
  getBinaryPath,
  getSymlinkPath,
  isBinInPath,
  findLocalSettingsPath,
} from "../../src/self/paths";

describe("getSquirrelPaths", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("returns SquirrelPaths interface", () => {
    const paths = getSquirrelPaths();
    expect(paths).toHaveProperty("data");
    expect(paths).toHaveProperty("config");
    expect(paths).toHaveProperty("bin");
    expect(paths).toHaveProperty("releases");
    expect(paths).toHaveProperty("projects");
    expect(paths).toHaveProperty("cache");
  });

  test("releases is subdirectory of data", () => {
    const paths = getSquirrelPaths();
    expect(paths.releases).toContain(paths.data);
    expect(paths.releases).toEndWith("releases");
  });

  test("projects is subdirectory of data", () => {
    const paths = getSquirrelPaths();
    expect(paths.projects).toContain(paths.data);
    expect(paths.projects).toEndWith("projects");
  });

  if (platform() !== "win32") {
    test("data uses ~/.squirrel (Unix)", () => {
      const paths = getSquirrelPaths();
      expect(paths.data).toEndWith(".squirrel");
    });

    test("config uses ~/.squirrel (Unix)", () => {
      const paths = getSquirrelPaths();
      expect(paths.config).toEndWith(".squirrel");
    });

    test("bin uses ~/.local/bin (Unix)", () => {
      const paths = getSquirrelPaths();
      expect(paths.bin).toContain(".local/bin");
    });

    test("cache uses system cache path (macOS: Library/Caches, Linux: .cache)", () => {
      const paths = getSquirrelPaths();
      const hasCaches =
        paths.cache.includes("Library/Caches") ||
        paths.cache.includes(".cache");
      expect(hasCaches).toBe(true);
      expect(paths.cache).toEndWith("squirrel");
    });
  }

  if (platform() === "win32") {
    test("uses LOCALAPPDATA on Windows", () => {
      const paths = getSquirrelPaths();
      expect(paths.data).toContain("squirrel");
      expect(paths.config).toContain("squirrel");
    });
  }
});

describe("getSettingsPath", () => {
  test("returns path ending in settings.json", () => {
    const path = getSettingsPath();
    expect(path).toEndWith("settings.json");
  });

  test("is under config directory", () => {
    const paths = getSquirrelPaths();
    const settingsPath = getSettingsPath();
    expect(settingsPath).toContain(paths.config);
  });
});

describe("getProjectsPath", () => {
  test("returns projects directory path", () => {
    const path = getProjectsPath();
    expect(path).toEndWith("projects");
  });

  test("matches getSquirrelPaths().projects", () => {
    const paths = getSquirrelPaths();
    expect(getProjectsPath()).toBe(paths.projects);
  });
});

describe("getCachePath", () => {
  test("returns cache directory path", () => {
    const path = getCachePath();
    // Windows: %LOCALAPPDATA%\squirrel\cache (ends with "cache")
    // Unix: ~/Library/Caches/squirrel or ~/.cache/squirrel (ends with "squirrel")
    if (platform() === "win32") {
      expect(path).toEndWith("cache");
    } else {
      expect(path).toEndWith("squirrel");
    }
  });

  test("matches getSquirrelPaths().cache", () => {
    const paths = getSquirrelPaths();
    expect(getCachePath()).toBe(paths.cache);
  });
});

describe("getReleasePath", () => {
  test("includes version in path", () => {
    const path = getReleasePath("1.2.3");
    expect(path).toContain("1.2.3");
    expect(path).toContain("releases");
  });

  test("handles beta versions", () => {
    const path = getReleasePath("1.0.0-beta");
    expect(path).toContain("1.0.0-beta");
  });
});

describe("getBinaryPath", () => {
  test("includes version in path", () => {
    const path = getBinaryPath("1.2.3");
    expect(path).toContain("1.2.3");
  });

  if (platform() === "win32") {
    test("has .exe extension on Windows", () => {
      const path = getBinaryPath("1.0.0");
      expect(path).toEndWith(".exe");
    });
  } else {
    test("has no extension on Unix", () => {
      const path = getBinaryPath("1.0.0");
      expect(path).toEndWith("squirrel");
      expect(path).not.toContain(".exe");
    });
  }
});

describe("getSymlinkPath", () => {
  test("is under bin directory", () => {
    const paths = getSquirrelPaths();
    const symlinkPath = getSymlinkPath();
    expect(symlinkPath).toContain(paths.bin);
  });

  if (platform() === "win32") {
    test("has .exe extension on Windows", () => {
      const path = getSymlinkPath();
      expect(path).toEndWith(".exe");
    });
  } else {
    test("has no extension on Unix", () => {
      const path = getSymlinkPath();
      expect(path).toEndWith("squirrel");
    });
  }
});

describe("isBinInPath", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  test("returns true when bin is in PATH", () => {
    const paths = getSquirrelPaths();
    const separator = platform() === "win32" ? ";" : ":";
    process.env.PATH = `${paths.bin}${separator}${originalPath}`;
    expect(isBinInPath()).toBe(true);
  });

  test("returns false when bin not in PATH", () => {
    process.env.PATH = "/some/other/path";
    expect(isBinInPath()).toBe(false);
  });
});

describe("findLocalSettingsPath", () => {
  const originalCwd = process.cwd();
  let base: string;

  afterEach(() => {
    process.chdir(originalCwd);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("returns ok(null) when no .squirrel/settings.json exists up to home", () => {
    base = mkdtempSync(join(tmpdir(), "sq-local-settings-"));
    const child = join(base, "child");
    mkdirSync(child, { recursive: true });
    process.chdir(child);

    const result = findLocalSettingsPath();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  test("returns ok(path) for the nearest ancestor .squirrel/settings.json", () => {
    base = mkdtempSync(join(tmpdir(), "sq-local-settings-"));
    const child = join(base, "child");
    mkdirSync(join(base, ".squirrel"), { recursive: true });
    mkdirSync(child, { recursive: true });
    const settingsPath = join(base, ".squirrel", "settings.json");
    writeFileSync(settingsPath, "{}");
    process.chdir(child);

    const result = findLocalSettingsPath();
    expect(result.ok).toBe(true);
    // process.cwd() resolves symlinks (e.g. macOS /var -> /private/var), so
    // compare the suffix rather than the raw tmpdir()-based path.
    if (result.ok)
      expect(result.data).toEndWith(join(".squirrel", "settings.json"));
  });

  // #1057: existsSync() on an ancestor dir's settings.json returns false for
  // EACCES too (same class of bug as #1037's settings-file case), which used
  // to make the walk silently keep climbing as if that level simply had no
  // settings — instead of surfacing the fact that it couldn't be checked.
  // Root ignores permission bits, so this would be a no-op under a root-run
  // sandbox/CI container.
  test.skipIf(process.getuid?.() === 0)(
    "returns err (not a silent skip-and-continue) when a parent dir can't be stat'd (EACCES)",
    () => {
      base = mkdtempSync(join(tmpdir(), "sq-local-settings-"));
      const blocked = join(base, "blocked");
      const child = join(blocked, "child");
      mkdirSync(child, { recursive: true });
      process.chdir(child);
      // Remove execute permission so stat() on anything under `blocked`
      // (including blocked/.squirrel/settings.json) fails with EACCES.
      chmodSync(blocked, 0o000);
      try {
        const result = findLocalSettingsPath();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("EACCES");
      } finally {
        // Restore so afterEach's rmSync can clean up.
        chmodSync(blocked, 0o700);
      }
    }
  );
});
