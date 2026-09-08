// `squirrel auth whoami` / `auth status` must name the org the credential acts
// for (#1971). `/v1/auth/whoami` runs under `cliTokenAuth` alone with no
// orgContext, so it resolves no org for a login session — the CLI has to ask
// separately, and it must ask for the ACTIVE org (`users.activeOrgId`, what
// gets charged) rather than the first row of the membership list. On a two-org
// account those are different orgs, which is the whole bug: a key was minted
// against one while audits spent the other.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { runAuthStatus } from "@/controllers/auth/status";
import { ok } from "@/controllers/types";
import * as settingsModule from "@/self/settings";

const API_KEY_ENV = "SQUIRRELSCAN_API_KEY"; // pragma: allowlist secret
const API_SERVER_ENV = "SQUIRREL_API_SERVER";
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

// Newest-first, as GET /v1/organizations orders them. `org_new` leads the list;
// `org_old` is the active one.
const ORGS = [
  {
    id: "org_new",
    slug: "squirrelscan-e2e",
    name: "squirrelscan e2e (internal)",
    role: "owner",
  },
  { id: "org_old", slug: "nikz", name: "Nik Cubrilovic", role: "owner" },
];

let server: ReturnType<typeof Bun.serve> | null = null;
let settingsSpy: { mockRestore: () => void } | null = null;
const saved: Record<string, string | undefined> = {};

interface ServeOptions {
  activeOrgId?: string | null;
  /** Status for /v1/hydrate (non-200 exercises the best-effort fall-back). */
  hydrateStatus?: number;
  organizations?: unknown[];
}

function serve(options: ServeOptions = {}): { hydrateCalls: number } {
  const counters = { hydrateCalls: 0 };
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/v1/auth/whoami") {
        return Response.json({
          user: { id: "user_1", email: "you@example.com", name: "You" },
          token: { deviceName: "air.local", expiresAt: FUTURE },
        });
      }
      if (pathname === "/v1/hydrate") {
        counters.hydrateCalls += 1;
        if (options.hydrateStatus && options.hydrateStatus !== 200) {
          return Response.json(
            { error: "nope" },
            {
              status: options.hydrateStatus,
            }
          );
        }
        return Response.json({
          organizations: options.organizations ?? ORGS,
          activeOrgId:
            options.activeOrgId === undefined ? "org_old" : options.activeOrgId,
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  process.env[API_SERVER_ENV] = `http://127.0.0.1:${server.port}`;
  return counters;
}

function stubLoginSession(): void {
  settingsSpy = spyOn(settingsModule, "loadUserSettings").mockImplementation(
    () =>
      ok({
        ...settingsModule.DEFAULT_SETTINGS,
        auth: {
          token: "sqcli_loginsession",
          userId: "user_1",
          email: "you@example.com",
          name: "You",
          expiresAt: FUTURE,
        },
      })
  );
}

beforeEach(() => {
  for (const key of [API_KEY_ENV, API_SERVER_ENV, "SQUIRREL_API_TOKEN"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  stubLoginSession();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  settingsSpy?.mockRestore();
  settingsSpy = null;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("auth status on a login session", () => {
  test("reports the ACTIVE org's id and slug, not the first of the list", async () => {
    serve();

    const result = await runAuthStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.org?.id).toBe("org_old");
    expect(result.data.org?.slug).toBe("nikz");
    expect(result.data.org?.name).toBe("Nik Cubrilovic");
    // The org the old `keys create` would have used.
    expect(result.data.org?.id).not.toBe("org_new");
  });

  test("reports how many orgs the account has, so >1 is visible", async () => {
    serve();

    const result = await runAuthStatus();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.orgCount).toBe(2);
  });

  test("a single-org account reports that org with orgCount 1", async () => {
    serve({ organizations: [ORGS[1]], activeOrgId: "org_old" });

    const result = await runAuthStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.org?.slug).toBe("nikz");
    expect(result.data.orgCount).toBe(1);
  });

  test("an active org id with no membership row still names the id", async () => {
    serve({ activeOrgId: "org_gone" });

    const result = await runAuthStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.org?.id).toBe("org_gone");
    expect(result.data.org?.slug).toBeNull();
  });

  test("no active org set server-side leaves the org lines off", async () => {
    serve({ activeOrgId: null });

    const result = await runAuthStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.org).toBeUndefined();
    expect(result.data.orgCount).toBe(2);
  });

  test("BEST-EFFORT: the org lookup failing does not fail auth status", async () => {
    serve({ hydrateStatus: 500 });

    const result = await runAuthStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Identity still reported; only the org lines are missing.
    expect(result.data.user.email).toBe("you@example.com");
    expect(result.data.org).toBeUndefined();
    expect(result.data.orgCount).toBeUndefined();
  });

  test("a sqcli_ login token supplied through the env var still gets the org", async () => {
    // The lookup keys on the TOKEN TYPE, not on where it was stored: an env-
    // supplied login token authenticates at whoami exactly like a stored one.
    settingsSpy?.mockRestore();
    settingsSpy = spyOn(settingsModule, "loadUserSettings").mockImplementation(
      () => ok({ ...settingsModule.DEFAULT_SETTINGS, auth: null })
    );
    const counters = serve();
    process.env[API_KEY_ENV] = "sqcli_envsuppliedloginsession";

    const result = await runAuthStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.source).toBe("env");
    expect(result.data.org?.slug).toBe("nikz");
    expect(counters.hydrateCalls).toBe(1);
  });

  test("an sq_ API key does NOT trigger the org lookup", async () => {
    // The org routes reject API keys, so the call would only ever 401.
    settingsSpy?.mockRestore();
    settingsSpy = spyOn(settingsModule, "loadUserSettings").mockImplementation(
      () => ok({ ...settingsModule.DEFAULT_SETTINGS, auth: null })
    );
    const counters = serve();
    process.env[API_KEY_ENV] = "sq_anorgapikeyanorgapikeyanorg"; // pragma: allowlist secret

    await runAuthStatus();
    expect(counters.hydrateCalls).toBe(0);
  });

  test("the org lookup runs once per status call", async () => {
    const counters = serve();

    await runAuthStatus();
    expect(counters.hydrateCalls).toBe(1);
  });
});
