// Concurrent audits in ONE isolate must NOT cross-contaminate per-run state.
//
// Regression guard for #126: site metadata + prefetched cloud results used to be
// process-global singletons (`setSiteMetadata`/`setCloudResults`). With the
// cloud runner executing concurrent audits — and rules running with bounded
// concurrency — one audit's `setSiteMetadata`/`setCloudResults` could clobber
// another mid-flight, corrupting the applicability gate and cloud reads. They
// are now threaded per-run via the RuleRunner instance → `ctx.siteMetadata` /
// `ctx.cloudResults`. This test runs two audits concurrently with interleaved
// awaits and asserts each rule only ever observed its OWN run's state.

import { describe, expect, test } from "bun:test";

import type { SiteMetadata } from "@squirrelscan/core-contracts";

import { readCloudResult, type CloudResultStore } from "../src/cloud";
import type { RuleNamespace } from "../src/loader";
import { RuleRunner, type RulesConfig } from "../src/runner";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

// What a single rule invocation saw of its run's per-run state.
interface Observation {
  runId: string;
  siteType?: string;
  isLocalBusiness?: boolean;
  // The `data.runId` echoed back from the cloud result store.
  cloudRunId?: string;
}

const RULE_ID = "test/observe-run-state";

// A rule that records the per-run state it observed, awaiting a tick FIRST so two
// concurrent runners' invocations interleave. If state were a global, the second
// runner's `set*` would already have clobbered the first runner's by the time the
// first rule resumes after the await.
function makeObservingRule(observations: Observation[]): Rule {
  return {
    meta: {
      id: RULE_ID,
      name: "Observe Run State (test)",
      description: "records ctx.siteMetadata + ctx.cloudResults per run",
      category: "core",
      scope: "site",
      severity: "info",
      weight: 1,
    },
    async run(ctx: RuleContext) {
      // Yield so the OTHER runner's rule body gets a chance to run (and would
      // mutate any shared global) before we read our context back.
      await new Promise((r) => setTimeout(r, 5));

      const cloud = readCloudResult<{ runId: string }>(
        ctx.cloudResults,
        "site-metadata"
      );

      observations.push({
        runId: (ctx.options.runId as string) ?? "?",
        siteType: ctx.siteMetadata?.siteType,
        isLocalBusiness: ctx.siteMetadata?.isLocalBusiness,
        cloudRunId: cloud?.data?.runId,
      });

      // Yield again to maximise interleaving across the two runs.
      await new Promise((r) => setTimeout(r, 5));

      return { checks: [{ name: RULE_ID, status: "pass", message: "ran" }] };
    },
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

// Build a cloud store whose `site-metadata` envelope carries this run's id, so we
// can prove a rule read its OWN run's store and not the other run's.
function makeCloudStore(runId: string): CloudResultStore {
  return new Map([
    ["site-metadata", new Map([["site", { status: "ok", data: { runId } }]])],
  ]) as CloudResultStore;
}

function makeRunner(
  rule: Rule,
  runId: string,
  siteMetadata: SiteMetadata,
  cloudResults: CloudResultStore
): RuleRunner {
  const config: RulesConfig = {
    rule_options: { [RULE_ID]: { runId } },
    rules: { enable: [RULE_ID] },
  };
  const ns: RuleNamespace = { name: "test", rules: [rule] };
  return new RuleRunner({
    config,
    additionalNamespaces: [ns],
    siteMetadata,
    cloudResults,
  });
}

function makeSiteData(): SiteData {
  return {
    baseUrl: "https://example.com",
    pages: [
      { url: "https://example.com/", statusCode: 200, parsed: {} as ParsedPage },
    ],
    robotsTxt: null,
    sitemaps: null,
  };
}

describe("runner per-run state isolation (concurrent audits)", () => {
  test("two concurrent audits do NOT cross-contaminate siteMetadata or cloudResults", async () => {
    const observations: Observation[] = [];
    const rule = makeObservingRule(observations);

    // Audit A: a local-business shop. Audit B: a personal blog. Distinct cloud
    // stores too. Both runners run the SAME rule id concurrently.
    const runnerA = makeRunner(
      rule,
      "A",
      meta({ siteType: "ecommerce", isLocalBusiness: true }),
      makeCloudStore("A")
    );
    const runnerB = makeRunner(
      rule,
      "B",
      meta({ siteType: "blog", isLocalBusiness: false }),
      makeCloudStore("B")
    );

    // Run them concurrently — rule bodies interleave on the awaits above.
    await Promise.all([
      runnerA.runSiteRules(makeSiteData()),
      runnerB.runSiteRules(makeSiteData()),
    ]);

    expect(observations.length).toBe(2);

    const obsA = observations.find((o) => o.runId === "A");
    const obsB = observations.find((o) => o.runId === "B");
    expect(obsA).toBeDefined();
    expect(obsB).toBeDefined();

    // Each run observed ONLY its own site metadata.
    expect(obsA?.siteType).toBe("ecommerce");
    expect(obsA?.isLocalBusiness).toBe(true);
    expect(obsB?.siteType).toBe("blog");
    expect(obsB?.isLocalBusiness).toBe(false);

    // Each run read ONLY its own cloud store.
    expect(obsA?.cloudRunId).toBe("A");
    expect(obsB?.cloudRunId).toBe("B");
  });

  test("runs at high concurrency stay isolated across many interleaved audits", async () => {
    const observations: Observation[] = [];
    const rule = makeObservingRule(observations);

    const N = 8;
    const runners = Array.from({ length: N }, (_, i) => {
      const id = `R${i}`;
      const siteType = i % 2 === 0 ? "ecommerce" : "blog";
      return {
        id,
        runner: makeRunner(
          rule,
          id,
          meta({ siteType, isLocalBusiness: i % 2 === 0 }),
          makeCloudStore(id)
        ),
      };
    });

    await Promise.all(runners.map((r) => r.runner.runSiteRules(makeSiteData())));

    expect(observations.length).toBe(N);
    for (let i = 0; i < N; i++) {
      const id = `R${i}`;
      const obs = observations.find((o) => o.runId === id);
      expect(obs, `missing observation for ${id}`).toBeDefined();
      // siteMetadata + cloud store both match THIS run's id only.
      expect(obs?.cloudRunId).toBe(id);
      expect(obs?.siteType).toBe(i % 2 === 0 ? "ecommerce" : "blog");
      expect(obs?.isLocalBusiness).toBe(i % 2 === 0);
    }
  });
});
