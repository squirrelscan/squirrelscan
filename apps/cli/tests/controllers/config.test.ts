// Tests for config controller

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  showConfig,
  setConfigValue,
  getConfigPath,
} from "../../src/controllers/config";

describe("showConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "squirrel-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns error when configPath is null", () => {
    const result = showConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_NOT_FOUND");
    }
  });

  test("returns error when file does not exist", () => {
    const result = showConfig(join(tempDir, "nonexistent.toml"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FILE_NOT_FOUND");
    }
  });

  test("parses valid TOML config", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[crawler]
max_pages = 100
`
    );

    const result = showConfig(configPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config.crawler.max_pages).toBe(100);
      expect(result.data.configPath).toBe(configPath);
    }
  });

  test("returns error for invalid TOML syntax", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(configPath, "invalid = [unclosed");

    const result = showConfig(configPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FILE_READ_ERROR");
    }
  });

  test("returns error for invalid config values", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[crawler]
max_pages = "not a number"
`
    );

    const result = showConfig(configPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_CONFIG");
      expect(result.error.message).toContain("crawler.max_pages");
    }
  });
});

describe("setConfigValue", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "squirrel-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns error when configPath is null", () => {
    const result = setConfigValue(null, "crawler.max_pages", "100");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_NOT_FOUND");
    }
  });

  test("returns error when file does not exist", () => {
    const result = setConfigValue(
      join(tempDir, "nonexistent.toml"),
      "crawler.max_pages",
      "100"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FILE_NOT_FOUND");
    }
  });

  test("sets numeric value", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[crawler]
max_pages = 50
`
    );

    const result = setConfigValue(configPath, "crawler.max_pages", "100");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config.crawler.max_pages).toBe(100);
      expect(result.data.key).toBe("crawler.max_pages");
      expect(result.data.value).toBe(100);
    }
  });

  test("sets boolean value true", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[crawler]
respect_robots = false
`
    );

    const result = setConfigValue(configPath, "crawler.respect_robots", "true");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config.crawler.respect_robots).toBe(true);
    }
  });

  test("sets boolean value false", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[crawler]
respect_robots = true
`
    );

    const result = setConfigValue(
      configPath,
      "crawler.respect_robots",
      "false"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config.crawler.respect_robots).toBe(false);
    }
  });

  test("sets array value from JSON", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[rules]
disable = []
`
    );

    const result = setConfigValue(
      configPath,
      "rules.disable",
      '["ai/*", "content/quality"]'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config.rules.disable).toEqual([
        "ai/*",
        "content/quality",
      ]);
    }
  });

  test("sets string value", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[crawler]
user_agent = "Old/1.0"
`
    );

    const result = setConfigValue(
      configPath,
      "crawler.user_agent",
      "NewAgent/2.0"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config.crawler.user_agent).toBe("NewAgent/2.0");
    }
  });

  test("creates nested keys if missing", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(configPath, "");

    const result = setConfigValue(configPath, "crawler.max_pages", "200");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config.crawler.max_pages).toBe(200);
    }
  });

  test("returns error for invalid value type", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[crawler]
max_pages = 50
`
    );

    const result = setConfigValue(
      configPath,
      "crawler.max_pages",
      "not-a-number"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_VALUE");
    }
  });

  test("returns error for invalid output format", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[output]
format = "console"
`
    );

    const result = setConfigValue(configPath, "output.format", "invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_VALUE");
    }
  });

  test("handles empty string without converting to 0", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[crawler]
user_agent = "Test"
`
    );

    const result = setConfigValue(configPath, "crawler.user_agent", "");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Empty string stays as string, not converted to 0
      expect(result.data.value).toBe("");
    }
  });

  test("handles whitespace-only string", () => {
    const configPath = join(tempDir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[crawler]
user_agent = "Test"
`
    );

    const result = setConfigValue(configPath, "crawler.user_agent", "   ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.value).toBe("   ");
    }
  });
});

describe("getConfigPath", () => {
  test("returns error when configPath is null", () => {
    const result = getConfigPath(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_NOT_FOUND");
    }
  });

  test("returns path when provided", () => {
    const result = getConfigPath("/path/to/squirrel.toml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe("/path/to/squirrel.toml");
    }
  });
});
