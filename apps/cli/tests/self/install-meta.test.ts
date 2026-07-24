import { afterEach, describe, expect, test } from "bun:test";

import {
  detectCi,
  detectInstallSource,
  isUpdateDisabledByEnv,
  updateSuppressedReason,
} from "../../src/self/install-meta";

const CI_VARS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "BUILDKITE",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
];

function clearCiEnv(): void {
  for (const k of CI_VARS) delete process.env[k];
}

function clearUpdateEnv(): void {
  clearCiEnv();
  delete process.env.SQUIRREL_NO_UPDATE;
}

const KNOWN_SOURCES = ["npm", "binary", "dev", "manual"];

describe("detectCi", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("false when no CI signals present", () => {
    clearCiEnv();
    expect(detectCi()).toBe(false);
  });

  test("true when CI=true", () => {
    clearCiEnv();
    process.env.CI = "true";
    expect(detectCi()).toBe(true);
  });

  test('CI="false" and CI="0" are not CI', () => {
    clearCiEnv();
    process.env.CI = "false";
    expect(detectCi()).toBe(false);
    process.env.CI = "0";
    expect(detectCi()).toBe(false);
  });

  test("detects provider-specific vars", () => {
    for (const v of [
      "CONTINUOUS_INTEGRATION",
      "GITHUB_ACTIONS",
      "GITLAB_CI",
      "CIRCLECI",
      "BUILDKITE",
      "JENKINS_URL",
      "TEAMCITY_VERSION",
      "TF_BUILD",
    ]) {
      clearCiEnv();
      process.env[v] = "1";
      expect(detectCi()).toBe(true);
    }
  });
});

describe("detectInstallSource", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("honors SQUIRREL_INSTALL_SOURCE override", () => {
    process.env.SQUIRREL_INSTALL_SOURCE = "homebrew";
    expect(detectInstallSource()).toBe("homebrew");
  });

  test("trims and truncates override to 64 chars", () => {
    process.env.SQUIRREL_INSTALL_SOURCE = `  ${"x".repeat(100)}  `;
    const s = detectInstallSource();
    expect(s.length).toBe(64);
    expect(s).toBe("x".repeat(64));
  });

  test("ignores blank override and falls back to inference", () => {
    process.env.SQUIRREL_INSTALL_SOURCE = "   ";
    expect(KNOWN_SOURCES).toContain(detectInstallSource());
  });

  test("returns a known channel when no override", () => {
    delete process.env.SQUIRREL_INSTALL_SOURCE;
    expect(KNOWN_SOURCES).toContain(detectInstallSource());
  });
});

describe("isUpdateDisabledByEnv", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("false when SQUIRREL_NO_UPDATE is unset", () => {
    delete process.env.SQUIRREL_NO_UPDATE;
    expect(isUpdateDisabledByEnv()).toBe(false);
  });

  test('false for "", "0", "false" (case-insensitive)', () => {
    for (const v of ["", "0", "false", "FALSE", "  False  "]) {
      process.env.SQUIRREL_NO_UPDATE = v;
      expect(isUpdateDisabledByEnv()).toBe(false);
    }
  });

  test("true for any other truthy value", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.SQUIRREL_NO_UPDATE = v;
      expect(isUpdateDisabledByEnv()).toBe(true);
    }
  });
});

describe("updateSuppressedReason", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("null when not CI and not env-disabled", () => {
    clearUpdateEnv();
    expect(updateSuppressedReason()).toBeNull();
  });

  test("reports CI when a CI signal is present", () => {
    clearUpdateEnv();
    process.env.CI = "true";
    expect(updateSuppressedReason()).toBe("running in CI");
  });

  test("reports env opt-out when SQUIRREL_NO_UPDATE is set", () => {
    clearUpdateEnv();
    process.env.SQUIRREL_NO_UPDATE = "1";
    expect(updateSuppressedReason()).toBe("SQUIRREL_NO_UPDATE is set");
  });

  test("env opt-out takes precedence over CI", () => {
    clearUpdateEnv();
    process.env.CI = "true";
    process.env.SQUIRREL_NO_UPDATE = "1";
    expect(updateSuppressedReason()).toBe("SQUIRREL_NO_UPDATE is set");
  });

  test("null when CI=false and env opt-out disabled", () => {
    clearUpdateEnv();
    process.env.CI = "false";
    process.env.SQUIRREL_NO_UPDATE = "0";
    expect(updateSuppressedReason()).toBeNull();
  });

  test("SQUIRREL_NO_UPDATE=0 does NOT re-enable updates in CI", () => {
    // The env var can only ADD suppression — a falsy value just declines the
    // env opt-out and falls through to CI detection, which still wins.
    clearUpdateEnv();
    process.env.CI = "true";
    process.env.SQUIRREL_NO_UPDATE = "0";
    expect(updateSuppressedReason()).toBe("running in CI");
  });
});
