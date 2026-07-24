// Bounded-concurrency rule execution must stay byte-identical & deterministic.
//
// Regression guard for #114: page/site rules now run with bounded concurrency,
// but results MUST be assembled in registration order (not completion order) and
// must match fully-sequential execution exactly.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import type { RuleNamespace } from "../src/loader";
import { RuleRunner, type RulesConfig } from "../src/runner";
import type { PageData, ParsedPage, Rule, SiteData } from "../src/types";

// Build N page-scope rules. Rule k emits a single pass check and resolves after
// a delay that is LARGEST for the lowest index — so without order-preserving
// assembly, completion order would reverse registration order.
function makeDelayedRules(n: number): { rules: Rule[]; ids: string[] } {
  const rules: Rule[] = [];
  const ids: string[] = [];
  for (let k = 0; k < n; k++) {
    const id = `test/concurrent-${k}`;
    ids.push(id);
    rules.push({
      meta: {
        id,
        name: `Concurrent ${k}`,
        description: "test rule",
        category: "core",
        scope: "page",
        severity: "info",
        weight: 1,
      },
      async run() {
        // Earlier rules finish LAST.
        await new Promise((r) => setTimeout(r, (n - k) * 4));
        return {
          checks: [
            { name: id, status: "pass", message: `ran ${k}` } as CheckResult,
          ],
        };
      },
    });
  }
  return { rules, ids };
}

function makeRunner(rules: Rule[], ruleConcurrency: number): RuleRunner {
  const config: RulesConfig = {
    rule_options: {},
    rules: { enable: rules.map((r) => r.meta.id) },
  };
  const ns: RuleNamespace = { name: "test", rules };
  return new RuleRunner({
    config,
    additionalNamespaces: [ns],
    ruleConcurrency,
  });
}

function makePage(): PageData {
  return {
    url: "https://example.com/",
    html: "<html><body><p>hi</p></body></html>",
    statusCode: 200,
    loadTime: 0,
    headers: {},
    parsed: {} as ParsedPage,
  };
}

function makeSiteData(): SiteData {
  return {
    baseUrl: "https://example.com",
    pages: [{ url: "https://example.com/", statusCode: 200, parsed: {} as ParsedPage }],
    robotsTxt: null,
    sitemaps: null,
  };
}

describe("runner bounded concurrency", () => {
  test("page rule output is identical to sequential & in registration order", async () => {
    const { rules, ids } = makeDelayedRules(12);

    // Page rules run sequentially regardless of ruleConcurrency (#379), so this
    // now guards output determinism (registration order, no dropped checks).
    const seq = await makeRunner(rules, 1).runPageRules(makePage());
    const par = await makeRunner(rules, 8).runPageRules(makePage());

    // allChecks order == registration order, regardless of completion order.
    expect(par.checks.map((c) => c.name)).toEqual(ids);
    // Concurrent run matches sequential run byte-for-byte.
    expect(par.checks).toEqual(seq.checks);
    // ruleResults insertion order preserved too.
    expect([...par.ruleResults.keys()]).toEqual(ids);
    expect([...par.ruleResults.keys()]).toEqual([...seq.ruleResults.keys()]);
  });

  test("a rule throwing still yields a deterministic fail check in order", async () => {
    const rules: Rule[] = [
      {
        meta: { id: "test/ok-a", name: "A", description: "", category: "core", scope: "page", severity: "info", weight: 1 },
        run: () => ({ checks: [{ name: "test/ok-a", status: "pass", message: "a" }] }),
      },
      {
        meta: { id: "test/boom", name: "Boom", description: "", category: "core", scope: "page", severity: "info", weight: 1 },
        async run() {
          await new Promise((r) => setTimeout(r, 1));
          throw new Error("kaboom");
        },
      },
      {
        meta: { id: "test/ok-b", name: "B", description: "", category: "core", scope: "page", severity: "info", weight: 1 },
        run: () => ({ checks: [{ name: "test/ok-b", status: "pass", message: "b" }] }),
      },
    ];

    const result = await makeRunner(rules, 8).runPageRules(makePage());
    expect(result.checks.map((c) => c.name)).toEqual([
      "test/ok-a",
      "test/boom-error",
      "test/ok-b",
    ]);
    const boom = result.checks.find((c) => c.name === "test/boom-error");
    expect(boom?.status).toBe("fail");
    expect(boom?.message).toContain("kaboom");
  });

  test("synchronous page rules run via the sync fast-path in registration order", async () => {
    // All three rules have a sync run() — the common case (#521). Output must be
    // ordered + complete with no awaiting needed for any of them.
    const rules: Rule[] = ["a", "b", "c"].map((k) => ({
      meta: { id: `test/sync-${k}`, name: k, description: "", category: "core", scope: "page", severity: "info", weight: 1 },
      run: () => ({ checks: [{ name: `test/sync-${k}`, status: "pass", message: k }] }),
    }));

    const result = await makeRunner(rules, 8).runPageRules(makePage());
    expect(result.checks.map((c) => c.name)).toEqual(["test/sync-a", "test/sync-b", "test/sync-c"]);
    expect([...result.ruleResults.keys()]).toEqual(["test/sync-a", "test/sync-b", "test/sync-c"]);
  });

  test("mixed sync + async page rules land in registration order", async () => {
    // sync rule sits between two async rules; the async results must still be
    // fully resolved (not pending Promises) and assembled in registration order.
    const rules: Rule[] = [
      {
        meta: { id: "test/async-a", name: "A", description: "", category: "core", scope: "page", severity: "info", weight: 1 },
        async run() {
          await new Promise((r) => setTimeout(r, 4));
          return { checks: [{ name: "test/async-a", status: "pass", message: "a" }] };
        },
      },
      {
        meta: { id: "test/sync-b", name: "B", description: "", category: "core", scope: "page", severity: "info", weight: 1 },
        run: () => ({ checks: [{ name: "test/sync-b", status: "pass", message: "b" }] }),
      },
      {
        meta: { id: "test/async-c", name: "C", description: "", category: "core", scope: "page", severity: "info", weight: 1 },
        async run() {
          await new Promise((r) => setTimeout(r, 1));
          return { checks: [{ name: "test/async-c", status: "pass", message: "c" }] };
        },
      },
    ];

    const result = await makeRunner(rules, 8).runPageRules(makePage());
    expect(result.checks.map((c) => c.name)).toEqual(["test/async-a", "test/sync-b", "test/async-c"]);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
  });

  test("site rule output is identical to sequential & in registration order", async () => {
    const { rules, ids } = makeDelayedRules(8);
    const siteRules = rules.map((r) => ({
      ...r,
      meta: { ...r.meta, scope: "site" as const },
    }));

    const seq = await makeRunner(siteRules, 1).runSiteRules(makeSiteData());
    const par = await makeRunner(siteRules, 8).runSiteRules(makeSiteData());

    expect(par.checks.map((c) => c.name)).toEqual(ids);
    expect(par.checks).toEqual(seq.checks);
    expect([...par.ruleResults.keys()]).toEqual(ids);
  });
});
