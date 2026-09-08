// `squirrel keys list` across orgs (#1971). A key belongs to exactly one org
// and the old listing showed one org's keys with no label, so on a two-org
// account there was no way to tell which org a key would spend from.
//
// Network is a global fetch stub; the login session is a spyOn of
// loadUserSettings, NOT mock.module — see keys-create.test.ts for why.

import type { ArgsDef, CommandContext } from "citty";

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

const { listApiKeys } = await import("@/controllers/keys/list");
const { keys: keysCommand } = await import("@/cli/commands/keys");
const { API_TOKEN_ENV_VAR, LEGACY_API_TOKEN_ENV_VAR } =
  await import("@/self/credentials");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

const ORGS = [
  {
    id: "org_new",
    slug: "squirrelscan-e2e",
    name: "squirrelscan e2e (internal)",
    role: "owner",
  },
  { id: "org_old", slug: "nikz", name: "Nik Cubrilovic", role: "member" },
];

function apiKey(id: string, prefix: string): Record<string, unknown> {
  return {
    id,
    name: id,
    prefix,
    scopes: ["audits:read"],
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

/** Per-org key responses keyed by org id; a number value means that status. */
function stubFetch(byOrg: Record<string, unknown[] | number>): {
  listed: string[];
} {
  const listed: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    const match = url.match(/\/v1\/organizations\/([^/]+)\/api-keys/);
    if (match) {
      const orgId = match[1]!;
      listed.push(orgId);
      const entry = byOrg[orgId];
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
  return { listed };
}

describe("listApiKeys", () => {
  test("lists every org the user belongs to, each keyed to its org", async () => {
    const { listed } = stubFetch({
      org_new: [apiKey("key_e2e", "sq_eee")],
      org_old: [apiKey("key_nikz", "sq_nnn")],
    });

    const result = await listApiKeys();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listed.sort()).toEqual(["org_new", "org_old"]);
    expect(result.data.orgs.map((entry) => entry.org.slug)).toEqual([
      "squirrelscan-e2e",
      "nikz",
    ]);
    expect(result.data.orgs[1].keys[0].id).toBe("key_nikz");
  });

  test("--org narrows to one org and skips the others entirely", async () => {
    const { listed } = stubFetch({ org_old: [apiKey("key_nikz", "sq_nnn")] });

    const result = await listApiKeys({ org: "nikz" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listed).toEqual(["org_old"]);
    expect(result.data.orgs).toHaveLength(1);
    expect(result.data.orgs[0].org.slug).toBe("nikz");
  });

  test("an unknown --org is refused before any key request", async () => {
    const { listed } = stubFetch({});

    const result = await listApiKeys({ org: "acme" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ORG_NOT_FOUND");
    expect(listed).toEqual([]);
  });

  test("an org the user cannot read (403 for a plain member) is reported, not fatal", async () => {
    stubFetch({
      org_new: [apiKey("key_e2e", "sq_eee")],
      org_old: 403,
    });

    const result = await listApiKeys();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orgs[0].keys).toHaveLength(1);
    expect(result.data.orgs[1].error).toContain("Insufficient permissions");
    expect(result.data.orgs[1].keys).toEqual([]);
  });

  test("every org failing IS a command failure — there is nothing to show", async () => {
    stubFetch({ org_new: 403, org_old: 403 });

    const result = await listApiKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("API_ERROR");
  });

  test("an org with no keys comes back as an empty group, not an omission", async () => {
    stubFetch({ org_new: [], org_old: [apiKey("key_nikz", "sq_nnn")] });

    const result = await listApiKeys();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orgs).toHaveLength(2);
    expect(result.data.orgs[0].keys).toEqual([]);
  });

  test("requires a login session (the API rejects a key listing keys)", async () => {
    stubbedAuth = null;
    process.env[API_TOKEN_ENV_VAR] = "sq_someorgkey";

    const result = await listApiKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LOGIN_REQUIRED");
  });
});

// The command layer, not the controller: `--json` prints a flat array on
// stdout, and an org whose keys could not be read must NOT vanish from it
// silently. A successfully empty org plus a failed one would otherwise render
// as `[]` with no signal at all that half the account was never searched.
describe("keys list --json partial failures", () => {
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;
  let errorSpy: ReturnType<typeof spyOn<Console, "error">>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  async function runList(args: Record<string, unknown>): Promise<void> {
    const list = (
      keysCommand.subCommands as Record<
        string,
        { run?: (context: CommandContext<ArgsDef>) => unknown }
      >
    ).list!;
    await list.run?.({ args } as unknown as CommandContext<ArgsDef>);
  }

  test("warns on stderr for every org whose keys could not be read", async () => {
    stubFetch({ org_new: [], org_old: 403 });

    await runList({ json: true });

    const stdout = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    const stderr = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    // stdout stays parseable JSON — the warning must not corrupt it.
    expect(JSON.parse(stdout)).toEqual([]);
    expect(stderr).toContain("nikz");
    expect(stderr).toContain("Insufficient permissions");
  });

  test("a fully readable account writes nothing to stderr", async () => {
    stubFetch({
      org_new: [apiKey("key_e2e", "sq_eee")],
      org_old: [apiKey("key_nikz", "sq_nnn")],
    });

    await runList({ json: true });

    const stdout = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(JSON.parse(stdout)).toHaveLength(2);
    expect(errorSpy.mock.calls).toHaveLength(0);
  });

  test("each key in the JSON array carries its org", async () => {
    stubFetch({
      org_new: [apiKey("key_e2e", "sq_eee")],
      org_old: [apiKey("key_nikz", "sq_nnn")],
    });

    await runList({ json: true });

    const rows = JSON.parse(
      logSpy.mock.calls.map((call) => call.join(" ")).join("\n")
    ) as Array<{ id: string; orgSlug: string; orgId: string }>;
    expect(rows.map((row) => row.orgSlug)).toEqual([
      "squirrelscan-e2e",
      "nikz",
    ]);
    expect(rows[1].orgId).toBe("org_old");
  });
});
