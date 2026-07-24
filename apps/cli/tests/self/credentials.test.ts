// Credential precedence resolution (issue #159/epic #154, SQUIRRELSCAN_API_KEY
// rename #670):
//   env SQUIRRELSCAN_API_KEY (authoritative) → env SQUIRREL_API_TOKEN
//   (back-compat alias, authoritative too) → settings.json login → none.
//
// The login session is stubbed via spyOn — os.homedir() caches its value at
// first call within a process and ignores later HOME changes, so a temp-HOME
// approach is NOT reliable for isolating ~/.squirrel/settings.json in-process.
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

import { commandError, err, ok } from "@/controllers/types";
import * as settingsModule from "@/self/settings";

// Mutable stub state for the login session that resolveCredential reads.
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

const {
  API_TOKEN_ENV_VAR,
  LEGACY_API_TOKEN_ENV_VAR,
  activeEnvTokenVar,
  describeEnvToken,
  envTokenRejectedMessage,
  getEnvApiToken,
  isEnvTokenSet,
  resolveCredential,
  warnIfSessionUnreadable,
} = await import("@/self/credentials");

const originalEnv = { ...process.env };

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

function setLoginSession(token: string, expiresAt: string): void {
  stubbedAuth = {
    token,
    userId: "user_1",
    email: "you@example.com",
    name: "You",
    expiresAt,
  };
}

describe("resolveCredential precedence", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env[API_TOKEN_ENV_VAR];
    delete process.env[LEGACY_API_TOKEN_ENV_VAR];
    stubbedAuth = null;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    stubbedAuth = null;
  });

  test("env token wins and OVERRIDES a logged-in session", () => {
    setLoginSession("sqcli_loginsession", FUTURE);
    process.env[API_TOKEN_ENV_VAR] = "sq_envkey";

    const cred = resolveCredential();
    expect(cred).not.toBeNull();
    expect(cred?.source).toBe("env");
    expect(cred?.token).toBe("sq_envkey");
    // No expiry is known for an env token — validity is decided server-side.
    expect(cred?.expiresAt).toBeUndefined();
  });

  test("SQUIRRELSCAN_API_KEY beats the SQUIRREL_API_TOKEN alias when both are set", () => {
    process.env[API_TOKEN_ENV_VAR] = "sq_preferred";
    process.env[LEGACY_API_TOKEN_ENV_VAR] = "sq_legacy";

    expect(getEnvApiToken()).toBe("sq_preferred");
    expect(activeEnvTokenVar()).toBe(API_TOKEN_ENV_VAR);
    const cred = resolveCredential();
    expect(cred?.source).toBe("env");
    expect(cred?.token).toBe("sq_preferred");
  });

  test("falls back to the SQUIRREL_API_TOKEN alias when the preferred var is unset (no warning, just works)", () => {
    setLoginSession("sqcli_loginsession", FUTURE);
    process.env[LEGACY_API_TOKEN_ENV_VAR] = "sq_legacykey";

    expect(getEnvApiToken()).toBe("sq_legacykey");
    expect(activeEnvTokenVar()).toBe(LEGACY_API_TOKEN_ENV_VAR);
    const cred = resolveCredential();
    expect(cred?.source).toBe("env");
    expect(cred?.token).toBe("sq_legacykey");
  });

  test("alias env token still OVERRIDES a logged-in session (matches preferred-var behavior)", () => {
    setLoginSession("sqcli_loginsession", FUTURE);
    process.env[LEGACY_API_TOKEN_ENV_VAR] = "sq_legacykey";

    const cred = resolveCredential();
    expect(cred?.source).toBe("env");
    expect(cred?.token).toBe("sq_legacykey");
  });

  test("empty/whitespace preferred var falls through to the alias", () => {
    process.env[API_TOKEN_ENV_VAR] = "   ";
    process.env[LEGACY_API_TOKEN_ENV_VAR] = "sq_legacykey";

    expect(getEnvApiToken()).toBe("sq_legacykey");
    expect(activeEnvTokenVar()).toBe(LEGACY_API_TOKEN_ENV_VAR);
  });

  test("activeEnvTokenVar is null when neither env var is set", () => {
    setLoginSession("sqcli_loginsession", FUTURE);
    expect(activeEnvTokenVar()).toBeNull();
  });

  test("falls back to login session when env var is unset", () => {
    setLoginSession("sqcli_loginsession", FUTURE);

    const cred = resolveCredential();
    expect(cred?.source).toBe("login");
    expect(cred?.token).toBe("sqcli_loginsession");
    expect(cred?.expiresAt).toBe(FUTURE);
  });

  test("empty / whitespace env var behaves like unset (uses login)", () => {
    setLoginSession("sqcli_loginsession", FUTURE);
    for (const empty of ["", "   ", "\t\n"]) {
      process.env[API_TOKEN_ENV_VAR] = empty;
      expect(getEnvApiToken()).toBeNull();
      expect(isEnvTokenSet()).toBe(false);
      expect(resolveCredential()?.source).toBe("login");
    }
  });

  test("env token is trimmed", () => {
    process.env[API_TOKEN_ENV_VAR] = "  sq_envkey  ";
    expect(getEnvApiToken()).toBe("sq_envkey");
    expect(resolveCredential()?.token).toBe("sq_envkey");
  });

  test("unauthenticated when no env var and no login session", () => {
    expect(resolveCredential()).toBeNull();
  });

  test("expired login session reads as unauthenticated (no env var)", () => {
    setLoginSession("sqcli_old", PAST);
    expect(resolveCredential()).toBeNull();
  });

  test("env token is used EVEN when the login session is expired (fail-closed, no fall-back)", () => {
    setLoginSession("sqcli_old", PAST);
    process.env[API_TOKEN_ENV_VAR] = "sq_envkey";
    const cred = resolveCredential();
    expect(cred?.source).toBe("env");
    expect(cred?.token).toBe("sq_envkey");
  });

  test("env token resolution does NOT mutate the login session (never persisted)", () => {
    setLoginSession("sqcli_loginsession", FUTURE);
    process.env[API_TOKEN_ENV_VAR] = "sq_envkey";

    resolveCredential();
    // The login session the resolver reads is untouched — the env token is read
    // straight from process.env and is never written back into settings.
    expect(stubbedAuth?.token).toBe("sqcli_loginsession");
  });
});

describe("describeEnvToken", () => {
  test("labels API keys by env and login tokens distinctly", () => {
    expect(describeEnvToken("sq_abc")).toBe("API key");
    expect(describeEnvToken("sq_dev_abc")).toBe("API key (development)");
    expect(describeEnvToken("sqcli_abc")).toBe("login token");
  });
});

describe("envTokenRejectedMessage (fail-closed)", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("names the env var and does NOT leak the token value", () => {
    process.env[API_TOKEN_ENV_VAR] = "sq_supersecretvalue";
    const msg = envTokenRejectedMessage();
    expect(msg).toContain(API_TOKEN_ENV_VAR);
    expect(msg).toContain("authoritative");
    expect(msg).not.toContain("sq_supersecretvalue");
  });

  test("adds a cross-env hint for a dev key", () => {
    process.env[API_TOKEN_ENV_VAR] = "sq_dev_abc";
    const msg = envTokenRejectedMessage();
    expect(msg).toContain("development key");
  });

  test("names the legacy alias (not the preferred var) when that's what's set", () => {
    delete process.env[API_TOKEN_ENV_VAR];
    process.env[LEGACY_API_TOKEN_ENV_VAR] = "sq_supersecretvalue";
    const msg = envTokenRejectedMessage();
    expect(msg).toContain(LEGACY_API_TOKEN_ENV_VAR);
    expect(msg).not.toContain(API_TOKEN_ENV_VAR);
  });
});

// #1062: the loud "session could not be loaded" warning (#805) was wired
// into `squirrel audit` only. warnIfSessionUnreadable() is the single shared
// implementation now called from every command entry (report, config, self,
// MCP) — this covers the implementation directly since command-level tests
// would need to shell out to citty's runMain, which these files intentionally
// avoid (see apps/cli/MEMORY.md on process.exit() footguns in command tests).
describe("warnIfSessionUnreadable", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    loadUserSettingsSpy.mockImplementation(() =>
      ok({ ...settingsModule.DEFAULT_SETTINGS, auth: stubbedAuth })
    );
    process.env = { ...originalEnv };
  });

  test("prints the loud warning when the passed Result is err (corrupt/unreadable session)", () => {
    const badResult = err(
      commandError("FILE_READ_ERROR", "Failed to read settings: EACCES")
    );

    warnIfSessionUnreadable(badResult);

    expect(errorSpy).toHaveBeenCalled();
    const printed = errorSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join("\n");
    expect(printed).toContain("session could not be loaded");
    expect(printed).toContain("FILE_READ_ERROR");
  });

  test("stays silent when the passed Result is ok (genuinely logged out or fine)", () => {
    warnIfSessionUnreadable(ok({ ...settingsModule.DEFAULT_SETTINGS }));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("loads settings itself and warns when called with no argument (report/config/self/mcp entry usage)", () => {
    loadUserSettingsSpy.mockImplementation(() =>
      err(commandError("FILE_READ_ERROR", "Failed to read settings: EACCES"))
    );

    warnIfSessionUnreadable();

    expect(errorSpy).toHaveBeenCalled();
    const printed = errorSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join("\n");
    expect(printed).toContain("session could not be loaded");
  });

  // Review finding on #1062: resolveCredential() checks the env token FIRST
  // and never consults settings.json when it's set, so a broken session file
  // is irrelevant to auth in that case — warning anyway produced a
  // contradictory "running anonymous" message right next to "Authenticated as
  // ... (env)" in `auth status`/`whoami`.
  test("stays silent on an err Result when an env token is set (settings.json is irrelevant to auth in that case)", () => {
    process.env[API_TOKEN_ENV_VAR] = "sq_envkey";
    const badResult = err(
      commandError("FILE_READ_ERROR", "Failed to read settings: EACCES")
    );

    warnIfSessionUnreadable(badResult);

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
