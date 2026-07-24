// `squirrel keys create` — network calls captured via a global fetch stub (the
// repo's established pattern for cliApi calls under test; see
// tests/lib/run-tracker.test.ts). Minting a key requires a LOGIN session (the
// API route rejects API-key auth to prevent a key minting a key) — the session
// is stubbed via spyOn the same way tests/self/credentials.test.ts does.
//
// spyOn, NOT mock.module: mock.module replaces the WHOLE @/self/settings
// module registry entry process-wide, for the rest of the `bun test`
// invocation. This previously leaked the fake loadUserSettings into
// tests/self/settings.test.ts's own direct tests of the REAL function
// (#1037 — proved via the CI log: a corrupt-JSON test that must incur a
// 15ms retry sleep completed in 0.16ms, meaning it wasn't running the real
// implementation). spyOn patches only this ONE property on the shared
// module namespace and reliably undoes it via mockRestore() — the
// established fix for single-function fakes (apps/cli/MEMORY.md /
// mock.module notes, PR #1004 precedent).
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

const { createApiKey, exportLine, defaultKeyName, parseScopes } =
  await import("@/controllers/keys/create");
const { API_TOKEN_ENV_VAR, LEGACY_API_TOKEN_ENV_VAR } =
  await import("@/self/credentials");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

function setLoginSession(): void {
  stubbedAuth = {
    token: "sqcli_loginsession",
    userId: "user_1",
    email: "you@example.com",
    name: "You",
    expiresAt: FUTURE,
  };
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env[API_TOKEN_ENV_VAR];
  delete process.env[LEGACY_API_TOKEN_ENV_VAR];
  setLoginSession();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  stubbedAuth = null;
});

function stubOrgAndCreateFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    if (url.includes("/v1/organizations/org_1/api-keys")) {
      return new Response(
        JSON.stringify({
          id: "key_1",
          name: "cli-test-20260101",
          scopes: [
            "audits:write",
            "audits:read",
            "credits:read",
            "org:read",
            "org:write",
          ],
          token: "sq_supersecrettoken",
          prefix: "sq_supersec",
          keyEnv: "production",
          expiresAt: null,
        }),
        { status: 201 }
      );
    }
    if (url.includes("/v1/organizations")) {
      return new Response(
        JSON.stringify({
          organizations: [{ id: "org_1", name: "Acme Inc", role: "owner" }],
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("createApiKey", () => {
  test("happy path: resolves the org, mints the key, and prints a copy-pasteable export line", async () => {
    stubOrgAndCreateFetch();

    const result = await createApiKey();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.orgId).toBe("org_1");
    expect(result.data.orgName).toBe("Acme Inc");
    expect(result.data.token).toBe("sq_supersecrettoken");
    expect(exportLine(result.data.token)).toBe(
      `export ${API_TOKEN_ENV_VAR}='sq_supersecrettoken'`
    );
  });

  test("posts the requested name/scopes/expiry in the create body", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = input.toString();
      if (url.includes("/v1/organizations/org_1/api-keys")) {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            id: "key_1",
            name: "my-key",
            scopes: ["audits:read"],
            token: "sq_tok",
            prefix: "sq_to",
            keyEnv: "production",
            expiresAt: "2026-04-01T00:00:00.000Z",
          }),
          { status: 201 }
        );
      }
      return new Response(
        JSON.stringify({
          organizations: [{ id: "org_1", name: "Acme Inc", role: "owner" }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await createApiKey({
      name: "my-key",
      scopes: ["audits:read"],
      expiresDays: 30,
    });

    expect(result.ok).toBe(true);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.name).toBe("my-key");
    expect(capturedBody!.scopes).toEqual(["audits:read"]);
    expect(typeof capturedBody!.expiresAt).toBe("string");
  });

  test("surfaces the typed error envelope's message (not [object Object]) #929", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/v1/organizations/org_1/api-keys")) {
        // The API now returns the typed envelope { error: { code, message } }.
        return new Response(
          JSON.stringify({
            error: {
              code: "RESERVED_SCOPE",
              message: 'Scope "keys:write" is reserved and cannot be granted',
            },
          }),
          { status: 400 }
        );
      }
      return new Response(
        JSON.stringify({
          organizations: [{ id: "org_1", name: "Acme Inc", role: "owner" }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await createApiKey();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("API_ERROR");
    expect(result.error.message).toBe(
      'Scope "keys:write" is reserved and cannot be granted'
    );
    expect(result.error.message).not.toContain("object Object");
  });

  test("requires a login session — errors clearly when the active credential is an API key", async () => {
    stubbedAuth = null;
    process.env[API_TOKEN_ENV_VAR] = "sq_someorgkey";

    const result = await createApiKey();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LOGIN_REQUIRED");
    expect(result.error.message).toContain("squirrel auth login");
  });

  test("requires a login session — errors clearly when unauthenticated", async () => {
    stubbedAuth = null;

    const result = await createApiKey();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LOGIN_REQUIRED");
  });
});

describe("defaultKeyName", () => {
  test("formats cli-<hostname>-<yyyymmdd>", () => {
    const name = defaultKeyName(new Date("2026-03-05T12:00:00Z"));
    expect(name).toMatch(/^cli-.+-20260305$/);
  });
});

describe("parseScopes", () => {
  test("dedupes and validates known scopes", () => {
    const result = parseScopes(["audits:read", "audits:read", "credits:read"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.data].sort()).toEqual(["audits:read", "credits:read"]);
  });

  test("rejects an unknown scope", () => {
    const result = parseScopes(["not:a:scope"]);
    expect(result.ok).toBe(false);
  });

  test("rejects a reserved scope (keys:write)", () => {
    const result = parseScopes(["keys:write"]);
    expect(result.ok).toBe(false);
  });
});
