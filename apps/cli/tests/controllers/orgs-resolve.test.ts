// Shared org resolution (#1971). The bug this covers: `keys create` took the
// FIRST org of a newest-first membership list, so an account that gained a
// second org silently started minting live credentials against it — while
// audits kept spending the ACTIVE org's credits. Two different orgs, neither
// printed anywhere.
//
// Network is a global fetch stub (the repo's pattern for cliApi calls); the
// login session is a spyOn of loadUserSettings, NOT mock.module — see the note
// at the top of keys-create.test.ts for why.

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

const {
  describeOrg,
  fetchActiveOrgContext,
  formatOrgChoices,
  listOrgs,
  matchOrg,
  resolveKeyOrg,
} = await import("@/controllers/orgs/resolve");
const { API_TOKEN_ENV_VAR, LEGACY_API_TOKEN_ENV_VAR } =
  await import("@/self/credentials");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

// Shaped like the real payload of a two-org account: the membership list is
// newest-first, so the org created LAST leads it while the active org (where
// credits are spent) is the older one.
const ACME_CI_ORG = {
  id: "01ACME000000000000000000CI",
  slug: "acme-ci",
  name: "Acme CI (internal)",
  role: "owner",
};
const ACME_ORG = {
  id: "org_user_acme00000000000000000000000",
  slug: "acme",
  name: "Acme Inc",
  role: "owner",
};
const ORGS = [ACME_CI_ORG, ACME_ORG];

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

interface StubOptions {
  organizations?: unknown[];
  orgsStatus?: number;
  /** `undefined` = /v1/hydrate fails outright (transport error). */
  activeOrgId?: string | null;
  hydrateFails?: boolean;
}

function stubFetch(options: StubOptions = {}): { hydrateCalls: number } {
  const counters = { hydrateCalls: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    if (url.includes("/v1/hydrate")) {
      counters.hydrateCalls += 1;
      if (options.hydrateFails) throw new Error("offline");
      return new Response(
        JSON.stringify({
          organizations: options.organizations ?? ORGS,
          activeOrgId: options.activeOrgId ?? null,
        }),
        { status: 200 }
      );
    }
    if (url.includes("/v1/organizations")) {
      return new Response(
        JSON.stringify({ organizations: options.organizations ?? ORGS }),
        { status: options.orgsStatus ?? 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return counters;
}

describe("listOrgs", () => {
  test("returns every membership with slug, name and role", async () => {
    stubFetch();
    const result = await listOrgs();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((o) => o.slug)).toEqual(["acme-ci", "acme"]);
    expect(result.data[1].id).toBe(ACME_ORG.id);
    expect(result.data[1].role).toBe("owner");
  });

  test("drops rows with no id rather than building /organizations/undefined/...", async () => {
    stubFetch({ organizations: [{ slug: "ghost" }, ACME_ORG] });
    const result = await listOrgs();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
  });

  test("an empty membership list is NO_ORGANIZATION, not an empty success", async () => {
    stubFetch({ organizations: [] });
    const result = await listOrgs();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_ORGANIZATION");
  });

  test("401 names the expired session rather than a missing org", async () => {
    stubFetch({ orgsStatus: 401 });
    const result = await listOrgs();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_AUTHENTICATED");
  });
});

describe("matchOrg", () => {
  const orgs = [
    { ...ACME_CI_ORG, name: ACME_CI_ORG.name as string | null },
    { ...ACME_ORG, name: ACME_ORG.name as string | null },
  ];

  test("matches an exact slug", () => {
    const result = matchOrg(orgs, "acme");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe(ACME_ORG.id);
  });

  test("matches an exact id", () => {
    const result = matchOrg(orgs, ACME_CI_ORG.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.slug).toBe("acme-ci");
  });

  test("slug matching is case-insensitive (slugs are lowercased server-side)", () => {
    const result = matchOrg(orgs, "AcMe");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.slug).toBe("acme");
  });

  test("does NOT prefix-match — a partial slug is refused, not guessed", () => {
    const result = matchOrg(orgs, "acm");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ORG_NOT_FOUND");
  });

  test("an unknown org lists the real ones so the next attempt can succeed", () => {
    const result = matchOrg(orgs, "nope-inc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("acme");
      expect(result.error.message).toContain("acme-ci");
    }
  });

  test("an empty --org value is rejected", () => {
    const result = matchOrg(orgs, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_ORG");
  });
});

describe("fetchActiveOrgContext", () => {
  test("resolves the active org to its membership row", async () => {
    stubFetch({ activeOrgId: ACME_ORG.id });
    const context = await fetchActiveOrgContext();
    expect(context?.activeOrgId).toBe(ACME_ORG.id);
    expect(context?.active?.slug).toBe("acme");
    expect(context?.orgs).toHaveLength(2);
  });

  test("an active org id with no membership row still reports the id", async () => {
    stubFetch({ activeOrgId: "org_gone" });
    const context = await fetchActiveOrgContext();
    expect(context?.activeOrgId).toBe("org_gone");
    expect(context?.active).toBeNull();
  });

  test("BEST-EFFORT: a transport failure returns null, it does not throw", async () => {
    stubFetch({ hydrateFails: true });
    expect(await fetchActiveOrgContext()).toBeNull();
  });
});

describe("resolveKeyOrg", () => {
  test("a single-org account needs no --org", async () => {
    const counters = stubFetch({ organizations: [ACME_ORG] });
    const result = await resolveKeyOrg();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.slug).toBe("acme");
    // The sole-org path must not pay for the heavy hydrate call.
    expect(counters.hydrateCalls).toBe(0);
  });

  test("REFUSES to pick when the account has two orgs (#1971)", async () => {
    stubFetch({ activeOrgId: ACME_ORG.id });
    const result = await resolveKeyOrg();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ORG_REQUIRED");
      // The old behaviour would have silently used this one (first, newest).
      expect(result.error.message).toContain("acme-ci");
      expect(result.error.message).toContain("acme");
      expect(result.error.message).toContain("--org");
    }
  });

  test("the refusal marks which org audits already spend from", async () => {
    stubFetch({ activeOrgId: ACME_ORG.id });
    const result = await resolveKeyOrg();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const activeLine = result.error.message
        .split("\n")
        .find((l) => l.includes("[active]"));
      expect(activeLine).toContain("acme");
    }
  });

  test("the refusal still lists the orgs when the active lookup fails", async () => {
    stubFetch({ hydrateFails: true });
    const result = await resolveKeyOrg();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ORG_REQUIRED");
      expect(result.error.message).toContain("acme");
      expect(result.error.message).not.toContain("[active]");
    }
  });

  test("an explicit --org is honoured over the list order", async () => {
    stubFetch();
    const result = await resolveKeyOrg("acme");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe(ACME_ORG.id);
  });

  test("an explicit --org that is not a membership is refused, not sent", async () => {
    stubFetch();
    const result = await resolveKeyOrg("someone-elses-org");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ORG_NOT_FOUND");
  });
});

describe("formatting helpers", () => {
  test("describeOrg pairs slug with name", () => {
    expect(describeOrg({ ...ACME_ORG })).toBe("acme (Acme Inc)");
  });

  test("describeOrg falls back to the id when there is no slug", () => {
    expect(describeOrg({ ...ACME_ORG, slug: "", name: null })).toBe(
      ACME_ORG.id
    );
  });

  test("formatOrgChoices prints the id of every org", () => {
    const text = formatOrgChoices(
      [{ ...ACME_ORG }, { ...ACME_CI_ORG }],
      ACME_CI_ORG.id
    );
    expect(text).toContain(`id: ${ACME_ORG.id}`);
    expect(text).toContain(`id: ${ACME_CI_ORG.id}`);
    expect(text).toContain("[active]");
  });
});
