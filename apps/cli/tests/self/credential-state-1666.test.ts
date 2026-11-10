// The credential state, and the one note a command prints when the stored login cannot be used (#1666).
//
// Settings are stubbed with spyOn, as in credentials.test.ts: os.homedir() caches its value, so a
// temp HOME is not reliable in-process. The subprocess test in tests/cli/ covers the real file.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import type { UserSettings } from "@/self/types";

import { ok } from "@/controllers/types";
import * as settingsModule from "@/self/settings";

type Auth = NonNullable<UserSettings["auth"]>;
let stubbedAuth: Auth | null = null;
const updates: Array<Partial<UserSettings>> = [];

const loadSpy = spyOn(settingsModule, "loadUserSettings").mockImplementation(
  () => ok({ ...settingsModule.DEFAULT_SETTINGS, auth: stubbedAuth })
);
const updateSpy = spyOn(settingsModule, "updateSettings").mockImplementation(
  (u) => {
    updates.push(u);
    return ok({ ...settingsModule.DEFAULT_SETTINGS, ...u });
  }
);
afterAll(() => {
  loadSpy.mockRestore();
  updateSpy.mockRestore();
});

const {
  credentialState,
  deriveCredentialState,
  markLoginRejected,
  noteStaleLogin,
  REJECTED_LOGIN_TTL_MS,
  resolveCredential,
  setStaleLoginNoted,
  staleLoginNote,
  warnIfSessionUnreadable,
} = await import("@/self/credentials");

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const FUTURE = new Date(NOW + 86_400_000).toISOString();
const PAST = new Date(NOW - 86_400_000).toISOString();
const RECENT = new Date(NOW - 3_600_000).toISOString();

const auth = (over: Partial<Auth> = {}): Auth => ({
  token: "sqcli_test",
  userId: "u1",
  email: "you@example.com",
  name: null,
  expiresAt: FUTURE,
  ...over,
});

describe("deriveCredentialState", () => {
  const table: Array<
    [string, { envToken: boolean; auth: Auth | undefined }, string]
  > = [
    [
      "an env token wins over everything",
      { envToken: true, auth: auth({ rejectedAt: RECENT }) },
      "env",
    ],
    ["no login and no env", { envToken: false, auth: undefined }, "none"],
    [
      "an empty token is none",
      { envToken: false, auth: auth({ token: "" }) },
      "none",
    ],
    ["a live login", { envToken: false, auth: auth() }, "login"],
    [
      "an expired login",
      { envToken: false, auth: auth({ expiresAt: PAST }) },
      "expired",
    ],
    [
      "a rejected login",
      { envToken: false, auth: auth({ rejectedAt: RECENT }) },
      "rejected",
    ],
    [
      "rejected outranks expired",
      { envToken: false, auth: auth({ rejectedAt: RECENT, expiresAt: PAST }) },
      "rejected",
    ],
    [
      "a rejection older than the window is tried again",
      {
        envToken: false,
        auth: auth({
          rejectedAt: new Date(NOW - REJECTED_LOGIN_TTL_MS - 1).toISOString(),
        }),
      },
      "login",
    ],
    [
      "a rejection exactly at the window is tried again",
      {
        envToken: false,
        auth: auth({
          rejectedAt: new Date(NOW - REJECTED_LOGIN_TTL_MS).toISOString(),
        }),
      },
      "login",
    ],
    [
      "an unreadable rejection stamp fails closed",
      { envToken: false, auth: auth({ rejectedAt: "garbage" }) },
      "rejected",
    ],
    [
      "an unreadable expiry fails closed, as telemetry does",
      { envToken: false, auth: auth({ expiresAt: "garbage" }) },
      "expired",
    ],
    [
      "an expiry of exactly now is expired",
      {
        envToken: false,
        auth: auth({ expiresAt: new Date(NOW).toISOString() }),
      },
      "expired",
    ],
  ];
  for (const [name, input, expected] of table) {
    test(`${name}: ${expected}`, () => {
      expect(deriveCredentialState({ ...input, now: NOW })).toBe(
        expected as ReturnType<typeof deriveCredentialState>
      );
    });
  }
});

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.SQUIRRELSCAN_API_KEY;
  delete process.env.SQUIRREL_API_TOKEN;
  delete process.env.SQUIRREL_API_SERVER;
  stubbedAuth = null;
  updates.length = 0;
  setStaleLoginNoted(false);
});
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("resolveCredential never sends a login that cannot work", () => {
  test("a rejected login resolves to nothing, so no request carries it", () => {
    stubbedAuth = auth({ rejectedAt: new Date().toISOString() });
    expect(resolveCredential()).toBeNull();
    expect(credentialState()).toBe("rejected");
  });

  test("an expired login resolves to nothing", () => {
    stubbedAuth = auth({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(resolveCredential()).toBeNull();
    expect(credentialState()).toBe("expired");
  });

  test("a live login still resolves", () => {
    stubbedAuth = auth({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(resolveCredential()?.source).toBe("login");
  });
});

describe("markLoginRejected", () => {
  test("stamps the stored login that was rejected, keeping the rest of it", () => {
    stubbedAuth = auth();
    markLoginRejected("sqcli_test");
    expect(updates).toHaveLength(1);
    const written = updates[0]!.auth!;
    expect(written.token).toBe("sqcli_test");
    expect(written.email).toBe("you@example.com");
    expect(Date.parse(written.rejectedAt!)).not.toBeNaN();
  });

  test("a token that is not the stored login (an env token, or a replaced login) writes nothing", () => {
    stubbedAuth = auth();
    markLoginRejected("sq_env_key");
    expect(updates).toEqual([]);
  });

  test("a rejection still inside the window is not rewritten; one past it is refreshed", () => {
    stubbedAuth = auth({
      rejectedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    markLoginRejected("sqcli_test");
    expect(updates).toEqual([]);
    stubbedAuth = auth({
      rejectedAt: new Date(
        Date.now() - REJECTED_LOGIN_TTL_MS - 60_000
      ).toISOString(),
    });
    markLoginRejected("sqcli_test");
    expect(updates).toHaveLength(1);
  });

  test("with no login stored it writes nothing", () => {
    markLoginRejected("sqcli_test");
    expect(updates).toEqual([]);
  });

  test("a 401 from an overridden API host says nothing about the production login: nothing is written", () => {
    stubbedAuth = auth();
    for (const server of [
      "http://localhost:8787",
      "http://127.0.0.1:1",
      "https://staging.example.com",
    ]) {
      process.env.SQUIRREL_API_SERVER = server;
      markLoginRejected("sqcli_test");
    }
    expect(updates).toEqual([]);
  });
});

describe("which 401s mark a login rejected", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function request(path: string, status = 401): Promise<void> {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { status })
      )) as unknown as typeof fetch;
    const { cliApi } = await import("@/lib/api-client");
    await cliApi.request(path, { auth: "required" });
  }
  const live = () =>
    auth({ expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

  test("a 401 on an account route (/v1/auth/*) marks it", async () => {
    stubbedAuth = live();
    await request("/v1/auth/whoami");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.auth!.rejectedAt).toBeTruthy();
  });

  test("a 401 on any other route does not: it may be a gateway glitch, not the token's death", async () => {
    stubbedAuth = live();
    for (const path of [
      "/v1/organizations",
      "/v1/agent-runs/register",
      "/v1/reports",
      "/v1/credits/balance",
    ]) {
      await request(path);
    }
    expect(updates).toEqual([]);
  });

  test("a 401 on an account route from an overridden host does not mark it", async () => {
    stubbedAuth = live();
    process.env.SQUIRREL_API_SERVER = "http://localhost:8787";
    await request("/v1/auth/whoami");
    expect(updates).toEqual([]);
  });

  test("a 200 on an account route does not", async () => {
    stubbedAuth = live();
    await request("/v1/auth/whoami", 200);
    expect(updates).toEqual([]);
  });
});

describe("the note", () => {
  const capture = () => {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => void lines.push(args.join(" "))
    );
    return { lines, restore: () => spy.mockRestore() };
  };

  test("only expired and rejected have a note, and both name `squirrel auth login`", () => {
    expect(staleLoginNote("expired")).toContain("expired");
    expect(staleLoginNote("expired")).toContain("squirrel auth login");
    expect(staleLoginNote("rejected")).toContain("rejected");
    expect(staleLoginNote("rejected")).toContain("squirrel auth login");
    for (const state of ["env", "login", "none"] as const)
      expect(staleLoginNote(state)).toBeNull();
  });

  test("an expired login prints one note, however many times the entry point runs", () => {
    stubbedAuth = auth({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const c = capture();
    warnIfSessionUnreadable();
    warnIfSessionUnreadable();
    noteStaleLogin();
    c.restore();
    expect(
      c.lines.filter((l) => l.includes("squirrel auth login"))
    ).toHaveLength(1);
    expect(c.lines.join("\n")).toContain("expired");
  });

  test("a rejected login prints its own note", () => {
    stubbedAuth = auth({ rejectedAt: new Date().toISOString() });
    const c = capture();
    warnIfSessionUnreadable();
    c.restore();
    expect(c.lines.join("\n")).toContain("rejected");
  });

  test("a live login, no login and an env token print nothing", () => {
    const c = capture();
    stubbedAuth = auth({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    warnIfSessionUnreadable();
    stubbedAuth = null;
    warnIfSessionUnreadable();
    stubbedAuth = auth({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    process.env.SQUIRRELSCAN_API_KEY = "sq_live_abc";
    warnIfSessionUnreadable();
    c.restore();
    expect(c.lines).toEqual([]);
  });

  test("a command that reports the state itself can silence the note", () => {
    stubbedAuth = auth({ rejectedAt: new Date().toISOString() });
    setStaleLoginNoted(true);
    const c = capture();
    warnIfSessionUnreadable();
    c.restore();
    expect(c.lines).toEqual([]);
  });
});
