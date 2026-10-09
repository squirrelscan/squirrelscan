// The shared probing budget: one object per run, the same one on every rule's
// ctx.probe, so --probe-budget caps ALL probing together rather than each rule
// on its own. No probing rule exists yet; the test rules below stand in for
// them and go through the real RuleRunner.

import { describe, expect, test } from "bun:test";

import type { RuleNamespace } from "../src/loader";
import { createProbeBudget, type ProbeBudget } from "../src/probe-budget";
import { RuleRunner, type RulesConfig } from "../src/runner";
import type { PageData, ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

/** A clock the test moves by hand. */
function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createProbeBudget", () => {
  test("passive allows nothing, whatever the budget", () => {
    const budget = createProbeBudget({ level: "passive", budgetMs: 60_000 });
    expect(budget.allows("quiet")).toBe(false);
    expect(budget.allows("loud")).toBe(false);
    expect(budget.summary().allowed).toBe(0);
  });

  test("active allows quiet probes and refuses loud ones", () => {
    const budget = createProbeBudget({ level: "active", budgetMs: 30_000 });
    expect(budget.allows("quiet")).toBe(true);
    expect(budget.allows("loud")).toBe(false);
  });

  test("aggressive allows both", () => {
    const budget = createProbeBudget({ level: "aggressive", budgetMs: 30_000 });
    expect(budget.allows("quiet")).toBe(true);
    expect(budget.allows("loud")).toBe(true);
  });

  test("a zero, negative or NaN budget allows nothing (never an unbounded cap)", () => {
    for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const budget = createProbeBudget({ level: "aggressive", budgetMs });
      expect(budget.allows("quiet")).toBe(false);
      expect(budget.budgetMs).toBe(0);
    }
  });

  test("the clock starts at the first allowed probe, not at construction", () => {
    const clock = fakeClock();
    const budget = createProbeBudget({ level: "active", budgetMs: 1_000, now: clock.now });
    // The crawl runs between creation and the rules phase; none of it counts.
    clock.advance(10_000);
    expect(budget.remainingMs()).toBe(1_000);
    expect(budget.allows("quiet")).toBe(true);
    clock.advance(400);
    expect(budget.remainingMs()).toBe(600);
  });

  test("once the deadline passes no probe starts, and the refusal is counted", () => {
    const clock = fakeClock();
    const budget = createProbeBudget({ level: "aggressive", budgetMs: 1_000, now: clock.now });
    expect(budget.allows("loud")).toBe(true);
    clock.advance(1_000);
    expect(budget.allows("loud")).toBe(false);
    expect(budget.allows("quiet")).toBe(false);
    const summary = budget.summary();
    expect(summary).toMatchObject({ allowed: 1, skippedForBudget: 2, exhausted: true });
    expect(summary.elapsedMs).toBe(1_000);
  });

  test("signal() is already aborted after the deadline and live before it", () => {
    const clock = fakeClock();
    const budget = createProbeBudget({ level: "active", budgetMs: 1_000, now: clock.now });
    budget.allows("quiet");
    expect(budget.signal().aborted).toBe(false);
    clock.advance(1_000);
    expect(budget.signal().aborted).toBe(true);
  });

  test("record() counts requests sent", () => {
    const budget = createProbeBudget({ level: "active", budgetMs: 1_000 });
    budget.record();
    budget.record(3);
    expect(budget.summary().requests).toBe(4);
  });
});

describe("ctx.probe through the RuleRunner", () => {
  const PAGE_RULE = "test/probe-page";
  const SITE_RULE = "test/probe-site";

  function probingRule(id: string, scope: "page" | "site", seen: Array<ProbeBudget | undefined>, clock?: { advance: (ms: number) => void }): Rule {
    return {
      meta: {
        id,
        name: id,
        description: "stands in for a probing rule",
        category: "core",
        scope,
        severity: "info",
        weight: 1,
      },
      run(ctx: RuleContext) {
        seen.push(ctx.probe);
        // Each "probe" takes 600 ms of the shared budget.
        const sent = ctx.probe?.allows("quiet") ?? false;
        if (sent) {
          clock?.advance(600);
          ctx.probe?.record();
        }
        return { checks: [{ name: id, status: "pass", message: sent ? "probed" : "skipped" }] };
      },
    };
  }

  function runner(rules: Rule[], probe?: ProbeBudget): RuleRunner {
    const config: RulesConfig = { rule_options: {}, rules: { enable: rules.map((r) => r.meta.id) } };
    const ns: RuleNamespace = { name: "test", rules };
    return new RuleRunner({ config, additionalNamespaces: [ns], ...(probe ? { probe } : {}) });
  }

  const page: PageData = {
    url: "https://example.com/",
    html: "<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>",
    statusCode: 200,
    loadTime: 0,
    headers: {},
  };
  const site: SiteData = {
    baseUrl: "https://example.com",
    pages: [{ url: "https://example.com/", statusCode: 200, parsed: {} as ParsedPage }],
    robotsTxt: null,
    sitemaps: null,
  };

  test("page and site rules see the same budget object", async () => {
    const seen: Array<ProbeBudget | undefined> = [];
    const probe = createProbeBudget({ level: "active", budgetMs: 30_000 });
    const r = runner([probingRule(PAGE_RULE, "page", seen), probingRule(SITE_RULE, "site", seen)], probe);
    await r.runPageRules(page, site);
    await r.runSiteRules(site);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(probe);
    expect(seen[1]).toBe(probe);
  });

  test("the cap is shared: once one rule spends it, the next rule's probe is refused", async () => {
    const seen: Array<ProbeBudget | undefined> = [];
    const clock = fakeClock();
    const probe = createProbeBudget({ level: "active", budgetMs: 1_000, now: clock.now });
    const r = runner([probingRule(PAGE_RULE, "page", seen, clock), probingRule(SITE_RULE, "site", seen, clock)], probe);
    // Two pages: the first probe spends 600 ms, the second spends 600 more,
    // so the site rule finds the budget gone.
    const first = await r.runPageRules(page, site);
    const second = await r.runPageRules({ ...page, url: "https://example.com/b" }, site);
    const siteRun = await r.runSiteRules(site);
    expect(first.checks[0]?.message).toBe("probed");
    expect(second.checks[0]?.message).toBe("probed");
    expect(siteRun.checks.find((c) => c.name === SITE_RULE)?.message).toBe("skipped");
    expect(probe.summary()).toMatchObject({ allowed: 2, requests: 2, skippedForBudget: 1 });
  });

  test("without a budget ctx.probe is undefined, which a probing rule reads as passive", async () => {
    const seen: Array<ProbeBudget | undefined> = [];
    const r = runner([probingRule(SITE_RULE, "site", seen)]);
    const siteRun = await r.runSiteRules(site);
    expect(seen).toEqual([undefined]);
    expect(siteRun.checks.find((c) => c.name === SITE_RULE)?.message).toBe("skipped");
  });
});
