// `squirrel keys revoke` — prefix/id resolution against the user's key list.
// Pure function, no network involved.
//
// Resolution runs over (org, key) pairs rather than a bare key array (#1971):
// a key belongs to exactly one org, the DELETE has to go to THAT org, and a
// prefix can collide across two orgs the user belongs to.

import { describe, expect, test } from "bun:test";

import type { OrgApiKeySummary } from "@/controllers/keys/list";
import type { CliOrg } from "@/controllers/orgs/resolve";

import {
  flattenOrgKeys,
  resolveKeyMatch,
  type OrgKeyRef,
} from "@/controllers/keys/revoke";

const ORG_A: CliOrg = {
  id: "org_a",
  slug: "nikz",
  name: "Nik Cubrilovic",
  role: "owner",
};
const ORG_B: CliOrg = {
  id: "org_b",
  slug: "squirrelscan-e2e",
  name: "squirrelscan e2e (internal)",
  role: "owner",
};

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

/** (org, key) pairs for one org — the common single-org shape. */
function refs(
  org: CliOrg,
  keys: Array<Partial<OrgApiKeySummary>>
): OrgKeyRef[] {
  return keys.map((overrides) => ({ org, key: key(overrides) }));
}

describe("resolveKeyMatch", () => {
  test("matches by exact id", () => {
    const result = resolveKeyMatch(
      refs(ORG_A, [
        { id: "key_1", prefix: "sq_aaa" },
        { id: "key_2", prefix: "sq_bbb" },
      ]),
      "key_2"
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.key.id).toBe("key_2");
  });

  test("matches by a unique prefix", () => {
    const result = resolveKeyMatch(
      refs(ORG_A, [
        { id: "key_1", prefix: "sq_aaa111" },
        { id: "key_2", prefix: "sq_bbb222" },
      ]),
      "sq_aaa"
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.key.id).toBe("key_1");
  });

  test("errors when the prefix matches nothing", () => {
    const result = resolveKeyMatch(
      refs(ORG_A, [{ id: "key_1", prefix: "sq_aaa111" }]),
      "sq_zzz"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KEY_NOT_FOUND");
  });

  test("errors when the prefix is ambiguous across multiple active keys", () => {
    const result = resolveKeyMatch(
      refs(ORG_A, [
        { id: "key_1", prefix: "sq_aaa111" },
        { id: "key_2", prefix: "sq_aaa222" },
      ]),
      "sq_aaa"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AMBIGUOUS_PREFIX");
  });

  test("ignores revoked keys — a prefix that only matches a revoked key is not found", () => {
    const result = resolveKeyMatch(
      refs(ORG_A, [
        {
          id: "key_1",
          prefix: "sq_aaa111",
          revokedAt: new Date().toISOString(),
        },
      ]),
      "sq_aaa"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KEY_NOT_FOUND");
  });

  test("a revoked key no longer collides with an active key sharing a prefix", () => {
    const result = resolveKeyMatch(
      refs(ORG_A, [
        {
          id: "key_1",
          prefix: "sq_aaa111",
          revokedAt: new Date().toISOString(),
        },
        { id: "key_2", prefix: "sq_aaa222" },
      ]),
      "sq_aaa"
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.key.id).toBe("key_2");
  });

  test("carries the owning org so the DELETE targets the right org", () => {
    const result = resolveKeyMatch(
      [
        ...refs(ORG_A, [{ id: "key_a", prefix: "sq_aaa111" }]),
        ...refs(ORG_B, [{ id: "key_b", prefix: "sq_bbb222" }]),
      ],
      "sq_bbb"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.key.id).toBe("key_b");
      expect(result.data.org.id).toBe("org_b");
    }
  });

  test("a prefix colliding across two orgs is ambiguous and names both", () => {
    const result = resolveKeyMatch(
      [
        ...refs(ORG_A, [{ id: "key_a", prefix: "sq_shared111" }]),
        ...refs(ORG_B, [{ id: "key_b", prefix: "sq_shared222" }]),
      ],
      "sq_shared"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AMBIGUOUS_PREFIX");
      expect(result.error.message).toContain("nikz");
      expect(result.error.message).toContain("squirrelscan-e2e");
      expect(result.error.message).toContain("--org");
    }
  });

  test("an exact id in a second org wins without ambiguity", () => {
    const result = resolveKeyMatch(
      [
        ...refs(ORG_A, [{ id: "key_a", prefix: "sq_same" }]),
        ...refs(ORG_B, [{ id: "key_b", prefix: "sq_same" }]),
      ],
      "key_b"
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.org.slug).toBe("squirrelscan-e2e");
  });
});

describe("flattenOrgKeys", () => {
  test("pairs every key with its own org and skips orgs that could not be read", () => {
    const flat = flattenOrgKeys([
      { org: ORG_A, keys: [key({ id: "key_a" })] },
      { org: ORG_B, keys: [], error: "Insufficient permissions" },
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0].org.id).toBe("org_a");
    expect(flat[0].key.id).toBe("key_a");
  });
});
