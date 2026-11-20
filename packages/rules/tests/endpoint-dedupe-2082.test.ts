// squirrelscan#2082: security/unauthenticated-api reports every leaking endpoint
// itself, and the runner keeps one finding per endpoint after the site pass:
// security/auth-endpoint-disclosure's when it reported the endpoint, otherwise
// unauthenticated-api's. These run the two real rules through the real
// RuleRunner.runSiteRules (its timeout and error handling, then the dedupe), in
// both orders, with the auth rule ending each way it can: past the probe
// deadline, with the run aborted, by throwing, and by running past the runner's
// time budget. The endpoint is reported exactly once in every case.
//
// Before the fix, unauthenticated-api handed a leaking current-user endpoint to
// the auth rule, so an auth rule that threw or timed out after that left the
// endpoint with no finding at all.

// oxlint-disable sonarjs/no-hardcoded-passwords -- the fixtures are fake leaked credentials, which is what the rules detect

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { createProbeBudget, type ProbeBudget } from "../src/probe-budget";
import { RULE_TIMED_OUT_SKIP_REASON } from "@squirrelscan/core-contracts";
import { RuleRunner, type RulesConfig } from "../src/runner";
import { AUTH_ENDPOINT_DISCLOSURE_RULE_ID, authEndpointDisclosureRule } from "../src/security/auth-endpoint-disclosure";
import { dedupeEndpointFindings } from "../src/security/endpoint-dedupe";
import {
  dropEndpointsReportedElsewhere,
  UNAUTHENTICATED_API_RULE_ID,
  unauthenticatedApiRule,
} from "../src/security/unauthenticated-api";
import type { Rule, SiteData } from "../src/types";
import { BASE, candidate, surface } from "./helpers/graphql-server";

const ME = `${BASE}/api/me`;
const BCRYPT = "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW"; // pragma: allowlist secret
const LEAKY_USER = {
  id: 42,
  email: "jo@example.com",
  name: "Jo",
  encrypted_password: BCRYPT,
  sign_in_count: 17,
  current_sign_in_ip: "203.0.113.9",
};

// ── a fetch stub that honours the request's abort signal ─────────────

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Server {
  sent: string[];
  /** Called once, right after /api/me is answered: where each test ends the auth rule. */
  afterMe: () => void;
}

function serve(): Server {
  const server: Server = { sent: [], afterMe: () => {} };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    server.sent.push(url);
    init?.signal?.throwIfAborted();
    const { origin, pathname } = new URL(url);
    if (`${origin}${pathname}` === ME) {
      const res = new Response(JSON.stringify(LEAKY_USER), { headers: { "content-type": "application/json" } });
      const after = server.afterMe;
      server.afterMe = () => {};
      after();
      return res;
    }
    return new Response("<!doctype html><title>Home</title>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return server;
}

// ── a probe budget the test can push past its deadline, abort, or break ──

function controllableProbe(): {
  probe: ProbeBudget;
  passDeadline: () => void;
  abortRun: () => void;
  throwOnNextProbe: () => void;
} {
  let clock = 1_000;
  const base = createProbeBudget({ level: "active", budgetMs: 60_000, now: () => clock });
  const run = new AbortController();
  let throwNext = false;
  const probe: ProbeBudget = {
    level: base.level,
    budgetMs: base.budgetMs,
    allows(kind) {
      if (throwNext) {
        throwNext = false;
        throw new Error("probe bookkeeping failed");
      }
      return base.allows(kind);
    },
    remainingMs: () => base.remainingMs(),
    signal: () => AbortSignal.any([base.signal(), run.signal]),
    record: (n) => base.record(n),
    summary: () => base.summary(),
  };
  return {
    probe,
    passDeadline: () => {
      clock += 120_000;
    },
    abortRun: () => run.abort(new DOMException("The audit was aborted", "AbortError")),
    throwOnNextProbe: () => {
      throwNext = true;
    },
  };
}

// ── the real runner, with the two rules in a chosen order ────────────

const RUNNER_BUDGET_MS = 300;

/**
 * The endpoint surface, with a one-shot stall on its next read once armed. The
 * runner's budget bounds a rule's synchronous work (runWithinBudget), which for
 * the auth rule is choosing its candidates from this surface, before any probe:
 * a stall there is how the runner times the auth rule out.
 */
function stallingSurface() {
  const real = surface([candidate("/api/me", { method: "GET" })]);
  let armed = false;
  const view = {
    ...real,
    get candidates() {
      if (armed) {
        armed = false;
        const until = performance.now() + RUNNER_BUDGET_MS * 3;
        while (performance.now() < until) {
          // busy: the runner's watchdog interrupts this
        }
      }
      return real.candidates;
    },
  };
  return {
    surface: view,
    arm: () => {
      armed = true;
    },
  };
}

/** The real runner; only the rule list and its order are fixed by the test. */
class OrderedRunner extends RuleRunner {
  constructor(
    private readonly ordered: Rule[],
    probe: ProbeBudget
  ) {
    const config: RulesConfig = {
      rule_options: {},
      rules: { enable: [UNAUTHENTICATED_API_RULE_ID, AUTH_ENDPOINT_DISCLOSURE_RULE_ID] },
    };
    super({ config, probe, ruleConcurrency: 1, ruleTimeBudgetMs: RUNNER_BUDGET_MS });
  }
  override getEnabledRules(): Rule[] {
    return this.ordered;
  }
}

const siteData: SiteData = {
  baseUrl: `${BASE}/`,
  pages: [{ url: `${BASE}/`, statusCode: 200 } as SiteData["pages"][number]],
  robotsTxt: null,
  sitemaps: null,
};

type Order = "api rule first" | "auth rule first";
type Exit = "probe deadline" | "run aborted" | "exception thrown" | "runner timeout";

async function audit(order: Order, exit: Exit) {
  const server = serve();
  const control = controllableProbe();
  const endpoints = stallingSurface();
  // Each exit is armed so that it lands on the auth rule: after /api/me is
  // answered (to whichever rule asked first), or, for the runner timeout with the
  // auth rule first, from the start (it stalls before it probes anything).
  server.afterMe = {
    "probe deadline": control.passDeadline,
    "run aborted": control.abortRun,
    "exception thrown": control.throwOnNextProbe,
    "runner timeout": endpoints.arm,
  }[exit];
  if (exit === "runner timeout" && order === "auth rule first") endpoints.arm();
  const rules =
    order === "api rule first"
      ? [unauthenticatedApiRule, authEndpointDisclosureRule]
      : [authEndpointDisclosureRule, unauthenticatedApiRule];
  const runner = new OrderedRunner(rules, control.probe);
  const result = await runner.runSiteRules(siteData, undefined, undefined, endpoints.surface);
  const api = result.ruleResults.get(UNAUTHENTICATED_API_RULE_ID)?.checks ?? [];
  const auth = result.ruleResults.get(AUTH_ENDPOINT_DISCLOSURE_RULE_ID)?.checks ?? [];
  return { result, api, auth, server, probe: control.probe };
}

const problems = (checks: readonly CheckResult[]) => checks.filter((c) => c.status === "fail" || c.status === "warn");

/** Findings on /api/me: the auth rule's by `details.endpoint`, unauthenticated-api's by item. */
function findingsOnMe(api: readonly CheckResult[], auth: readonly CheckResult[]): string[] {
  const out: string[] = [];
  for (const c of problems(auth)) if (c.details?.endpoint === ME) out.push(AUTH_ENDPOINT_DISCLOSURE_RULE_ID);
  for (const c of problems(api)) for (const i of c.items ?? []) if (i.id === ME) out.push(UNAUTHENTICATED_API_RULE_ID);
  return out;
}

/** What each exit leaves in the auth rule's result, and which rule keeps the finding. */
const EXITS: Record<Exit, { reporter: string; authEnded: (auth: CheckResult[], probe: ProbeBudget) => void }> = {
  // The shared answer is read before the budget is asked, so the auth rule still
  // reports /api/me; it just sends nothing further.
  "probe deadline": {
    reporter: AUTH_ENDPOINT_DISCLOSURE_RULE_ID,
    authEnded: (_auth, probe) => expect(probe.summary().exhausted).toBe(true),
  },
  // Every later request of the auth rule fails with the run's AbortError.
  "run aborted": {
    reporter: AUTH_ENDPOINT_DISCLOSURE_RULE_ID,
    authEnded: () => {},
  },
  "exception thrown": {
    reporter: UNAUTHENTICATED_API_RULE_ID,
    authEnded: (auth) => {
      expect(problems(auth)).toHaveLength(0);
      expect(auth.some((c) => c.status === "skipped" && c.details?.errored === true)).toBe(true);
    },
  },
  "runner timeout": {
    reporter: UNAUTHENTICATED_API_RULE_ID,
    authEnded: (auth) => {
      expect(problems(auth)).toHaveLength(0);
      expect(auth.some((c) => c.skipReason === RULE_TIMED_OUT_SKIP_REASON && c.details?.timedOut === true)).toBe(true);
    },
  },
};

describe("squirrelscan#2082: one finding per leaking endpoint, whichever way the auth rule ends", () => {
  for (const exit of Object.keys(EXITS) as Exit[]) {
    for (const order of ["api rule first", "auth rule first"] as const) {
      const { reporter, authEnded } = EXITS[exit];
      test(`${exit}, ${order}: /api/me is reported exactly once, by ${reporter}`, async () => {
        const { result, api, auth, server, probe } = await audit(order, exit);
        authEnded(auth, probe);
        expect(server.sent.filter((u) => u === ME)).toHaveLength(1);
        expect(findingsOnMe(api, auth)).toEqual([reporter]);
        // The flat check list the report counts from agrees with the per-rule results.
        const flat = result.checks.filter((c) => c.status === "fail" || c.status === "warn");
        expect(flat).toEqual([...problems(api), ...problems(auth)].sort((a, b) => result.checks.indexOf(a) - result.checks.indexOf(b)));
        if (reporter === AUTH_ENDPOINT_DISCLOSURE_RULE_ID) {
          // Dropped whole: no tier check, and the rule reads clean, naming who reported it.
          expect(problems(api)).toHaveLength(0);
          expect(api.find((c) => c.status === "pass")?.details).toMatchObject({
            reportedBy: AUTH_ENDPOINT_DISCLOSURE_RULE_ID,
            reportedElsewhere: 1,
          });
        }
      }, 30_000);
    }
  }
});

// ── the dedupe itself: nothing the dropped finding counted is left ──

const OTHER = `${BASE}/api/orders`;
/** The rule's own check names, by outcome. */
const checkNamed = (outcome: string, n = 0): string =>
  (unauthenticatedApiRule.meta.checks ?? []).filter((c) => c.outcome === outcome)[n]!.name;
const SENSITIVE = checkNamed("problem");
const CLEAN = checkNamed("clean");
const UNCHECKED = checkNamed("skipped");

function apiResult(endpoints: string[], opts: { incomplete?: boolean } = {}): CheckResult[] {
  const items = endpoints.map((id) => ({ id, label: `GET ${id}: 2 records`, meta: { personal: ["email"] } }));
  const checks: CheckResult[] = [
    {
      name: SENSITIVE,
      status: "fail",
      message: `${items.length} API endpoint(s) ...`,
      items,
      details: { severity: "high", endpoints: items.length, probed: 3 },
    },
  ];
  if (opts.incomplete) {
    checks.push({ name: UNCHECKED, status: "skipped", message: "incomplete", value: "not-checked" });
  }
  return checks;
}
const authFinding = (endpoint: string): CheckResult => ({
  name: "auth-endpoint-disclosure",
  status: "fail",
  message: `${endpoint} answered ...`,
  details: { endpoint, kinds: ["password-hash"], fields: 1 },
});

describe("dropEndpointsReportedElsewhere (squirrelscan#2082)", () => {
  test("a partly covered tier check is rebuilt from what is left: count, message, endpoints", () => {
    const out = dropEndpointsReportedElsewhere(apiResult([ME, OTHER]), new Set([ME]));
    expect(out).toHaveLength(1);
    expect(out[0]!.items?.map((i) => i.id)).toEqual([OTHER]);
    expect(out[0]!.details).toMatchObject({ endpoints: 1, probed: 3 });
    expect(out[0]!.message).toStartWith("1 API endpoint(s)");
    expect(out[0]!.message).toContain(`for example ${OTHER} (email)`);
  });

  test("a wholly covered run that verified every endpoint reads clean", () => {
    const out = dropEndpointsReportedElsewhere(apiResult([ME]), new Set([ME]));
    expect(out).toEqual([expect.objectContaining({ name: CLEAN, status: "pass" })]);
  });

  test("a wholly covered run that left endpoints unchecked stays not-checked, never clean", () => {
    const out = dropEndpointsReportedElsewhere(apiResult([ME], { incomplete: true }), new Set([ME]));
    expect(out.map((c) => c.name)).toEqual([UNCHECKED]);
  });

  test("an endpoint the auth rule did not report keeps its finding untouched", () => {
    const checks = apiResult([OTHER]);
    expect(dropEndpointsReportedElsewhere(checks, new Set([ME]))).toBe(checks);
  });

  test("keyed on the normalised URL both rules request: query and fragment do not split an endpoint", () => {
    const results = new Map([
      [UNAUTHENTICATED_API_RULE_ID, { meta: unauthenticatedApiRule.meta, checks: apiResult([`${ME}?v=2#x`]) }],
      [AUTH_ENDPOINT_DISCLOSURE_RULE_ID, { meta: authEndpointDisclosureRule.meta, checks: [authFinding(ME)] }],
    ]);
    expect(problems(dedupeEndpointFindings(results)?.checks ?? [])).toHaveLength(0);
  });

  test("an auth rule that reported nothing (threw, timed out, disabled) leaves unauthenticated-api's finding", () => {
    const api = { meta: unauthenticatedApiRule.meta, checks: apiResult([ME]) };
    expect(dedupeEndpointFindings(new Map([[UNAUTHENTICATED_API_RULE_ID, api]]))).toBeUndefined();
    const errored: CheckResult = { name: `${AUTH_ENDPOINT_DISCLOSURE_RULE_ID}-error`, status: "skipped", message: "Rule error" };
    const withErrored = new Map([
      [UNAUTHENTICATED_API_RULE_ID, api],
      [AUTH_ENDPOINT_DISCLOSURE_RULE_ID, { meta: authEndpointDisclosureRule.meta, checks: [errored] }],
    ]);
    expect(dedupeEndpointFindings(withErrored)).toBeUndefined();
  });
});
