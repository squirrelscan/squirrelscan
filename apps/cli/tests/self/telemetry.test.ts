import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trackError, trackTelemetryEvent } from "@/self/telemetry";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

let tempHome: string;

function waitForTelemetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("telemetry", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "squirrelscan-telemetry-"));
    process.env = { ...originalEnv, HOME: tempHome };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("any defined NO_TELEMETRY value prevents network and install-ID creation", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    for (const value of ["", "0", "false", "1"]) {
      process.env.NO_TELEMETRY = value;
      trackTelemetryEvent("audit");
      await waitForTelemetry();

      expect(calls).toBe(0);
      expect(existsSync(join(tempHome, ".squirrel", "settings.json"))).toBe(
        false
      );
    }
  });

  test("telemetry never sends an API credential", async () => {
    delete process.env.NO_TELEMETRY;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";
    process.env.SQUIRRELSCAN_API_KEY = "sq_test_secret";

    let headers = new Headers();
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    trackTelemetryEvent("audit");
    await waitForTelemetry();

    expect(headers.has("authorization")).toBe(false);
  });

  test("error telemetry sends a category but never the raw error message", async () => {
    delete process.env.NO_TELEMETRY;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";

    let payload: Record<string, string> = {};
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      payload = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    trackError(new Error("https://secret.example/private?token=abc"), "audit");
    await waitForTelemetry();

    expect(payload.error_type).toBe("audit");
    expect(payload.error_message).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("secret.example");
  });

  test("posts audit trace with install id", async () => {
    delete process.env.NO_TELEMETRY;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";

    let calledUrl = "";
    let payload: Record<string, string> = {};

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calledUrl = String(input);
      payload = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    trackTelemetryEvent("audit");
    await waitForTelemetry();

    expect(calledUrl).toBe("http://localhost:9999/v1/traces");
    expect(payload.event).toBe("audit");
    expect(payload.install_id).toMatch(/[0-9a-f-]{36}/i);
  });

  test("posts update event correctly", async () => {
    delete process.env.NO_TELEMETRY;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";

    let payload: Record<string, string> = {};

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      payload = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    trackTelemetryEvent("update");
    await waitForTelemetry();

    expect(payload.event).toBe("update");
  });

  test("includes version in payload", async () => {
    delete process.env.NO_TELEMETRY;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";

    let payload: Record<string, string> = {};

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      payload = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    trackTelemetryEvent("audit");
    await waitForTelemetry();

    expect(payload.version).toBeDefined();
    expect(typeof payload.version).toBe("string");
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("sends update lifecycle events", async () => {
    delete process.env.NO_TELEMETRY;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";

    const events: string[] = [];

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      events.push(body.event);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const lifecycleEvents = [
      "update_check",
      "update_available",
      "update_check_error",
      "update_notified",
      "update_prompt_accepted",
      "update_prompt_declined",
    ] as const;

    for (const event of lifecycleEvents) {
      trackTelemetryEvent(event);
    }
    await waitForTelemetry();

    for (const event of lifecycleEvents) {
      expect(events).toContain(event);
    }
  });

  test("handles network errors silently", async () => {
    delete process.env.NO_TELEMETRY;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";

    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    // Should not throw
    trackTelemetryEvent("audit");
    await waitForTelemetry();
  });

  test("handles timeout silently", async () => {
    delete process.env.NO_TELEMETRY;
    process.env.SQUIRREL_API_SERVER = "http://localhost:9999";

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      // Wait longer than TELEMETRY_TIMEOUT_MS (3s) — AbortController should fire
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    // Should not throw even when timeout fires
    trackTelemetryEvent("audit");
    // Wait just past the 3s timeout
    await new Promise((resolve) => setTimeout(resolve, 3200));
  }, 10000);
});
