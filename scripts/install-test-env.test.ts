// #3896: the guard behind scripts/install-test-env.ts, and a source scan that fails when a test spawns install.sh
// with telemetry on and no non-production SQUIRREL_ERROR_ENDPOINT.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assertInstallerEnvCannotReachProduction, DEAD_ERROR_ENDPOINT } from "./install-test-env";

describe("assertInstallerEnvCannotReachProduction", () => {
  test("telemetry off is always safe", () => {
    expect(() => assertInstallerEnvCannotReachProduction({ NO_TELEMETRY: "1" })).not.toThrow();
    expect(() => assertInstallerEnvCannotReachProduction({ NO_TELEMETRY: "" })).not.toThrow();
    expect(() => assertInstallerEnvCannotReachProduction({ DO_NOT_TRACK: "true" })).not.toThrow();
  });

  test("telemetry on needs a non-production endpoint", () => {
    expect(() =>
      assertInstallerEnvCannotReachProduction({ SQUIRREL_ERROR_ENDPOINT: DEAD_ERROR_ENDPOINT }),
    ).not.toThrow();
    // unset = the production default
    expect(() => assertInstallerEnvCannotReachProduction({})).toThrow(/#3896/);
    expect(() =>
      assertInstallerEnvCannotReachProduction({
        SQUIRREL_ERROR_ENDPOINT: "https://install.squirrelscan.com/error",
      }),
    ).toThrow();
    expect(() =>
      assertInstallerEnvCannotReachProduction({ SQUIRREL_ERROR_ENDPOINT: "https://squirrelscan.com/x" }),
    ).toThrow();
  });

  test("the dead endpoint is loopback port 9, not a squirrelscan host", () => {
    expect(DEAD_ERROR_ENDPOINT).toBe("http://127.0.0.1:9/error");
  });
});

describe("every test that runs install.sh with telemetry on uses a dead endpoint", () => {
  const dir = import.meta.dir;
  const files = readdirSync(dir).filter((f) => /install.*\.test\.ts$/.test(f) && f !== "install-test-env.test.ts");

  test("the install harness files are found", () => {
    expect(files).toContain("install-contract.test.ts");
    expect(files).toContain("install-hardening-168.test.ts");
  });

  for (const file of files) {
    test(`${file}: a harness that clears NO_TELEMETRY also sets a non-production SQUIRREL_ERROR_ENDPOINT and asserts the env`, () => {
      const source = readFileSync(join(dir, file), "utf8");
      const spawnsInstaller = /Bun\.spawn\(/.test(source);
      const clearsTelemetry = /NO_TELEMETRY: undefined/.test(source);
      if (!spawnsInstaller || !clearsTelemetry) return;
      // The harness sets the dead endpoint and checks the merged env before every spawn.
      expect(source).toContain("SQUIRREL_ERROR_ENDPOINT: DEAD_ERROR_ENDPOINT");
      expect(source).toContain("assertInstallerEnvCannotReachProduction(");
      // No test overrides it back to the production default or to a production host.
      expect(source).not.toMatch(/SQUIRREL_ERROR_ENDPOINT: undefined/);
      expect(source).not.toMatch(/SQUIRREL_ERROR_ENDPOINT: ["'`]https?:\/\/[^"'`]*squirrelscan\.com/);
    });
  }
});
