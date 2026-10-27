// First-run funnel telemetry (#1194): events carry only a fixed slug, the
// login session (never an API key) attributes them to a user, and nothing is
// sent when telemetry is off. os.homedir is mocked: Bun ignores a later
// process.env.HOME (see uninstall.test.ts), and these tests write settings.

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

const { loadUserSettings, updateSettings } = await import("@/self/settings");
const {
  resetFirstAuditReportedForTests,
  showTelemetryNotice,
  trackFirstAudit,
  trackFirstRunEvent,
} = await import("@/self/telemetry");

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

interface Sent {
  body: Record<string, unknown>;
  headers: Headers;
}
let sent: Sent[] = [];

const settle = () => new Promise<void>((r) => setTimeout(r, 40));

function futureIso(): string {
  return new Date(Date.now() + 86_400_000).toISOString();
}

function signIn(token: string, expiresAt = futureIso()): void {
  updateSettings({
    auth: { token, userId: "u1", email: "a@b.co", name: null, expiresAt },
  });
}

describe("first-run telemetry", () => {
  beforeEach(() => {
    home = mkdtempSync(join(realOs.tmpdir(), "squirrel-first-run-"));
    process.env = { ...originalEnv, HOME: home };
    delete process.env.NO_TELEMETRY;
    delete process.env.SQUIRRELSCAN_API_KEY;
    delete process.env.SQUIRREL_API_TOKEN;
    // The production URL: the session token is only attached there. fetch is
    // mocked below, so nothing leaves the machine.
    process.env.SQUIRREL_API_SERVER = "https://api.squirrelscan.com";
    sent = [];
    resetFirstAuditReportedForTests();
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        body: JSON.parse(String(init?.body ?? "{}")),
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    rmSync(home, { recursive: true, force: true });
  });

  test("a step event carries a slug detail as error_type", async () => {
    trackFirstRunEvent("setup_step", undefined, "skills:done");
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.event).toBe("setup_step");
    expect(sent[0]?.body.error_type).toBe("skills:done");
  });

  test("free text, URLs and emails never ride along as detail", async () => {
    for (const bad of [
      "https://example.com/private",
      "a@b.co",
      "has space",
      "UPPER",
      "x".repeat(65),
      "/Users/me/site",
    ]) {
      trackFirstRunEvent("setup_step", undefined, bad);
    }
    await settle();
    expect(sent).toHaveLength(6);
    for (const s of sent) expect(s.body.error_type).toBeUndefined();
    expect(JSON.stringify(sent.map((s) => s.body))).not.toContain("example");
  });

  test("a login session token attributes the event", async () => {
    signIn("sqcli_session_token");
    trackFirstRunEvent("login_completed");
    await settle();
    expect(sent[0]?.headers.get("authorization")).toBe(
      "Bearer sqcli_session_token"
    );
  });

  test("an API server override gets no session token", async () => {
    signIn("sqcli_session_token");
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";
    trackFirstRunEvent("login_completed");
    await settle();
    expect(sent[0]?.headers.has("authorization")).toBe(false);
  });

  test("an expired session sends no token", async () => {
    signIn("sqcli_old", new Date(Date.now() - 1000).toISOString());
    trackFirstRunEvent("login_completed");
    await settle();
    expect(sent[0]?.headers.has("authorization")).toBe(false);
  });

  test("an org API key from the env is never sent", async () => {
    // pragma: allowlist secret
    process.env.SQUIRRELSCAN_API_KEY = "sq_live_secret";
    trackFirstRunEvent("setup_started");
    await settle();
    expect(sent[0]?.headers.has("authorization")).toBe(false);
  });

  test("an unparseable session expiry fails closed", async () => {
    signIn("sqcli_session_token", "not-a-date");
    trackFirstRunEvent("login_completed");
    await settle();
    expect(sent[0]?.headers.has("authorization")).toBe(false);
  });

  test("an existing install sees the v2 notice once more", () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      updateSettings({ telemetry_notice_shown: true });
      const first = loadUserSettings();
      if (!first.ok) throw new Error("unreadable");
      showTelemetryNotice(first.data);
      expect(errors.join("")).toContain("user ID");
      const again = loadUserSettings();
      if (!again.ok) throw new Error("unreadable");
      errors.length = 0;
      showTelemetryNotice(again.data);
      expect(errors).toHaveLength(0);
    } finally {
      console.error = orig;
    }
  });

  test("a non-session token in settings is never sent", async () => {
    signIn("sq_live_not_a_session");
    trackFirstRunEvent("setup_started");
    await settle();
    expect(sent[0]?.headers.has("authorization")).toBe(false);
  });

  test("NO_TELEMETRY sends nothing, even signed in", async () => {
    signIn("sqcli_session_token");
    process.env.NO_TELEMETRY = "1";
    trackFirstRunEvent("login_completed");
    trackFirstAudit({ ok: true });
    await settle();
    expect(sent).toHaveLength(0);
  });

  test("telemetry=false in settings sends nothing", async () => {
    updateSettings({ telemetry: false });
    const loaded = loadUserSettings();
    if (!loaded.ok) throw new Error("settings unreadable");
    trackFirstRunEvent("setup_started", loaded.data);
    trackFirstAudit({ ok: false, failureClass: "dns" }, loaded.data);
    await settle();
    expect(sent).toHaveLength(0);
  });

  test("first audit reports once, then never again", async () => {
    trackFirstAudit({ ok: true });
    await settle();
    expect(sent.map((s) => s.body.event)).toEqual(["first_audit_ok"]);

    resetFirstAuditReportedForTests(); // a new process, same settings file
    const loaded = loadUserSettings();
    if (!loaded.ok) throw new Error("settings unreadable");
    expect(loaded.data.first_audit_reported_at).toBeTruthy();
    trackFirstAudit({ ok: true }, loaded.data);
    await settle();
    expect(sent).toHaveLength(1);
  });

  test("a failed first audit reports its class only", async () => {
    trackFirstAudit({ ok: false, failureClass: "dns" });
    await settle();
    expect(sent[0]?.body.event).toBe("first_audit_failed");
    expect(sent[0]?.body.error_type).toBe("dns");
  });

  test("the marker is written even with telemetry off", () => {
    process.env.NO_TELEMETRY = "1";
    trackFirstAudit({ ok: true });
    const loaded = loadUserSettings();
    expect(loaded.ok && loaded.data.first_audit_reported_at).toBeTruthy();
  });
});
