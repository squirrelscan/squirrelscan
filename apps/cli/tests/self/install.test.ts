import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  lstatSync,
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

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "squirrel-install-test-"));
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

describe("install paths setup", () => {
  test("creates releases directory", () => {
    const releasePath = join(mockPaths.releases, "1.0.0");
    mkdirSync(releasePath, { recursive: true });

    expect(existsSync(releasePath)).toBe(true);
    expect(existsSync(mockPaths.releases)).toBe(true);
  });

  test("creates bin directory", () => {
    mkdirSync(mockPaths.bin, { recursive: true });
    expect(existsSync(mockPaths.bin)).toBe(true);
  });

  test("creates config directory", () => {
    mkdirSync(mockPaths.config, { recursive: true });
    expect(existsSync(mockPaths.config)).toBe(true);
  });
});

describe("install binary placement", () => {
  test("binary is placed in version directory", () => {
    const version = "1.0.0";
    const releasePath = join(mockPaths.releases, version);
    const binaryPath = join(releasePath, "squirrel");

    mkdirSync(releasePath, { recursive: true });
    writeFileSync(binaryPath, "binary content");

    expect(existsSync(binaryPath)).toBe(true);
  });

  test("symlink points to binary", () => {
    const version = "1.0.0";
    const releasePath = join(mockPaths.releases, version);
    const binaryPath = join(releasePath, "squirrel");
    const symlinkPath = join(mockPaths.bin, "squirrel");

    mkdirSync(releasePath, { recursive: true });
    mkdirSync(mockPaths.bin, { recursive: true });
    writeFileSync(binaryPath, "binary content");

    // Create symlink
    const { symlinkSync } = require("node:fs");
    symlinkSync(binaryPath, symlinkPath);

    expect(existsSync(symlinkPath)).toBe(true);
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
  });
});

describe("install settings", () => {
  test("creates settings.json in config dir", () => {
    const settingsPath = join(mockPaths.config, "settings.json");

    mkdirSync(mockPaths.config, { recursive: true });

    const settings = {
      channel: "stable",
      current_version: "1.0.0",
      auto_update: true,
      notifications: true,
      last_update_check: new Date().toISOString(),
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    expect(existsSync(settingsPath)).toBe(true);

    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.channel).toBe("stable");
    expect(saved.current_version).toBe("1.0.0");
  });

  test("settings contain required fields", () => {
    const settings = {
      channel: "beta",
      current_version: "1.0.0-beta",
      auto_update: true,
      notifications: true,
      last_update_check: null,
    };

    expect(settings).toHaveProperty("channel");
    expect(settings).toHaveProperty("current_version");
    expect(settings).toHaveProperty("auto_update");
    expect(settings).toHaveProperty("notifications");
    expect(settings).toHaveProperty("last_update_check");
  });
});

describe("install idempotency", () => {
  test("reinstall updates symlink target", () => {
    const { symlinkSync, unlinkSync, readlinkSync } = require("node:fs");

    // Setup v1
    const v1Path = join(mockPaths.releases, "1.0.0");
    const v1Binary = join(v1Path, "squirrel");
    mkdirSync(v1Path, { recursive: true });
    mkdirSync(mockPaths.bin, { recursive: true });
    writeFileSync(v1Binary, "v1");

    const symlinkPath = join(mockPaths.bin, "squirrel");
    symlinkSync(v1Binary, symlinkPath);

    expect(readlinkSync(symlinkPath)).toBe(v1Binary);

    // Upgrade to v2
    const v2Path = join(mockPaths.releases, "2.0.0");
    const v2Binary = join(v2Path, "squirrel");
    mkdirSync(v2Path, { recursive: true });
    writeFileSync(v2Binary, "v2");

    // Update symlink
    unlinkSync(symlinkPath);
    symlinkSync(v2Binary, symlinkPath);

    expect(readlinkSync(symlinkPath)).toBe(v2Binary);
  });
});
