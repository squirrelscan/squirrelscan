// security/json-sensitive-fields (repo#1956): one quiet GET per same-origin
// discovered endpoint, gated by the probe level, and a JSON walk that flags
// credentials as failures and bulk personal data as warnings, with every value
// redacted. Every test runs the rule fresh against a stubbed fetch.

import { afterEach, describe, expect, test } from "bun:test";

import {
  credentialClass,
  isBulkPii,
  jsonSensitiveFieldsRule,
  luhnValid,
  MAX_JSON_ENDPOINTS,
  passwordHashShape,
  scanJsonResponse,
  scanJsonValue,
  selectJsonCandidates,
} from "../src/security/json-sensitive-fields";
import type { CheckResult } from "../src/types";
import {
  BASE,
  candidate,
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

const USERS = `${BASE}/api/users`;
const BCRYPT = "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW";
const ARGON2 = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQxMjM0$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";
const DB_URL = "postgres://admin:S3cr3tPassw0rd@db.internal.example.net:5432/app"; // pragma: allowlist secret

function users(n: number, extra: (i: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `User ${i + 1}`,
    email: `user${i + 1}@example.org`,
    ...extra(i),
  }));
}

async function run(
  routes: Record<string, Route>,
  ctxOpts: Parameters<typeof ruleCtx>[0] = {}
): Promise<{ checks: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const ctx = ruleCtx({ surface: surface([candidate("/api/users", { method: "GET" })]), ...ctxOpts });
  const { checks } = await jsonSensitiveFieldsRule.run(ctx);
  return { checks, sent: stub.sent };
}

function allText(checks: CheckResult[]): string {
  return JSON.stringify(checks);
}

describe("security/json-sensitive-fields: gating (per #1931)", () => {
  test("passive or no probe budget: skipped, nothing sent", async () => {
    for (const opts of [{ level: "passive" as const }, { noProbe: true }]) {
      const { checks, sent } = await run({ [USERS]: () => json(users(10)) }, opts);
      expect(sent).toHaveLength(0);
      expect(checks).toEqual([expect.objectContaining({ status: "skipped", skipReason: "probing-passive" })]);
    }
  });

  test("a zero budget sends nothing and skips on budget", async () => {
    const { checks, sent } = await run({ [USERS]: () => json(users(10)) }, { budgetMs: 0 });
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-budget" });
  });

  test("active sends one GET per endpoint: no cookies, no redirect follow, no body", async () => {
    const { sent } = await run({ [USERS]: () => json({ ok: true }) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: USERS,
      method: "GET",
      body: null,
      credentials: "omit",
      redirect: "manual",
    });
    expect(sent[0]!.headers.cookie).toBeUndefined();
    expect(sent[0]!.headers.authorization).toBeUndefined();
  });

  test("same origin only: cross-origin and probe-ineligible candidates are never requested", async () => {
    const s = surface([
      candidate("https://api.other.com/users", { method: "GET" }),
      candidate("http://example.com/api/users", { method: "GET", sameOrigin: true, probeEligible: true }),
      candidate("/api/claimed", { method: "GET", sameOrigin: true, probeEligible: false }),
      candidate("/api/users", { method: "GET" }),
    ]);
    const { sent, checks } = await run({ [USERS]: () => json({ ok: true }) }, { surface: s });
    expect(sent.map((r) => r.url)).toEqual([USERS]);
    expect(checks.at(-1)!.details).toMatchObject({ skippedCrossOrigin: 3 });
  });

  test("selection skips non-GET call sites, GraphQL, state-changing paths, robots and the cap", () => {
    const many = Array.from({ length: MAX_JSON_ENDPOINTS + 3 }, (_, i) => candidate(`/api/items/${i}`, { method: undefined }));
    const s = surface([
      candidate("/api/orders", { method: "POST" }),
      candidate("/api/graphql", { method: "GET" }),
      candidate("/api/logout", { method: "GET" }),
      candidate("/api/items?action=delete", { method: "GET" }),
      candidate("/api/private/x", { method: "GET" }),
      ...many,
    ]);
    const ctx = ruleCtx({ surface: s, robotsTxt: robots(["/api/private"]) });
    const sel = selectJsonCandidates(ctx);
    expect(sel.candidates).toHaveLength(MAX_JSON_ENDPOINTS);
    expect(sel).toMatchObject({ skippedMethod: 1, skippedStateChanging: 2, skippedRobots: 1, skippedCap: 3 });
    expect(sel.candidates.some((c) => c.url.includes("graphql"))).toBe(false);
    // Aggressive requests robots-disallowed paths on purpose.
    const aggressive = selectJsonCandidates(ruleCtx({ surface: s, robotsTxt: robots(["/api/private"]), level: "aggressive" }));
    expect(aggressive.skippedRobots).toBe(0);
  });

  test("no candidates: not checked (never a pass), and nothing was requested (#1920)", async () => {
    const { checks, sent } = await run({}, { surface: surface([]) });
    expect(sent).toHaveLength(0);
    expect(checks).toEqual([
      expect.objectContaining({ name: "json-api-responses", status: "skipped", skipReason: "no-endpoints" }),
    ]);
  });
});

describe("security/json-sensitive-fields: credentials are high severity", () => {
  test("password hashes are a fail, by shape and by key, with no value in the output", async () => {
    const body = users(3, (i) => ({ passwordHash: i === 0 ? ARGON2 : BCRYPT }));
    const { checks } = await run({ [USERS]: () => json(body) });
    const fail = checks.filter((c) => c.status === "fail");
    expect(fail).toHaveLength(1);
    expect(fail[0]!.name).toBe("json-sensitive-fields");
    expect(fail[0]!.message).toContain(USERS);
    const labels = fail[0]!.items!.map((i) => i.label);
    expect(labels).toContain("$[].passwordHash: bcrypt hash (2 records)");
    expect(labels).toContain("$[].passwordHash: argon2 hash");
    const text = allText(checks);
    expect(text).not.toContain(BCRYPT);
    expect(text).not.toContain(BCRYPT.slice(7, 20));
    expect(text).not.toContain("c29tZXNhbHQ");
  });

  test("tokens, secrets and leaked-secrets provider keys are a fail", async () => {
    const body = {
      user: { id: 1, email: "a@example.org", resetToken: "f3a9c1d27be84e05a6c3b9d0e1f27a4c" },
      config: { stripeSecret: ["sk", "live", "51HxQabcdefghijklmnopqrstuv"].join("_"), databaseUrl: DB_URL }, // pragma: allowlist secret
    };
    const { checks } = await run({ [USERS]: () => json(body) });
    const fail = checks.find((c) => c.status === "fail")!;
    const kinds = fail.items!.map((i) => i.meta?.kind);
    expect(kinds).toContain("access token");
    expect(kinds).toContain("secret or API key");
    // The connection string sits under a key the field rules do not name: the leaked-secrets matchers catch it.
    expect(fail.items!.find((i) => i.meta?.path === "(response text)")?.meta?.kind).toBe("PostgreSQL Connection String");
    const text = allText(checks);
    expect(text).not.toContain("f3a9c1d27be84e05");
    expect(text).not.toContain("51HxQabcdefghij");
    expect(text).not.toContain("S3cr3tPassw0rd");
  });

  test("card numbers, SSNs and plaintext passwords in user records are a fail", () => {
    const scan = scanJsonValue({
      customers: [{ id: 1, name: "A", password: "hunter22", ssn: "078-05-1120", card_number: "4111 1111 1111 1111", cvv: "123" }],
    });
    const kinds = scan.sensitive.map((f) => f.kind).sort();
    expect(kinds).toEqual(["card number", "card security code", "plaintext password or salt", "social security number"]);
  });

  test("labels, placeholders, CSRF tokens, cursors and publishable keys are not flagged", () => {
    const scan = scanJsonValue({
      i18n: { name: "Name", email: "E-Mail", password: "Passwort", token: "Token", apiKey: "API key" },
      form: { password: "********", csrfToken: "Zx9vQ2mL8kP4rT6yW1nB3cV5", nextPageToken: "eyJvZmZzZXQiOjEwMH0abcdef" },
      firebase: { apiKey: `AIzaSyD${"-abcdefghijklmnopqrstuvwxyz12345"}` }, // pragma: allowlist secret
      user: { id: 1, password: null, passwordSet: true, card_number: "1234 5678 9012 3456" },
      commit: { hash: "9fceb02d0ae598e95dc970b74767f19372d61af8" },
    });
    expect(scan.sensitive).toEqual([]);
  });

  test("a public Firebase apiKey does not decide a server apiKey in the same response, in either order", () => {
    const firebaseKey = `AIzaSyD${"-abcdefghijklmnopqrstuvwxyz12345"}`; // pragma: allowlist secret
    const serverKey = ["sk", "live", "51HxQabcdefghijklmnopqrstuv"].join("_"); // pragma: allowlist secret
    const publicFirst = scanJsonValue({ firebase: { apiKey: firebaseKey }, server: { apiKey: serverKey } });
    expect(publicFirst.sensitive.map((f) => [f.path, f.kind])).toEqual([["$.server.apiKey", "secret or API key"]]);
    const secretFirst = scanJsonValue({ server: { apiKey: serverKey }, firebase: { apiKey: firebaseKey } });
    expect(secretFirst.sensitive.map((f) => [f.path, f.kind])).toEqual([["$.server.apiKey", "secret or API key"]]);
  });

  test("helpers: key classes, hash shapes and Luhn", () => {
    expect(credentialClass("password_hash")).toBe("password");
    expect(credentialClass("githubToken")).toBe("token");
    expect(credentialClass("csrf_token")).toBeNull();
    expect(credentialClass("tokenType")).toBeNull();
    expect(passwordHashShape(BCRYPT)).toBe("bcrypt hash");
    expect(passwordHashShape("$2b$12$short")).toBeNull();
    expect(passwordHashShape("not a hash at all, just text")).toBeNull();
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
});

describe("security/json-sensitive-fields: bulk personal data", () => {
  test("emails for many records are a warning, redacted", async () => {
    const { checks } = await run({ [USERS]: () => json({ data: users(8, (i) => ({ phone: `+1 415 555 01${10 + i}`, role: "member" })) }) });
    const warn = checks.filter((c) => c.status === "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0]!.name).toBe("json-bulk-pii");
    expect(warn[0]!.message).toContain("8 distinct email address(es)");
    expect(warn[0]!.message).toContain("8 distinct phone number(s)");
    expect(warn[0]!.message).toContain("role or admin field");
    expect(warn[0]!.items!.map((i) => i.label)).toEqual(["$.data[].email", "$.data[].phone"]);
    const text = allText(checks);
    expect(text).not.toContain("user1@example.org");
    expect(text).not.toContain("555 0110");
  });

  test("one email (a contact address, a single record) is not bulk", async () => {
    const { checks } = await run({ [USERS]: () => json({ id: 1, email: "hello@example.org", support: "help@example.org" }) });
    expect(checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(checks.at(-1)).toMatchObject({ status: "pass", name: "json-api-responses" });
  });

  test("addresses and dates of birth across many records are bulk", () => {
    const scan = scanJsonValue(
      Array.from({ length: 6 }, (_, i) => ({ id: i, address: { line1: `${i} Main St` }, dob: "1990-01-01" }))
    );
    expect(scan.pii.personalRecords).toBe(6);
    expect(isBulkPii(scan.pii)).toBe(true);
  });

  test("a body over the read cap is scanned as text, marked lower confidence", () => {
    const body = JSON.stringify(users(20)).slice(0, -10);
    const scan = scanJsonResponse({ status: 200, contentType: "application/json", body, truncated: true }, USERS);
    expect(scan?.truncated).toBe(true);
    expect(scan!.pii.distinctEmails).toBeGreaterThanOrEqual(19);
  });
});

describe("security/json-sensitive-fields: what is not read", () => {
  test("HTML, non-2xx, redirects and errors are not flagged; all-error runs skip", async () => {
    const leaky = JSON.stringify(users(10, () => ({ passwordHash: BCRYPT })));
    for (const res of [
      () => new Response(leaky, { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response(leaky, { status: 403, headers: { "content-type": "application/json" } }),
      () => new Response(leaky, { status: 302, headers: { location: "/login", "content-type": "application/json" } }),
    ]) {
      const { checks } = await run({ [USERS]: res });
      expect(checks).toEqual([expect.objectContaining({ status: "pass" })]);
    }
    const { checks } = await run({
      [USERS]: () => {
        throw new TypeError("network down");
      },
    });
    expect(checks).toEqual([expect.objectContaining({ status: "skipped", skipReason: "probe-errors" })]);
  });

  test("nesting past the depth cap is skipped, not walked, and the walk says so", () => {
    let deep: unknown = { id: 1, passwordHash: BCRYPT };
    for (let d = 0; d < 100; d++) deep = { next: deep };
    const scan = scanJsonValue({ shallow: { id: 2, passwordHash: BCRYPT }, deep });
    expect(scan.walkTruncated).toBe(true);
    expect(scan.sensitive.map((f) => f.path)).toEqual(["$.shallow.passwordHash"]);
  });

  test("items, paths and keys are bounded", async () => {
    const record: Record<string, string> = { id: "1" };
    for (let i = 0; i < 40; i++) record[`k${i}Password`] = `value-${i}-Abc123!`;
    let nested: unknown = [record];
    for (let d = 0; d < 10; d++) nested = { [`level${d}_${"x".repeat(100)}\u0000`]: nested };
    expect(scanJsonValue(nested).sensitive).toHaveLength(40);
    const { checks } = await run({ [USERS]: () => json(nested) });
    const fail = checks.find((c) => c.status === "fail")!;
    expect(fail.items).toHaveLength(20);
    for (const item of fail.items!) {
      expect(String(item.meta?.path).length).toBeLessThanOrEqual(160);
      expect(item.snippet!.length).toBeLessThanOrEqual(200);
      expect(item.snippet).not.toContain("Abc123");
      expect(item.snippet).not.toContain("\u0000");
    }
  });
});
