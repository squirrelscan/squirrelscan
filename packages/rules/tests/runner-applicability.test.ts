import { afterEach, describe, expect, test } from "bun:test";

import type { SiteMetadata } from "@squirrelscan/core-contracts";

import type { RuleNamespace } from "../src/loader";
import { RuleRunner, type RulesConfig } from "../src/runner";
import type { ParsedPage, Rule, SiteData } from "../src/types";

// A site-scope test rule gated to local-business sites only. Tracks whether
// `run()` executed and what `ctx.siteMetadata` it observed.
let ran = false;
let observedMetadata: SiteMetadata | undefined;

const gatedRule: Rule = {
  meta: {
    id: "test/local-only",
    name: "Local Only (test)",
    description: "test rule gated to local businesses",
    category: "local",
    scope: "site",
    severity: "info",
    weight: 1,
    appliesWhen: { requiresLocalBusiness: true },
  },
  run(ctx) {
    ran = true;
    observedMetadata = ctx.siteMetadata;
    return { checks: [{ name: "ran", status: "pass", message: "ran" }] };
  },
};

const testNamespace: RuleNamespace = { name: "test", rules: [gatedRule] };

function makeRunner(
  siteMetadata?: SiteMetadata,
  config: Partial<RulesConfig["rules"]> = {}
): RuleRunner {
  const config_: RulesConfig = {
    rule_options: {},
    rules: { enable: ["test/local-only"], ...config },
  };
  return new RuleRunner({
    config: config_,
    additionalNamespaces: [testNamespace],
    siteMetadata,
  });
}

function makeSiteData(): SiteData {
  return {
    baseUrl: "https://example.com",
    pages: [
      {
        url: "https://example.com/",
        statusCode: 200,
        parsed: {} as ParsedPage,
      },
    ],
    robotsTxt: null,
    sitemaps: null,
  };
}

function meta(overrides: Partial<SiteMetadata> = {}): SiteMetadata {
  return {
    siteType: "blog",
    isYMYL: false,
    isLocalBusiness: false,
    hasOwnershipVerified: false,
    confidence: "high",
    ...overrides,
  };
}

afterEach(() => {
  ran = false;
  observedMetadata = undefined;
});

describe("runner applicability gate (site rules)", () => {
  test("gated-out rule emits a VISIBLE skipped check and does NOT run", async () => {
    const runner = makeRunner(meta({ isLocalBusiness: false }));
    const result = await runner.runSiteRules(makeSiteData());

    expect(ran).toBe(false);
    const skip = result.checks.find((c) => c.name === "test/local-only");
    expect(skip).toBeDefined();
    expect(skip?.status).toBe("skipped");
    expect(skip?.message).toContain("Not applicable");
    expect(skip?.skipReason).toContain("local business");

    // Persisted into ruleResults, not silently dropped.
    const rr = result.ruleResults.get("test/local-only");
    expect(rr?.checks[0]?.status).toBe("skipped");
  });

  test("applicable rule runs and receives ctx.siteMetadata", async () => {
    const m = meta({ isLocalBusiness: true });
    const runner = makeRunner(m);
    const result = await runner.runSiteRules(makeSiteData());

    expect(ran).toBe(true);
    expect(observedMetadata?.isLocalBusiness).toBe(true);
    expect(result.checks.some((c) => c.name === "ran" && c.status === "pass")).toBe(true);
  });

  test("ignore_applicability forces the gated rule to run anyway", async () => {
    const runner = makeRunner(meta({ isLocalBusiness: false }), {
      ignore_applicability: true,
    });
    const result = await runner.runSiteRules(makeSiteData());

    expect(ran).toBe(true);
    expect(result.checks.some((c) => c.name === "ran")).toBe(true);
    // No skipped check emitted.
    expect(result.checks.some((c) => c.status === "skipped")).toBe(false);
  });

  test("no metadata (undefined) → rule runs as today, ctx.siteMetadata undefined", async () => {
    // No siteMetadata threaded → undefined.
    const runner = makeRunner();
    const result = await runner.runSiteRules(makeSiteData());

    expect(ran).toBe(true);
    expect(observedMetadata).toBeUndefined();
    expect(result.checks.some((c) => c.name === "ran")).toBe(true);
  });

  test("low-confidence metadata → not gated, rule runs", async () => {
    const runner = makeRunner(meta({ isLocalBusiness: false, confidence: "low" }));
    const result = await runner.runSiteRules(makeSiteData());

    expect(ran).toBe(true);
    expect(result.checks.some((c) => c.name === "ran")).toBe(true);
  });
});
