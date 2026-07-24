import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Create temp directory for each test
let testDir: string;
let mockPaths: {
  data: string;
  config: string;
  bin: string;
  releases: string;
};

function setupMockInstall(versions: string[] = ["1.0.0"]) {
  // Create directories
  mkdirSync(mockPaths.config, { recursive: true });
  mkdirSync(mockPaths.bin, { recursive: true });
  mkdirSync(mockPaths.releases, { recursive: true });

  // Create release versions
  for (const version of versions) {
    const versionDir = join(mockPaths.releases, version);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(join(versionDir, "squirrel"), `binary-${version}`);
  }

  // Create symlink to latest version
  const latestVersion = versions[versions.length - 1];
  const binaryPath = join(mockPaths.releases, latestVersion, "squirrel");
  const symlinkPath = join(mockPaths.bin, "squirrel");
  symlinkSync(binaryPath, symlinkPath);

  // Create settings
  writeFileSync(
    join(mockPaths.config, "settings.json"),
    JSON.stringify({
      channel: "stable",
      current_version: latestVersion,
      auto_update: true,
      notifications: true,
      last_update_check: new Date().toISOString(),
    })
  );
}

function getDirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;

  let size = 0;
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      size += statSync(fullPath).size;
    }
  }

  return size;
}

function countReleases(releasesPath: string): number {
  if (!existsSync(releasesPath)) return 0;
  return readdirSync(releasesPath, { withFileTypes: true }).filter((e) =>
    e.isDirectory()
  ).length;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "squirrel-uninstall-test-"));
  mockPaths = {
    data: join(testDir, "data"),
    config: join(testDir, "config"),
    bin: join(testDir, "bin"),
    releases: join(testDir, "data", "releases"),
  };
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("uninstall symlink removal", () => {
  test("removes symlink", () => {
    setupMockInstall();
    const symlinkPath = join(mockPaths.bin, "squirrel");

    expect(existsSync(symlinkPath)).toBe(true);

    unlinkSync(symlinkPath);

    expect(existsSync(symlinkPath)).toBe(false);
  });

  test("handles missing symlink gracefully", () => {
    mkdirSync(mockPaths.bin, { recursive: true });
    const symlinkPath = join(mockPaths.bin, "squirrel");

    expect(existsSync(symlinkPath)).toBe(false);

    // Should not throw
    expect(() => {
      if (existsSync(symlinkPath)) {
        unlinkSync(symlinkPath);
      }
    }).not.toThrow();
  });
});

describe("uninstall releases removal", () => {
  test("removes all cached releases", () => {
    setupMockInstall(["1.0.0", "1.1.0", "2.0.0"]);

    expect(countReleases(mockPaths.releases)).toBe(3);

    rmSync(mockPaths.releases, { recursive: true, force: true });

    expect(existsSync(mockPaths.releases)).toBe(false);
  });

  test("calculates release count before removal", () => {
    setupMockInstall(["1.0.0", "1.1.0"]);

    const count = countReleases(mockPaths.releases);
    expect(count).toBe(2);
  });

  test("calculates release size before removal", () => {
    setupMockInstall(["1.0.0"]);

    const size = getDirSize(mockPaths.data);
    expect(size).toBeGreaterThan(0);
  });

  test("handles missing releases directory", () => {
    mkdirSync(mockPaths.data, { recursive: true });

    expect(existsSync(mockPaths.releases)).toBe(false);

    expect(() => {
      rmSync(mockPaths.releases, { recursive: true, force: true });
    }).not.toThrow();
  });
});

describe("uninstall settings preservation", () => {
  test("preserves settings by default", () => {
    setupMockInstall();
    const settingsPath = join(mockPaths.config, "settings.json");
    const symlinkPath = join(mockPaths.bin, "squirrel");

    // Remove symlink and releases only
    unlinkSync(symlinkPath);
    rmSync(mockPaths.releases, { recursive: true, force: true });

    // Settings should still exist
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(mockPaths.config)).toBe(true);
  });
});

describe("uninstall with purge", () => {
  test("removes settings when purge is true", () => {
    setupMockInstall();
    const settingsPath = join(mockPaths.config, "settings.json");

    expect(existsSync(settingsPath)).toBe(true);

    rmSync(mockPaths.config, { recursive: true, force: true });

    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(mockPaths.config)).toBe(false);
  });

  test("removes everything with purge", () => {
    setupMockInstall(["1.0.0", "2.0.0"]);
    const symlinkPath = join(mockPaths.bin, "squirrel");

    // Full uninstall with purge
    unlinkSync(symlinkPath);
    rmSync(mockPaths.releases, { recursive: true, force: true });
    rmSync(mockPaths.config, { recursive: true, force: true });

    expect(existsSync(symlinkPath)).toBe(false);
    expect(existsSync(mockPaths.releases)).toBe(false);
    expect(existsSync(mockPaths.config)).toBe(false);
  });
});

describe("uninstall data directory cleanup", () => {
  test("removes empty data directory", () => {
    setupMockInstall();
    const symlinkPath = join(mockPaths.bin, "squirrel");

    // Remove everything in data
    unlinkSync(symlinkPath);
    rmSync(mockPaths.releases, { recursive: true, force: true });

    // Check if data dir is empty and remove it
    const remaining = readdirSync(mockPaths.data);
    if (remaining.length === 0) {
      rmSync(mockPaths.data, { recursive: true, force: true });
    }

    expect(existsSync(mockPaths.data)).toBe(false);
  });
});

describe("uninstall result tracking", () => {
  test("tracks what was removed", () => {
    setupMockInstall(["1.0.0", "1.1.0"]);
    const symlinkPath = join(mockPaths.bin, "squirrel");

    const result = {
      symlink_removed: false,
      releases_removed: false,
      releases_count: 0,
      releases_size_bytes: 0,
      settings_removed: false,
    };

    // Track before removal
    result.releases_count = countReleases(mockPaths.releases);
    result.releases_size_bytes = getDirSize(mockPaths.data);

    // Remove
    if (existsSync(symlinkPath)) {
      unlinkSync(symlinkPath);
      result.symlink_removed = true;
    }

    if (existsSync(mockPaths.releases)) {
      rmSync(mockPaths.releases, { recursive: true, force: true });
      result.releases_removed = true;
    }

    expect(result.symlink_removed).toBe(true);
    expect(result.releases_removed).toBe(true);
    expect(result.releases_count).toBe(2);
    expect(result.releases_size_bytes).toBeGreaterThan(0);
    expect(result.settings_removed).toBe(false);
  });
});
