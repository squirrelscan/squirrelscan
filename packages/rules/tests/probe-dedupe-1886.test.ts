// squirrelscan#1886: security/unauthenticated-api and security/auth-endpoint-disclosure
// both probe a current-user endpoint such as /api/me. One audit requests it once
// (the anonymous GET is shared through the probe budget), and one exposure is one
// finding: auth-endpoint-disclosure when the answer carries a password, secret or
// the user record, unauthenticated-api otherwise. Also the release gate for the
// auth rule (#1920): a throttled, challenged, WAF-blocked or 5xx answer, and no
// candidate at all, are never a pass.

// oxlint-disable sonarjs/no-hardcoded-passwords -- the fixtures are fake leaked credentials, which is what the rules detect

import { afterEach, describe, expect, test } from "bun:test";

import { authEndpointDisclosureRule } from "../src/security/auth-endpoint-disclosure";
import { unauthenticatedApiRule } from "../src/security/unauthenticated-api";
import type { CheckResult, RuleContext } from "../src/types";
import {
  BASE,
  candidate,
  html,
  json,
  robots,
  ruleCtx,
  stubFetch,
  surface,
  type Route,
  type SentRequest,
} from "./helpers/graphql-server";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const ME = `${BASE}/api/me`;
const BCRYPT = "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW"; // pragma: allowlist secret

/** A user row serialized whole, password hash included. */
const LEAKY_USER = {
  id: 42,
  email: "jo@example.com",
  name: "Jo",
  encrypted_password: BCRYPT,
  sign_in_count: 17,
  current_sign_in_ip: "203.0.113.9",
};

/** The same user without anything auth-endpoint-disclosure reports. */
const PLAIN_USER = { id: 42, email: "jo@example.com", name: "Jo", phone: "+61 400 000 000" };

const meSurface = () => surface([candidate("/api/me", { method: "GET" })]);

/** Run both rules on ONE context (one audit, one probe budget), in either order. */
async function runBoth(
  routes: Record<string, Route>,
  opts: { authFirst?: boolean; ruleEnabled?: (id: string) => boolean } = {}
): Promise<{ api: CheckResult[]; auth: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const ctx: RuleContext = { ...ruleCtx({ surface: meSurface() }), ruleEnabled: opts.ruleEnabled };
  let api: CheckResult[];
  let auth: CheckResult[];
  if (opts.authFirst) {
    auth = (await authEndpointDisclosureRule.run(ctx)).checks;
    api = (await unauthenticatedApiRule.run(ctx)).checks;
  } else {
    api = (await unauthenticatedApiRule.run(ctx)).checks;
    auth = (await authEndpointDisclosureRule.run(ctx)).checks;
  }
  return { api, auth, sent: stub.sent };
}

const fails = (checks: CheckResult[]) => checks.filter((c) => c.status === "fail" || c.status === "warn");
const meRequests = (sent: SentRequest[]) => sent.filter((r) => r.url === ME);
const otherConvention: Record<string, Route> = {
  [`${BASE}/api/session`]: () => html(),
  [`${BASE}/api/auth/session`]: () => html(),
  [`${BASE}/api/user`]: () => html(),
};

describe("squirrelscan#1886: one request and one finding per endpoint", () => {
  for (const authFirst of [false, true]) {
    const order = authFirst ? "auth rule first" : "api rule first";

    test(`a leaked user record on /api/me is one finding (auth-endpoint-disclosure) and one request (${order})`, async () => {
      const { api, auth, sent } = await runBoth({ [ME]: () => json(LEAKY_USER), ...otherConvention }, { authFirst });
      expect(meRequests(sent)).toHaveLength(1);
      expect(fails(auth)).toHaveLength(1);
      expect(fails(auth)[0]?.details).toMatchObject({ endpoint: ME });
      expect(fails(api)).toHaveLength(0);
      const clean = api.find((c) => c.status === "pass");
      expect(clean?.details).toMatchObject({ deferredToAuth: 1 });
    });

    test(`records without a password, secret or user row stay with unauthenticated-api (${order})`, async () => {
      const { api, auth, sent } = await runBoth({ [ME]: () => json([PLAIN_USER, PLAIN_USER]), ...otherConvention }, { authFirst });
      expect(meRequests(sent)).toHaveLength(1);
      expect(fails(auth)).toHaveLength(0);
      expect(fails(api)).toHaveLength(1);
    });
  }

  for (const authFirst of [false, true]) {
    test(`a throttle in the auth rule never loses the finding (${authFirst ? "auth rule first" : "api rule first"})`, async () => {
      // unauthenticated-api probes call sites first (/api/me), then the literal (/api/session).
      // auth-endpoint-disclosure keeps discovery order: /api/session first, which answers 429,
      // so it stops sending before /api/me. api first: the auth rule reads the /api/me answer
      // already fetched and reports it. auth first: /api/me is left unread, so
      // unauthenticated-api keeps it. Either way one finding and one request.
      const stub = stubFetch({
        [ME]: () => json(LEAKY_USER),
        [`${BASE}/api/session`]: () => new Response("slow down", { status: 429 }),
      });
      restore = stub.restore;
      const ctx = ruleCtx({
        surface: surface([
          candidate("/api/session", { method: undefined, discoveredVia: "string-literal" }),
          candidate("/api/me", { method: "GET" }),
        ]),
      });
      let api: CheckResult[];
      let auth: CheckResult[];
      if (authFirst) {
        auth = (await authEndpointDisclosureRule.run(ctx)).checks;
        api = (await unauthenticatedApiRule.run(ctx)).checks;
      } else {
        api = (await unauthenticatedApiRule.run(ctx)).checks;
        auth = (await authEndpointDisclosureRule.run(ctx)).checks;
      }
      expect(meRequests(stub.sent)).toHaveLength(1);
      expect(fails(api).length + fails(auth).length).toBe(1);
      if (authFirst) expect(fails(api)).toHaveLength(1);
      else expect(fails(auth)[0]?.details).toMatchObject({ endpoint: ME });
    });
  }

  test("with auth-endpoint-disclosure disabled, unauthenticated-api keeps the finding", async () => {
    const { api, sent } = await runBoth(
      { [ME]: () => json([LEAKY_USER, LEAKY_USER]), ...otherConvention },
      { ruleEnabled: (id) => id !== "security/auth-endpoint-disclosure" }
    );
    expect(fails(api)).toHaveLength(1);
    expect(meRequests(sent)).toHaveLength(1);
  });
});

describe("auth-endpoint-disclosure release gate (#1920): unverified answers are never a pass", () => {
  async function runAuth(answer: () => Response): Promise<CheckResult[]> {
    const stub = stubFetch({ [ME]: answer, ...otherConvention });
    restore = stub.restore;
    return (await authEndpointDisclosureRule.run(ruleCtx({ surface: meSurface() }))).checks;
  }

  const cases: Array<[string, () => Response]> = [
    ["HTTP 429", () => new Response("slow down", { status: 429 })],
    [
      "a Cloudflare challenge",
      () =>
        new Response("<!doctype html><title>Just a moment...</title>", {
          status: 403,
          headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        }),
    ],
    [
      "a WAF 403 page",
      () =>
        new Response("<!doctype html><title>Attention Required! | Cloudflare</title>", {
          status: 403,
          headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "8f0000000000abcd-SYD" },
        }),
    ],
    ["a 5xx", () => new Response("upstream error", { status: 502 })],
  ];

  for (const [label, answer] of cases) {
    test(`${label} is not checked`, async () => {
      const checks = await runAuth(answer);
      expect(checks.some((c) => c.status === "pass")).toBe(false);
      expect(checks.some((c) => c.status === "skipped" && c.name === "auth-endpoint-not-checked")).toBe(true);
    });
  }

  test("no candidate at all is not checked", async () => {
    const stub = stubFetch({});
    restore = stub.restore;
    const { checks } = await authEndpointDisclosureRule.run(ruleCtx({ robotsTxt: robots(["/api/"]) }));
    expect(stub.sent).toHaveLength(0);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "no-endpoints" });
  });
});
