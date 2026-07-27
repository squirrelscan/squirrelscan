import { describe, expect, test } from "bun:test";

import type { UserSettings } from "@/self/types";

import { redactSettingsForDisplay } from "@/cli/commands/self";

// Distinctive values that redactString() does NOT catch on its own — so if the
// explicit masking regressed, these would surface in the output and fail the
// assertions below (proving the baseline redactValue() pass is not enough).
const TOKEN = "session-token-probe-value-1399";
const KEY_MATERIAL = "byok-key-probe-value-1399";

// Minimal valid UserSettings (only the schema-required fields).
function baseSettings(): UserSettings {
  return {
    channel: "stable",
    auto_update: true,
    notifications: true,
    telemetry: false,
    tips: true,
    last_update_check: null,
    dismissed_update_version: null,
    update_prompt_snoozed_until: null,
  };
}

function loggedInWithByok(): UserSettings {
  return {
    ...baseSettings(),
    auth: {
      token: TOKEN,
      userId: "user_123",
      email: "dev@example.com",
      name: "Dev",
      expiresAt: "2026-12-31T00:00:00.000Z",
    },
    tool_credentials: {
      // Keychain sentinel — the real secret is in the OS keychain, not here.
      gsc: { _keychainRef: true },
      // Plaintext BYOK fallback (keychain-unavailable install) — a real secret.
      pangram: { api_key: KEY_MATERIAL },
    },
  };
}

describe("redactSettingsForDisplay (#1399)", () => {
  test("masks auth + plaintext BYOK cred, preserves keychain sentinel", () => {
    const redacted = redactSettingsForDisplay(loggedInWithByok());

    // Whole auth object masked (covers the live session bearer token).
    expect(redacted.auth).toBe("[REDACTED]");

    // Sentinel preserved untouched; plaintext credential fully masked.
    expect(redacted.tool_credentials).toEqual({
      gsc: { _keychainRef: true },
      pangram: "[REDACTED]",
    });

    // The serialized (as displayed) form leaks nothing: not the token, not the
    // key material, and not even the `api_key` field name.
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(KEY_MATERIAL);
    expect(serialized).not.toContain("api_key");

    // Non-sensitive settings remain visible and correct.
    expect(redacted.channel).toBe("stable");
    expect(redacted.auto_update).toBe(true);
    expect(redacted.telemetry).toBe(false);
  });

  test("does not mutate the caller's settings object", () => {
    const settings = loggedInWithByok();
    redactSettingsForDisplay(settings);

    // Original still holds the real secrets — the clone was masked, not this.
    expect(settings.auth?.token).toBe(TOKEN);
    expect(settings.tool_credentials?.pangram).toEqual({
      api_key: KEY_MATERIAL,
    });
    expect(settings.tool_credentials?.gsc).toEqual({ _keychainRef: true });
  });

  test("passes logged-out / no-BYOK settings through untouched", () => {
    const redacted = redactSettingsForDisplay({
      ...baseSettings(),
      auth: null,
    });

    expect(redacted).toEqual({ ...baseSettings(), auth: null });
    expect(redacted.auth).toBeNull();
    expect(redacted.tool_credentials).toBeUndefined();
  });
});
