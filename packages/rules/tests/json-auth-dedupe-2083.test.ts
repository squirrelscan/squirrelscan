// squirrelscan#2083: security/json-sensitive-fields and security/auth-endpoint-disclosure
// both read a current-user endpoint such as /api/account. One audit requests it once
// (the anonymous GET is shared through the probe budget, as in #1886), each rule reports
// what it finds on its own, and the runner's cross-rule dedupe (CROSS_RULE_PAIRS,
// endpoint-dedupe.ts, as in #2082) keeps one finding per leaked field: the auth rule's,
// the more specific one. Only the overlapping field leaves json-sensitive-fields; its
// other fields stand. These run the two real rules through the real
// RuleRunner.runSiteRules, in both orders, including each way the auth rule can end
// (probe deadline, aborted run, exception, runner timeout).
//
// Before the fix, json-sensitive-fields sent its own GET (two requests for the endpoint)
// and both rules reported the plaintext password.

// oxlint-disable sonarjs/no-hardcoded-passwords -- the fixtures are fake leaked credentials, which is what the rules detect

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { RULE_TIMED_OUT_SKIP_REASON, type CheckResult } from "@squirrelscan/core-contracts";

import { createProbeBudget, type ProbeBudget } from "../src/probe-budget";
import { RuleRunner, type RulesConfig } from "../src/runner";
import { AUTH_ENDPOINT_DISCLOSURE_RULE_ID, authEndpointDisclosureRule } from "../src/security/auth-endpoint-disclosure";
import { CROSS_RULE_PAIRS, dedupeCrossRuleFindings } from "../src/security/endpoint-dedupe";
import { authFieldKey, jsonFieldKey } from "../src/security/field-key";
import {
  dropFieldsReportedElsewhere,
  JSON_SENSITIVE_FIELDS_RULE_ID,
  jsonSensitiveFieldsRule,
} from "../src/security/json-sensitive-fields";
import { ANONYMOUS_GET_CAP } from "../src/security/probe-http";
import { UNAUTHENTICATED_API_RULE_ID } from "../src/security/unauthenticated-api";
import type { Rule, SiteData } from "../src/types";
import { BASE, candidate, surface } from "./helpers/graphql-server";

const ACCOUNT = `${BASE}/api/account`;
const BCRYPT = "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW"; // pragma: allowlist secret

/** The nut-shop fault: the account row comes back with its plaintext password. */
const PLAINTEXT_ACCOUNT = { id: 7, email: "hazel@example.com", name: "Hazel", password: "hunter2-nuts" };

/** A row with fields only one rule reports beside the one both report. */
const MIXED_ACCOUNT = {
  id: 7,
  email: "hazel@example.com",
  encrypted_password: BCRYPT,
  recovery_codes: ["a1b2-c3d4", "e5f6-g7h8"],
  card_number: "4242424242424242",
  access_token: "q9X2vLm4Tz8Rb6Nw1Ke3Pd7",
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
  /** Called once, right after /api/account is answered: where an exit test ends the auth rule. */
  afterAccount: () => void;
}

function serve(body: unknown): Server {
  const server: Server = { sent: [], afterAccount: () => {} };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    server.sent.push(url);
    init?.signal?.throwIfAborted();
    const { origin, pathname } = new URL(url);
    if (`${origin}${pathname}` === ACCOUNT) {
      const res = new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      const after = server.afterAccount;
      server.afterAccount = () => {};
      after();
      return res;
    }
    return new Response("<!doctype html><title>Not found</title>", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
  return server;
}

// ── a probe budget the test can push past its deadline, abort, or break ──

function controllableProbe() {
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

const RUNNER_BUDGET_MS = 300;

/** The endpoint surface, with a one-shot stall on its next read once armed (how the runner times a rule out). */
function stallingSurface() {
  const real = surface([candidate("/api/account", { method: "GET" })]);
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

class OrderedRunner extends RuleRunner {
  constructor(
    private readonly ordered: Rule[],
    probe: ProbeBudget
  ) {
    const config: RulesConfig = {
      rule_options: {},
      rules: { enable: ordered.map((r) => r.meta.id) },
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

type Order = "json rule first" | "auth rule first";
const ORDERS: Order[] = ["json rule first", "auth rule first"];
type Exit = "none" | "probe deadline" | "run aborted" | "exception thrown" | "runner timeout";

async function audit(body: unknown, opts: { order: Order; exit?: Exit; rules?: Rule[] }) {
  const server = serve(body);
  const control = controllableProbe();
  const endpoints = stallingSurface();
  const exit = opts.exit ?? "none";
  server.afterAccount = {
    none: () => {},
    "probe deadline": control.passDeadline,
    "run aborted": control.abortRun,
    "exception thrown": control.throwOnNextProbe,
    "runner timeout": endpoints.arm,
  }[exit];
  if (exit === "runner timeout" && opts.order === "auth rule first") endpoints.arm();
  const rules =
    opts.rules ??
    (opts.order === "json rule first"
      ? [jsonSensitiveFieldsRule, authEndpointDisclosureRule]
      : [authEndpointDisclosureRule, jsonSensitiveFieldsRule]);
  const runner = new OrderedRunner(rules, control.probe);
  const result = await runner.runSiteRules(siteData, undefined, undefined, endpoints.surface);
  return {
    result,
    json: result.ruleResults.get(JSON_SENSITIVE_FIELDS_RULE_ID)?.checks ?? [],
    auth: result.ruleResults.get(AUTH_ENDPOINT_DISCLOSURE_RULE_ID)?.checks ?? [],
    accountRequests: server.sent.filter((u) => u === ACCOUNT).length,
    probe: control.probe,
  };
}

const problems = (checks: readonly CheckResult[]) => checks.filter((c) => c.status === "fail" || c.status === "warn");
const itemPaths = (check: CheckResult | undefined) =>
  (check?.items ?? []).map((i) => (i.meta?.path ?? i.meta?.field) as string);

/** Findings for /api/account's plaintext password field, by rule. */
function passwordFindings(json: readonly CheckResult[], auth: readonly CheckResult[]): string[] {
  const out: string[] = [];
  for (const c of problems(auth)) if (itemPaths(c).includes("password")) out.push(AUTH_ENDPOINT_DISCLOSURE_RULE_ID);
  for (const c of problems(json)) if (itemPaths(c).includes("$.password")) out.push(JSON_SENSITIVE_FIELDS_RULE_ID);
  return out;
}

describe("squirrelscan#2083: one finding and one request per leaked field", () => {
  for (const order of ORDERS) {
    test(`a plaintext password on /api/account is one finding (auth-endpoint-disclosure) and one request (${order})`, async () => {
      const { result, json, auth, accountRequests } = await audit(PLAINTEXT_ACCOUNT, { order });

      expect(accountRequests).toBe(1);
      expect(passwordFindings(json, auth)).toEqual([AUTH_ENDPOINT_DISCLOSURE_RULE_ID]);
      expect(problems(json)).toHaveLength(0);
      expect(problems(auth)[0]?.details).toMatchObject({ endpoint: ACCOUNT, kinds: ["password"] });
      // No orphan: json-sensitive-fields reads clean and names who reported the field.
      expect(json.find((c) => c.status === "pass")?.details).toMatchObject({
        reportedBy: AUTH_ENDPOINT_DISCLOSURE_RULE_ID,
        reportedElsewhere: 1,
      });
      // The flat list the report counts from agrees with the per-rule results.
      const flat = result.checks.filter((c) => c.status === "fail" || c.status === "warn");
      expect(flat).toHaveLength(1);
    }, 30_000);

    test(`json-sensitive-fields keeps the fields auth-endpoint-disclosure does not report (${order})`, async () => {
      const paired = await audit(MIXED_ACCOUNT, { order });
      const authAlone = await audit(MIXED_ACCOUNT, { order, rules: [authEndpointDisclosureRule] });
      const jsonAlone = await audit(MIXED_ACCOUNT, { order, rules: [jsonSensitiveFieldsRule] });

      expect(paired.accountRequests).toBe(1);
      // The auth rule's findings are what it reports alone.
      expect(paired.auth).toEqual(authAlone.auth);
      expect(itemPaths(problems(paired.auth)[0]).sort()).toEqual(["encrypted_password", "recovery_codes"]);

      // Alone, json-sensitive-fields also reports the password hash. Paired, only the rest,
      // item for item as it reports them alone, with the count and message rebuilt.
      const alone = problems(jsonAlone.json);
      expect(itemPaths(alone[0])).toContain("$.encrypted_password");
      const pairedJson = problems(paired.json);
      expect(pairedJson).toHaveLength(1);
      expect(pairedJson[0]!.items).toEqual(alone[0]!.items!.filter((i) => i.meta?.path !== "$.encrypted_password"));
      expect(itemPaths(pairedJson[0]).sort()).toEqual(["$.access_token", "$.card_number"]);
      expect(pairedJson[0]!.details?.fields).toBe((alone[0]!.details?.fields as number) - 1);
      expect(pairedJson[0]!.message).not.toContain("bcrypt");
      expect(pairedJson[0]!.message).toEndWith("to a request without credentials");
    }, 30_000);

    test(`an answer over the shared read cap is read again in full by json-sensitive-fields (${order})`, async () => {
      // Too long for the shared GET: auth-endpoint-disclosure cannot parse it, so it reports
      // nothing and json-sensitive-fields must still find the password, as it does alone.
      const big = { ...PLAINTEXT_ACCOUNT, notes: "n".repeat(ANONYMOUS_GET_CAP + 1024) };
      const { json, auth, accountRequests } = await audit(big, { order });

      expect(accountRequests).toBe(2);
      expect(passwordFindings(json, auth)).toEqual([JSON_SENSITIVE_FIELDS_RULE_ID]);
    }, 30_000);
  }

  test("with auth-endpoint-disclosure not in the run, json-sensitive-fields keeps the finding", async () => {
    const { json, accountRequests } = await audit(PLAINTEXT_ACCOUNT, {
      order: "json rule first",
      rules: [jsonSensitiveFieldsRule],
    });
    expect(accountRequests).toBe(1);
    expect(itemPaths(problems(json)[0])).toEqual(["$.password"]);
  }, 30_000);
});

// ── each way the auth rule can end ───────────────────────────────────

const EXITS: Record<Exclude<Exit, "none">, { reporter: string; authEnded: (auth: CheckResult[], probe: ProbeBudget) => void }> = {
  // The shared answer is read before the budget is asked, so the auth rule still reports.
  "probe deadline": {
    reporter: AUTH_ENDPOINT_DISCLOSURE_RULE_ID,
    authEnded: (_auth, probe) => expect(probe.summary().exhausted).toBe(true),
  },
  "run aborted": { reporter: AUTH_ENDPOINT_DISCLOSURE_RULE_ID, authEnded: () => {} },
  // The auth rule reported nothing, so the json finding is kept.
  "exception thrown": {
    reporter: JSON_SENSITIVE_FIELDS_RULE_ID,
    authEnded: (auth) => {
      expect(problems(auth)).toHaveLength(0);
      expect(auth.some((c) => c.status === "skipped" && c.details?.errored === true)).toBe(true);
    },
  },
  "runner timeout": {
    reporter: JSON_SENSITIVE_FIELDS_RULE_ID,
    authEnded: (auth) => {
      expect(problems(auth)).toHaveLength(0);
      expect(auth.some((c) => c.skipReason === RULE_TIMED_OUT_SKIP_REASON && c.details?.timedOut === true)).toBe(true);
    },
  },
};

describe("squirrelscan#2083: one finding per leaked field, whichever way the auth rule ends", () => {
  for (const exit of Object.keys(EXITS) as Array<keyof typeof EXITS>) {
    for (const order of ORDERS) {
      const { reporter, authEnded } = EXITS[exit];
      test(`${exit}, ${order}: the password is reported exactly once, by ${reporter}`, async () => {
        const { json, auth, accountRequests, probe } = await audit(PLAINTEXT_ACCOUNT, { order, exit });
        authEnded(auth, probe);
        expect(accountRequests).toBe(1);
        expect(passwordFindings(json, auth)).toEqual([reporter]);
      }, 30_000);
    }
  }
});

// ── the dedupe itself ────────────────────────────────────────────────

const authFinding = (endpoint: string, fields: string[], status: CheckResult["status"] = "fail"): CheckResult => ({
  name: "auth-endpoint-disclosure",
  status,
  message: `${endpoint} answered ...`,
  items: fields.map((field) => ({ id: `${endpoint}#${field}`, label: field, meta: { endpoint, field, kind: "secret" } })),
  details: { endpoint, kinds: ["secret"], fields: fields.length, ...(status === "pass" ? { ignored: "waived" } : {}) },
});

function jsonFinding(endpoint: string, fields: Array<[string, string]>, total = fields.length): CheckResult {
  return {
    name: "json-sensitive-fields",
    status: "fail",
    message: `${endpoint} returns ${fields.map(([, k]) => k).join(", ")} to a request without credentials`,
    items: fields.map(([path, kind]) => ({ id: `${endpoint} ${path} ${kind}`, label: path, meta: { endpoint, path, kind } })),
    details: { endpoint, status: 200, fields: total },
  };
}

describe("the cross-rule dedupe (squirrelscan#2083)", () => {
  test("one pair list holds both pairs, keyed the same way, and the runner has no rule-specific branch", async () => {
    expect(CROSS_RULE_PAIRS.map((p) => [p.keeps, p.drops])).toEqual([
      [AUTH_ENDPOINT_DISCLOSURE_RULE_ID, UNAUTHENTICATED_API_RULE_ID],
      [AUTH_ENDPOINT_DISCLOSURE_RULE_ID, JSON_SENSITIVE_FIELDS_RULE_ID],
    ]);
    const runner = await Bun.file(new URL("../src/runner.ts", import.meta.url)).text();
    expect(runner).not.toContain("UNAUTHENTICATED_API_RULE_ID");
    expect(runner).not.toContain("JSON_SENSITIVE_FIELDS_RULE_ID");
  });

  test("field keys: the two rules' paths for one field agree; a cut path matches nothing", () => {
    expect(jsonFieldKey("$.user.encrypted_password")).toBe(authFieldKey("user.encrypted_password"));
    expect(jsonFieldKey("$.users[].password")).toBe(authFieldKey("users[3].password"));
    expect(jsonFieldKey("$[].password")).toBe(authFieldKey("[0].password"));
    expect(jsonFieldKey('$["reset-token"]')).toBe(authFieldKey("reset-token"));
    // A key the auth rule masks (a digit, an email) cannot be told from another
    // masked key, so a path through one has no key on either side.
    expect(jsonFieldKey('$.byUser["jo@example.com"].password')).toBeUndefined();
    expect(authFieldKey("byUser.*.password")).toBeUndefined();
    expect(jsonFieldKey("$.token2")).toBeUndefined();
    expect(authFieldKey("*")).toBeUndefined();
    expect(authFieldKey("[0].*")).toBeUndefined();
    expect(jsonFieldKey(`$.${"a".repeat(158)}…`)).toBeUndefined();
    expect(jsonFieldKey("(response text)")).toBeUndefined();
  });

  test("only the overlapping field leaves; the count and message are rebuilt from the rest", () => {
    const json = [jsonFinding(ACCOUNT, [["$.password", "plaintext password"], ["$.card_number", "card number"]], 2)];
    const out = dedupeCrossRuleFindings(
      new Map([
        [JSON_SENSITIVE_FIELDS_RULE_ID, { meta: jsonSensitiveFieldsRule.meta, checks: json }],
        [AUTH_ENDPOINT_DISCLOSURE_RULE_ID, { meta: authEndpointDisclosureRule.meta, checks: [authFinding(ACCOUNT, ["password"])] }],
      ])
    );
    const checks = out.get(JSON_SENSITIVE_FIELDS_RULE_ID)!.checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]!.items?.map((i) => i.meta?.path)).toEqual(["$.card_number"]);
    expect(checks[0]!.details).toMatchObject({ fields: 1, endpoint: ACCOUNT });
    expect(checks[0]!.message).toBe(`${ACCOUNT} returns card number to a request without credentials`);
    expect(out.has(UNAUTHENTICATED_API_RULE_ID)).toBe(false);
  });

  test("two different masked keys under one parent never match: json keeps its finding", () => {
    // The auth rule reports user.totp_secret2 as user.*; json finds user.api_key2.
    // Both mask to one shape, but they are different fields, so a duplicate at worst.
    const json = [jsonFinding(ACCOUNT, [["$.user.api_key2", "API key"]])];
    const out = dedupeCrossRuleFindings(
      new Map([
        [JSON_SENSITIVE_FIELDS_RULE_ID, { meta: jsonSensitiveFieldsRule.meta, checks: json }],
        [AUTH_ENDPOINT_DISCLOSURE_RULE_ID, { meta: authEndpointDisclosureRule.meta, checks: [authFinding(ACCOUNT, ["user.*"])] }],
      ])
    );
    expect(out.has(JSON_SENSITIVE_FIELDS_RULE_ID)).toBe(false);
    // A masked parent the auth rule reported whole covers nothing beneath it either.
    const nested = [jsonFinding(ACCOUNT, [['$.byUser["jo@example.com"].password', "plaintext password"]])];
    const reported = new Map([[ACCOUNT, new Set([authFieldKey("byUser.*") ?? "$.byUser.*"])]]);
    expect(dropFieldsReportedElsewhere(nested, reported)).toBe(nested);
  });

  test("a credential inside a field the auth rule reported whole is the same leak", () => {
    const json = [jsonFinding(ACCOUNT, [["$.otp.secret", "secret"]])];
    const out = dropFieldsReportedElsewhere(json, new Map([[ACCOUNT, new Set([authFieldKey("otp")!])]]));
    expect(problems(out)).toHaveLength(0);
  });

  test("keyed on the normalised URL: a query on the json endpoint does not split it", () => {
    const json = [jsonFinding(`${ACCOUNT}?v=2`, [["$.password", "plaintext password"]])];
    const out = dropFieldsReportedElsewhere(json, new Map([[ACCOUNT, new Set([authFieldKey("password")!])]]));
    expect(problems(out)).toHaveLength(0);
  });

  test("a field on another endpoint, or another field, is untouched", () => {
    const json = [jsonFinding(`${BASE}/api/users`, [["$.password", "plaintext password"]])];
    expect(dropFieldsReportedElsewhere(json, new Map([[ACCOUNT, new Set([authFieldKey("password")!])]]))).toBe(json);
    const same = [jsonFinding(ACCOUNT, [["$.card_number", "card number"]])];
    expect(dropFieldsReportedElsewhere(same, new Map([[ACCOUNT, new Set([authFieldKey("password")!])]]))).toBe(same);
  });

  test("bulk personal data on the endpoint stands, and keeps the run from reading clean", () => {
    const pii: CheckResult = { name: "json-bulk-pii", status: "warn", message: "many", details: { endpoint: ACCOUNT } };
    const json = [jsonFinding(ACCOUNT, [["$.password", "plaintext password"]]), pii];
    const out = dropFieldsReportedElsewhere(json, new Map([[ACCOUNT, new Set([authFieldKey("password")!])]]));
    expect(out).toEqual([pii]);
  });

  test("a wholly covered run that left endpoints unchecked stays not-checked, never clean", () => {
    const skipped: CheckResult = { name: "json-api-responses", status: "skipped", message: "incomplete", value: "not-checked" };
    const json = [jsonFinding(ACCOUNT, [["$.password", "plaintext password"]]), skipped];
    const out = dropFieldsReportedElsewhere(json, new Map([[ACCOUNT, new Set([authFieldKey("password")!])]]));
    expect(out).toEqual([skipped]);
  });

  test("a waived auth finding still counts; an auth rule that reported nothing changes nothing", () => {
    const json = [jsonFinding(ACCOUNT, [["$.password", "plaintext password"]])];
    const jsonResult = { meta: jsonSensitiveFieldsRule.meta, checks: json };
    const waived = dedupeCrossRuleFindings(
      new Map([
        [JSON_SENSITIVE_FIELDS_RULE_ID, jsonResult],
        [AUTH_ENDPOINT_DISCLOSURE_RULE_ID, { meta: authEndpointDisclosureRule.meta, checks: [authFinding(ACCOUNT, ["password"], "pass")] }],
      ])
    );
    expect(problems(waived.get(JSON_SENSITIVE_FIELDS_RULE_ID)!.checks)).toHaveLength(0);

    const errored: CheckResult = { name: `${AUTH_ENDPOINT_DISCLOSURE_RULE_ID}-error`, status: "skipped", message: "Rule error" };
    const none = dedupeCrossRuleFindings(
      new Map([
        [JSON_SENSITIVE_FIELDS_RULE_ID, jsonResult],
        [AUTH_ENDPOINT_DISCLOSURE_RULE_ID, { meta: authEndpointDisclosureRule.meta, checks: [errored] }],
      ])
    );
    expect(none.size).toBe(0);
    expect(dedupeCrossRuleFindings(new Map([[JSON_SENSITIVE_FIELDS_RULE_ID, jsonResult]])).size).toBe(0);
  });
});
