// `squirrel keys revoke` — prefix/id resolution against the org's key list.
// Pure function, no network involved.

import { describe, expect, test } from "bun:test";

import type { OrgApiKeySummary } from "@/controllers/keys/list";

import { resolveKeyMatch } from "@/controllers/keys/revoke";

function key(overrides: Partial<OrgApiKeySummary>): OrgApiKeySummary {
  return {
    id: "key_default",
    name: "default",
    prefix: "sq_default",
    scopes: [],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdBy: "user_1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("resolveKeyMatch", () => {
  test("matches by exact id", () => {
    const keys = [
      key({ id: "key_1", prefix: "sq_aaa" }),
      key({ id: "key_2", prefix: "sq_bbb" }),
    ];
    const result = resolveKeyMatch(keys, "key_2");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe("key_2");
  });

  test("matches by a unique prefix", () => {
    const keys = [
      key({ id: "key_1", prefix: "sq_aaa111" }),
      key({ id: "key_2", prefix: "sq_bbb222" }),
    ];
    const result = resolveKeyMatch(keys, "sq_aaa");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe("key_1");
  });

  test("errors when the prefix matches nothing", () => {
    const keys = [key({ id: "key_1", prefix: "sq_aaa111" })];
    const result = resolveKeyMatch(keys, "sq_zzz");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KEY_NOT_FOUND");
  });

  test("errors when the prefix is ambiguous across multiple active keys", () => {
    const keys = [
      key({ id: "key_1", prefix: "sq_aaa111" }),
      key({ id: "key_2", prefix: "sq_aaa222" }),
    ];
    const result = resolveKeyMatch(keys, "sq_aaa");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AMBIGUOUS_PREFIX");
  });

  test("ignores revoked keys — a prefix that only matches a revoked key is not found", () => {
    const keys = [
      key({
        id: "key_1",
        prefix: "sq_aaa111",
        revokedAt: new Date().toISOString(),
      }),
    ];
    const result = resolveKeyMatch(keys, "sq_aaa");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KEY_NOT_FOUND");
  });

  test("a revoked key no longer collides with an active key sharing a prefix", () => {
    const keys = [
      key({
        id: "key_1",
        prefix: "sq_aaa111",
        revokedAt: new Date().toISOString(),
      }),
      key({ id: "key_2", prefix: "sq_aaa222" }),
    ];
    const result = resolveKeyMatch(keys, "sq_aaa");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe("key_2");
  });
});
