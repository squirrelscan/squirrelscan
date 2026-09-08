// `findKeyToRevoke` over the network: which org a prefix resolves in, and what
// happens when part of the search could not be read.
//
// The dangerous case (found in review of #1971): revoking is destructive, and a
// prefix is only unique among the keys we actually saw. If one org's listing
// fails, a prefix that looks unique can be shadowing the key the user meant in
// the org we could not see — so a prefix match must fail closed there.
//
// Network is a global fetch stub; the login session is a spyOn of
// loadUserSettings, NOT mock.module — see keys-create.test.ts for why.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { ok } from "@/controllers/types";
import * as settingsModule from "@/self/settings";

let stubbedAuth: {
  token: string;
  userId: string;
  email: string;
  name: string | null;
  expiresAt: string;
} | null = null;

const loadUserSettingsSpy = spyOn(
  settingsModule,
  "loadUserSettings"
).mockImplementation(() =>
  ok({ ...settingsModule.DEFAULT_SETTINGS, auth: stubbedAuth })
);

afterAll(() => {
  loadUserSettingsSpy.mockRestore();
});

const { findKeyToRevoke } = await import("@/controllers/keys/revoke");
const { API_TOKEN_ENV_VAR, LEGACY_API_TOKEN_ENV_VAR } =
  await import("@/self/credentials");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

const ORGS = [
  { id: "org_a", slug: "nikz", name: "Nik Cubrilovic", role: "owner" },
  {
    id: "org_b",
    slug: "squirrelscan-e2e",
    name: "squirrelscan e2e (internal)",
    role: "member",
  },
];

function apiKey(id: string, prefix: string): Record<string, unknown> {
  return {
    id,
    name: id,
    prefix,
    scopes: [],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdBy: "user_1",
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env[API_TOKEN_ENV_VAR];
  delete process.env[LEGACY_API_TOKEN_ENV_VAR];
  stubbedAuth = {
    token: "sqcli_loginsession",
    userId: "user_1",
    email: "you@example.com",
    name: "You",
    expiresAt: FUTURE,
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  stubbedAuth = null;
});

/** Per-org key responses; a number value serves that status instead. */
function stubFetch(byOrg: Record<string, unknown[] | number>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    const match = url.match(/\/v1\/organizations\/([^/]+)\/api-keys/);
    if (match) {
      const entry = byOrg[match[1]!];
      if (typeof entry === "number") {
        return new Response(
          JSON.stringify({
            error: { code: "FORBIDDEN", message: "Insufficient permissions" },
          }),
          { status: entry }
        );
      }
      return new Response(JSON.stringify({ apiKeys: entry ?? [] }), {
        status: 200,
      });
    }
    if (url.includes("/v1/organizations")) {
      return new Response(JSON.stringify({ organizations: ORGS }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("findKeyToRevoke", () => {
  test("resolves a prefix in whichever org holds it, and returns that org", async () => {
    stubFetch({
      org_a: [apiKey("key_a", "sq_aaa111")],
      org_b: [apiKey("key_b", "sq_bbb222")],
    });

    const result = await findKeyToRevoke("sq_bbb");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.key.id).toBe("key_b");
    expect(result.data.org.id).toBe("org_b");
  });

  test("REFUSES a prefix match when another org's keys could not be read", async () => {
    // org_b holds the key the user probably meant, but 403s. Resolving against
    // org_a alone would revoke the wrong live credential.
    stubFetch({ org_a: [apiKey("key_a", "sq_shared111")], org_b: 403 });

    const result = await findKeyToRevoke("sq_shared");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INCOMPLETE_SEARCH");
      expect(result.error.message).toContain("squirrelscan-e2e");
      expect(result.error.message).toContain("--org");
    }
  });

  test("an exact key id still resolves through an incomplete search", async () => {
    // Ids are globally unique, so a partial listing cannot hide a rival match.
    stubFetch({ org_a: [apiKey("key_a", "sq_shared111")], org_b: 403 });

    const result = await findKeyToRevoke("key_a");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.matchedBy).toBe("id");
  });

  test("--org restores prefix matching by making the search complete again", async () => {
    stubFetch({ org_a: [apiKey("key_a", "sq_shared111")] });

    const result = await findKeyToRevoke("sq_shared", { org: "nikz" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.key.id).toBe("key_a");
  });

  test("a genuinely missing key names the orgs that could not be searched", async () => {
    stubFetch({ org_a: [apiKey("key_a", "sq_aaa111")], org_b: 403 });

    const result = await findKeyToRevoke("sq_zzz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("KEY_NOT_FOUND");
      expect(result.error.message).toContain("squirrelscan-e2e");
    }
  });

  test("requires a login session", async () => {
    stubbedAuth = null;
    process.env[API_TOKEN_ENV_VAR] = "sq_someorgkey";

    const result = await findKeyToRevoke("sq_aaa");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LOGIN_REQUIRED");
  });
});
