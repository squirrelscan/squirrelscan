// The installer stamps SQUIRREL_INSTALL_SOURCE on `self install`, but install
// registration runs on a LATER command whose env no longer has it. Drive both
// halves against a temp HOME: `self install` persists a valid stamp, and
// registration reports it. (os.homedir is mocked: Bun ignores a later
// process.env.HOME, see uninstall.test.ts.)

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
const { loadUserSettings, updateSettings } = await import("@/self/settings");

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

describe("install source persistence", () => {
  beforeEach(() => {
    home = mkdtempSync(join(realOs.tmpdir(), "squirrel-install-source-"));
    process.env = { ...originalEnv, HOME: home };
    delete process.env.NO_TELEMETRY;
    delete process.env.SQUIRREL_INSTALL_SOURCE;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    rmSync(home, { recursive: true, force: true });
  });

  async function install(): Promise<void> {
    const result = await runSelfInstall("9.9.9", {
      binDir: join(home, "bin"),
    });
    expect(result.ok).toBe(true);
  }

  test("a valid stamp is persisted and sent on registration", async () => {
    process.env.SQUIRREL_INSTALL_SOURCE = "agent-prompt";
    await install();
    delete process.env.SQUIRREL_INSTALL_SOURCE; // the next command has no env

    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    registerInstall();
    await new Promise((r) => setTimeout(r, 50));
    expect(body.source).toBe("agent-prompt");
  });

  test("an invalid stamp is dropped, not persisted", async () => {
    process.env.SQUIRREL_INSTALL_SOURCE = "https://example.com/x";
    await install();
    const settings = loadUserSettings();
    expect(settings.ok && settings.data.install_source).toBeFalsy();
  });

  test("a reinstall without a stamp keeps the earlier one", async () => {
    process.env.SQUIRREL_INSTALL_SOURCE = "homebrew";
    await install();
    delete process.env.SQUIRREL_INSTALL_SOURCE;
    await install();
    const settings = loadUserSettings();
    expect(settings.ok && settings.data.install_source).toBe("homebrew");
  });

  test("a hand-edited persisted source is re-validated at registration", async () => {
    updateSettings({ install_source: "x".repeat(80) });

    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    registerInstall();
    await new Promise((r) => setTimeout(r, 50));
    expect(String(body.source)).not.toContain("xxxx");
  });
});
