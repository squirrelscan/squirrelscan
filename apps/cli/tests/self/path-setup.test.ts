// The installers stamp SQUIRREL_PATH_SETUP on `self install`; registration runs
// on a later command, so the value is persisted and sent from settings.
// (os.homedir is mocked: Bun ignores a later process.env.HOME.)

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

const { runSelfInstall } = await import("@/controllers/self/install");
const { registerInstall } = await import("@/self/register-install");
const { readPathSetupEnv, shouldPrintPathInstructions } =
  await import("@/self/install-meta");
const { loadUserSettings } = await import("@/self/settings");

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

describe("path_setup stamp", () => {
  beforeEach(() => {
    home = mkdtempSync(join(realOs.tmpdir(), "squirrel-path-setup-"));
    process.env = { ...originalEnv, HOME: home };
    delete process.env.NO_TELEMETRY;
    delete process.env.SQUIRREL_PATH_SETUP;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    rmSync(home, { recursive: true, force: true });
  });

  async function install(): Promise<void> {
    const result = await runSelfInstall("9.9.9", { binDir: join(home, "bin") });
    expect(result.ok).toBe(true);
  }

  test("reads only the five known outcomes", () => {
    for (const v of ["on_path", "added", "opted_out", "ci", "failed"]) {
      process.env.SQUIRREL_PATH_SETUP = v;
      expect(readPathSetupEnv()).toBe(v as never);
    }
    process.env.SQUIRREL_PATH_SETUP = " ADDED ";
    expect(readPathSetupEnv()).toBe("added");
    process.env.SQUIRREL_PATH_SETUP = "/etc/passwd";
    expect(readPathSetupEnv()).toBeNull();
    delete process.env.SQUIRREL_PATH_SETUP;
    expect(readPathSetupEnv()).toBeNull();
  });

  test("self install prints its own PATH block only when no installer stamped an outcome", () => {
    delete process.env.SQUIRREL_PATH_SETUP;
    expect(shouldPrintPathInstructions(false)).toBe(true);
    expect(shouldPrintPathInstructions(true)).toBe(false);
    for (const v of ["on_path", "added", "opted_out", "ci", "failed"]) {
      process.env.SQUIRREL_PATH_SETUP = v;
      expect(shouldPrintPathInstructions(false)).toBe(false);
    }
  });

  test("a stamp is persisted by self install and sent on registration", async () => {
    process.env.SQUIRREL_PATH_SETUP = "added";
    await install();
    delete process.env.SQUIRREL_PATH_SETUP; // the next command has no env

    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    registerInstall();
    await new Promise((r) => setTimeout(r, 50));
    expect(body.path_setup).toBe("added");
  });

  test("an unknown stamp is dropped; a reinstall without one keeps the earlier", async () => {
    process.env.SQUIRREL_PATH_SETUP = "bogus";
    await install();
    let settings = loadUserSettings();
    expect(settings.ok && settings.data.path_setup).toBeFalsy();

    process.env.SQUIRREL_PATH_SETUP = "on_path";
    await install();
    delete process.env.SQUIRREL_PATH_SETUP;
    await install();
    settings = loadUserSettings();
    expect(settings.ok && settings.data.path_setup).toBe("on_path");
  });
});
