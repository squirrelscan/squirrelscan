// `squirrel setup` first-run telemetry (#1194): step outcomes only, nothing on
// a dry run, nothing when telemetry is off. os.homedir is mocked (Bun ignores
// a later process.env.HOME, see uninstall.test.ts).

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

const { runSetup } = await import("@/cli/commands/setup");
const { loadUserSettings, updateSettings } = await import("@/self/settings");

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalLog = console.log;

let events: Array<{ event: string; error_type?: string }> = [];

describe("setup telemetry", () => {
  beforeEach(() => {
    home = mkdtempSync(join(realOs.tmpdir(), "squirrel-setup-"));
    process.env = { ...originalEnv, HOME: home };
    delete process.env.NO_TELEMETRY;
    delete process.env.SQUIRRELSCAN_API_KEY;
    delete process.env.SQUIRREL_API_TOKEN;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";
    events = [];
    console.log = () => {};
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.event) events.push(body);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    rmSync(home, { recursive: true, force: true });
  });

  const settle = () => new Promise<void>((r) => setTimeout(r, 60));

  test("a non-interactive run reports started, each step, completed", async () => {
    await runSetup({ yes: true, dryRun: false });
    await settle();
    const names = events.map((e) =>
      e.error_type ? `${e.event}/${e.error_type}` : e.event
    );
    expect(names[0]).toBe("setup_started");
    expect(names).toContain("setup_step/signin:skipped");
    expect(names.some((n) => n.startsWith("setup_step/skills:"))).toBe(true);
    expect(names.some((n) => n.startsWith("setup_step/updates:"))).toBe(true);
    expect(names.at(-1)).toBe("setup_completed");
    // Nothing free-form: every detail is a step:outcome slug.
    for (const e of events) {
      if (e.error_type) expect(e.error_type).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });

  test("a dry run sends nothing", async () => {
    await runSetup({ yes: true, dryRun: true });
    await settle();
    expect(events).toHaveLength(0);
  });

  test("telemetry off sends nothing", async () => {
    updateSettings({ telemetry: false });
    await runSetup({ yes: true, dryRun: false });
    await settle();
    expect(events).toHaveLength(0);
    const s = loadUserSettings();
    expect(s.ok && s.data.setup_completed_at).toBeTruthy();
  });
});
