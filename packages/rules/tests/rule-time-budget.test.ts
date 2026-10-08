// Per-rule time budget: a rule that runs past it on a page is abandoned for that
// page and recorded as a rule error, and the audit carries on.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal, type CollectedSiteSignals } from "../src/collected-signals";
import type { RuleNamespace } from "../src/loader";
import {
  RULE_TIME_BUDGET_MS,
  RuleTimeoutError,
  SITE_RULE_BUDGET_CAP_MS,
  runWithinBudget,
  siteRuleBudgetMs,
} from "../src/rule-budget";
import { RuleRunner, type RulesConfig } from "../src/runner";
import type { PageData, ParsedPage, Rule, RuleContext, RuleResult, SiteData } from "../src/types";

const REDOS_HTML = readFileSync(join(import.meta.dir, "fixtures/redos-page.html"), "utf8");
// Known catastrophic: nested quantifier, then a character that cannot match.
// Deliberate catastrophic-backtracking test fixture. The pattern is read from a
// fixture file, like the page, so the static analyser does not flag a test input
// as a ReDoS in product code.
const CATASTROPHIC = new RegExp(readFileSync(join(import.meta.dir, "fixtures/redos-pattern.txt"), "utf8"));

function rule(id: string, scope: "page" | "site", run: (ctx: RuleContext) => RuleResult | Promise<RuleResult>): Rule {
  return {
    meta: { id, name: id, description: "test rule", category: "core", scope, severity: "info", weight: 1 },
    run,
  };
}

const pass = (id: string): RuleResult => ({ checks: [{ name: id, status: "pass", message: "ok" }] });

/** Runs the catastrophic regex over every `<p class="evil">` on the page. */
const redosRule = rule("test/redos", "page", (ctx) => {
  let matched = 0;
  for (const p of ctx.parsed.document?.querySelectorAll("p.evil") ?? []) {
    if (CATASTROPHIC.test(p.textContent ?? "")) matched++;
  }
  return { checks: [{ name: "test/redos", status: "pass", message: `matched ${matched}` }] };
});

function makeRunner(rules: Rule[], ruleTimeBudgetMs?: number): RuleRunner {
  const config: RulesConfig = { rule_options: {}, rules: { enable: rules.map((r) => r.meta.id) } };
  const ns: RuleNamespace = { name: "test", rules };
  return new RuleRunner({ config, additionalNamespaces: [ns], ruleTimeBudgetMs });
}

function redosPage(): PageData {
  // No `parsed`: the runner parses the fixture html itself, as for a real page.
  return { url: "https://example.com/evil", html: REDOS_HTML, statusCode: 200, loadTime: 0, headers: {} };
}

function siteData(pageCount = 1): SiteData {
  return {
    baseUrl: "https://example.com",
    pages: Array.from({ length: pageCount }, (_, i) => ({
      url: `https://example.com/${i}`,
      statusCode: 200,
      parsed: {} as ParsedPage,
    })),
    robotsTxt: null,
    sitemaps: null,
  };
}

const byName = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

// Canary for the whole mechanism. The budget relies on Bun's vm `timeout`
// interrupting a main-realm function (see rule-budget.ts). If a Bun upgrade turns
// that into a no-op, this must FAIL (an assertion, never a skip), and the
// message names the Bun version so the cause is obvious in CI.
describe("canary: the vm watchdog still fires", () => {
  const bunVersion = typeof Bun === "undefined" ? "unknown" : Bun.version;

  function mustTimeOut(label: string, fn: () => unknown, budgetMs: number): void {
    const started = performance.now();
    let error: unknown;
    try {
      runWithinBudget(fn, budgetMs);
    } catch (e) {
      error = e;
    }
    const elapsedMs = performance.now() - started;
    if (!(error instanceof RuleTimeoutError)) {
      throw new Error(
        `vm watchdog did NOT interrupt ${label} on Bun ${bunVersion} (ran ${Math.round(elapsedMs)} ms against a ${budgetMs} ms budget): the per-rule time budget is a no-op`
      );
    }
    expect(error.budgetMs).toBe(budgetMs);
    expect(elapsedMs).toBeLessThan(budgetMs + 2_000);
  }

  test("canary: vm timeout interrupts a main-realm spin loop", () => {
    mustTimeOut(
      "a spin loop",
      () => {
        const until = performance.now() + 1_500;
        while (performance.now() < until) {
          // spin
        }
      },
      100
    );
  });

  test("canary: vm timeout interrupts the ReDoS fixture's catastrophic regex", () => {
    const html = readFileSync(join(import.meta.dir, "fixtures/redos-page.html"), "utf8");
    const texts = [...html.matchAll(/<p class="evil">([^<]*)<\/p>/g)].map((m) => m[1]!);
    expect(texts.length).toBeGreaterThan(10);
    mustTimeOut(
      "a catastrophic regex over the fixture",
      () => {
        for (const text of texts) CATASTROPHIC.test(text);
      },
      200
    );
  }, 30_000);
});

describe("per-rule time budget", () => {
  test(
    "a catastrophic regex on a crafted page is abandoned within the budget and the audit carries on",
    async () => {
      const runner = makeRunner([
        rule("test/before", "page", () => pass("test/before")),
        redosRule,
        rule("test/after", "page", () => pass("test/after")),
        rule("test/site", "site", () => pass("test/site")),
      ]);

      const started = performance.now();
      const pageResult = await runner.runPageRules(redosPage(), siteData());
      const siteResult = await runner.runSiteRules(siteData());
      const elapsedMs = performance.now() - started;

      // Unbounded, 30 paragraphs at the engine's per-match backtracking cap is
      // over 20 s. Bounded: the default budget plus at most one runaway match.
      expect(elapsedMs).toBeLessThan(RULE_TIME_BUDGET_MS + 2_000);

      const err = byName(pageResult.checks, "test/redos-error");
      expect(err).toBeDefined();
      expect(err!.status).toBe("fail");
      expect(err!.message).toContain(`exceeded its ${RULE_TIME_BUDGET_MS} ms time budget`);
      expect(err!.details).toEqual({ timedOut: true, budgetMs: RULE_TIME_BUDGET_MS, pages: 1 });
      expect(byName(pageResult.checks, "test/redos")).toBeUndefined();
      expect(pageResult.ruleResults.get("test/redos")?.checks).toEqual([err!]);

      // Rules before and after it, and the site pass, all still ran.
      expect(byName(pageResult.checks, "test/before")?.status).toBe("pass");
      expect(byName(pageResult.checks, "test/after")?.status).toBe("pass");
      expect(byName(siteResult.checks, "test/site")?.status).toBe("pass");
    },
    30_000
  );

  test("a real backtracking rule on the ReDoS fixture times out through RuleRunner and the audit completes", async () => {
    // Mirrors how real rules run a regex: a module-level helper (main realm)
    // called from the rule, looped over elements of the parsed fixture page.
    const backtrack = (text: string) => CATASTROPHIC.test(text);
    const runner = makeRunner(
      [
        rule("test/backtrack", "page", (ctx) => {
          let hits = 0;
          for (const p of ctx.parsed.document?.querySelectorAll("p.evil") ?? []) {
            if (backtrack(p.textContent ?? "")) hits++;
          }
          return pass(`test/backtrack-${hits}`);
        }),
        rule("test/after-backtrack", "page", () => pass("test/after-backtrack")),
      ],
      200
    );
    const started = performance.now();
    const { checks } = await runner.runPageRules(redosPage(), siteData());
    const elapsedMs = performance.now() - started;

    const timeout = byName(checks, "test/backtrack-error");
    expect(timeout?.status).toBe("fail");
    expect(timeout?.details).toMatchObject({ timedOut: true, budgetMs: 200 });
    expect(byName(checks, "test/after-backtrack")?.status).toBe("pass");
    // Unbounded this is 20+ s; bounded it is the budget plus about one runaway match.
    expect(elapsedMs).toBeLessThan(200 + 2_000);
  }, 30_000);

  test("a rule's own try/catch cannot swallow the timeout", async () => {
    const runner = makeRunner(
      [
        rule("test/swallow", "page", (ctx) => {
          for (const p of ctx.parsed.document?.querySelectorAll("p.evil") ?? []) {
            try {
              CATASTROPHIC.test(p.textContent ?? "");
            } catch {
              // a rule that hides its own errors still gets abandoned
            }
          }
          return pass("test/swallow");
        }),
      ],
      100
    );
    const { checks } = await runner.runPageRules(redosPage());
    expect(checks.map((c) => c.name)).toEqual(["test/swallow-error"]);
    expect(checks[0].details).toEqual({ timedOut: true, budgetMs: 100, pages: 1 });
  }, 30_000);

  test("a site rule's budget scales with the site's page count", async () => {
    // Busy-waits 150 ms: over a 100 ms budget for one page, under it for three.
    const slow = rule("test/slow-site", "site", () => {
      const until = performance.now() + 150;
      while (performance.now() < until) {
        // spin
      }
      return pass("test/slow-site");
    });
    const one = await makeRunner([slow], 100).runSiteRules(siteData(1));
    expect(one.checks.map((c) => c.name)).toEqual(["test/slow-site-error"]);
    const three = await makeRunner([slow], 100).runSiteRules(siteData(3));
    expect(three.checks.map((c) => c.name)).toEqual(["test/slow-site"]);
    expect(siteRuleBudgetMs(100, 0)).toBe(100);
    expect(siteRuleBudgetMs(100, 25)).toBe(2_500);
    // Capped on big sites, so one stuck rule cannot hold an audit for an hour.
    expect(siteRuleBudgetMs(1000, 5_000)).toBe(SITE_RULE_BUDGET_CAP_MS);
  });

  test("the site-rule ceiling is a runner option", async () => {
    const slow = rule("test/slow-cap", "site", () => {
      const until = performance.now() + 200;
      while (performance.now() < until) {
        // spin
      }
      return pass("test/slow-cap");
    });
    expect(siteRuleBudgetMs(100, 50, 1_000)).toBe(1_000);
    expect(siteRuleBudgetMs(100, 50)).toBe(5_000);
    const config: RulesConfig = { rule_options: {}, rules: { enable: ["test/slow-cap"] } };
    const ns: RuleNamespace = { name: "test", rules: [slow] };
    // 100 ms per page x 50 pages would allow it; the 100 ms ceiling does not.
    const capped = new RuleRunner({ config, additionalNamespaces: [ns], ruleTimeBudgetMs: 100, siteRuleBudgetCapMs: 100 });
    expect((await capped.runSiteRules(siteData(50))).checks.map((c) => c.name)).toEqual(["test/slow-cap-error"]);
    const open = new RuleRunner({ config, additionalNamespaces: [ns], ruleTimeBudgetMs: 100 });
    expect((await open.runSiteRules(siteData(50))).checks.map((c) => c.name)).toEqual(["test/slow-cap"]);
  }, 30_000);

  test("a nested call runs under the outer budget and leaves the slot intact", () => {
    const out = runWithinBudget(() => {
      const inner = runWithinBudget(() => 1, 1000);
      return inner + runWithinBudget(() => 2, 1000);
    }, 1000);
    expect(out).toBe(3);
    expect(() => runWithinBudget(() => runWithinBudget(() => CATASTROPHIC.test("a".repeat(40) + "!"), 1000), 50)).toThrow(
      RuleTimeoutError
    );
    expect(runWithinBudget(() => "ok", 1000)).toBe("ok");
  });

  test("the outer budget survives a nested call that returned", () => {
    // If the inner call cleared the shared slot or the active flag, the outer
    // spin below would run unbounded or the outer call would lose its function.
    expect(() =>
      runWithinBudget(() => {
        expect(runWithinBudget(() => "inner", 1000)).toBe("inner");
        const until = performance.now() + 500;
        while (performance.now() < until) {
          // spin past the outer 50 ms budget
        }
        return "outer finished";
      }, 50)
    ).toThrow(RuleTimeoutError);
    // And the slot is free again afterwards.
    expect(runWithinBudget(() => "next", 1000)).toBe("next");
  });

  test("a rule that times out on many pages is one fail, then skipped checks", async () => {
    const slow = rule("test/slow-page", "page", () => {
      const until = performance.now() + 150;
      while (performance.now() < until) {
        // spin
      }
      return pass("test/slow-page");
    });
    const runner = makeRunner([slow], 50);
    const results = [];
    for (const i of [1, 2, 3]) {
      results.push(
        (await runner.runPageRules({ ...redosPage(), url: `https://example.com/p${i}` }, siteData())).checks
      );
    }
    const all = results.flat();
    expect(all.map((c) => c.status)).toEqual(["fail", "skipped", "skipped"]);
    expect(all.every((c) => c.name === "test/slow-page-error" && c.details?.["timedOut"] === true)).toBe(true);
    // The one fail carries the running count of pages.
    expect(all[0].details?.["pages"]).toBe(3);
  }, 30_000);

  test("a rule that timed out once still runs normally on later fast pages", async () => {
    let calls = 0;
    const flaky = rule("test/flaky", "page", () => {
      if (calls++ === 0) {
        const until = performance.now() + 150;
        while (performance.now() < until) {
          // one slow page, e.g. a GC pause
        }
      }
      return pass("test/flaky");
    });
    const runner = makeRunner([flaky], 50);
    const first = await runner.runPageRules({ ...redosPage(), url: "https://example.com/a" }, siteData());
    const second = await runner.runPageRules({ ...redosPage(), url: "https://example.com/b" }, siteData());
    expect(first.checks.map((c) => c.name)).toEqual(["test/flaky-error"]);
    expect(second.checks).toEqual([{ name: "test/flaky", status: "pass", message: "ok" }]);
  }, 30_000);

  test("three timeouts report 3 pages not checked, even when the first result was already serialized", async () => {
    const slow = rule("test/slow-sec", "page", () => {
      const until = performance.now() + 150;
      while (performance.now() < until) {
        // spin
      }
      return pass("test/slow-sec");
    });
    slow.meta.category = "security";
    const runner = makeRunner([slow], 50);
    let firstSnapshot = "";
    for (const i of [1, 2, 3]) {
      const { checks } = await runner.runPageRules({ ...redosPage(), url: `https://example.com/s${i}` }, siteData());
      // What a page-result sink holds the moment the page finishes.
      if (i === 1) firstSnapshot = JSON.stringify(checks);
    }
    // The early copy cannot see later pages...
    expect(JSON.parse(firstSnapshot)[0].details.pages).toBe(1);
    // ...so the total is its own check, in the site results.
    const { checks } = await runner.runSiteRules(siteData(3));
    const summary = byName(checks, "test/slow-sec-timeouts");
    expect(summary?.details).toMatchObject({ timedOut: true, budgetMs: 50, pagesNotChecked: 3 });
    expect(summary?.message).toContain("3 pages not checked");
    expect(summary?.message).toContain("did not check those pages");
  }, 30_000);

  test("two audits on one runner each get their own fail", async () => {
    const slow = rule("test/slow-twice", "page", () => {
      const until = performance.now() + 150;
      while (performance.now() < until) {
        // spin
      }
      return pass("test/slow-twice");
    });
    const runner = makeRunner([slow], 50);
    const auditStatuses = async (urls: string[]) => {
      const statuses: string[] = [];
      for (const url of urls) {
        const { checks } = await runner.runPageRules({ ...redosPage(), url }, siteData());
        statuses.push(checks[0].status);
      }
      return statuses;
    };

    expect(await auditStatuses(["https://example.com/1", "https://example.com/2"])).toEqual(["fail", "skipped"]);
    // runSiteRules ends an audit...
    await runner.runSiteRules(siteData());
    expect(await auditStatuses(["https://example.com/3"])).toEqual(["fail"]);
    // ...and resetAudit() is the explicit hook.
    runner.resetAudit();
    expect(await auditStatuses(["https://example.com/4"])).toEqual(["fail"]);
  }, 30_000);

  test("thrown errors and fast rules are unchanged", async () => {
    const runner = makeRunner([
      rule("test/throws", "page", () => {
        throw new TypeError("boom");
      }),
      rule("test/fast", "page", () => pass("test/fast")),
    ]);
    const { checks } = await runner.runPageRules(redosPage());
    expect(checks).toEqual([
      { name: "test/throws-error", status: "fail", message: "Rule error: boom" },
      { name: "test/fast", status: "pass", message: "ok" },
    ]);
  });

  test("an async rule's awaited I/O does not count against the budget", async () => {
    const runner = makeRunner(
      [
        rule("test/async", "page", async () => {
          await new Promise((r) => setTimeout(r, 80));
          return pass("test/async");
        }),
      ],
      20
    );
    const { checks } = await runner.runPageRules(redosPage());
    expect(checks.map((c) => c.name)).toEqual(["test/async"]);
  });

  test("a budget of 0 turns it off", () => {
    expect(runWithinBudget(() => 7, 0)).toBe(7);
    expect(() =>
      runWithinBudget(() => {
        throw new RangeError("passes through");
      }, 50)
    ).toThrow(RangeError);
  });
});

describe("page-time collectors run under the budget", () => {
  test("a collector timeout is recorded against its site rule and page", async () => {
    const collected: CollectedSiteSignals = {
      pages: [
        { ...emptySignal("https://example.com/a") },
        {
          ...emptySignal("https://example.com/b"),
          timedOut: { budgetMs: 1000, ruleIds: ["test/collected", "test/gated"] },
        },
      ],
    };
    const runner = makeRunner([
      rule("test/collected", "site", () => pass("test/collected")),
      rule("test/other", "site", () => pass("test/other")),
      // Gated off (only a skipped check): a collector timeout is not added to it.
      rule("test/gated", "site", () => ({
        checks: [{ name: "test/gated", status: "skipped", message: "n/a" }],
      })),
    ]);
    const { checks, ruleResults } = await runner.runSiteRules(siteData(2), undefined, collected);
    expect(ruleResults.get("test/collected")?.checks).toEqual([
      { name: "test/collected", status: "pass", message: "ok" },
      {
        name: "test/collected-error",
        status: "fail",
        message: "Rule error: exceeded its 1000 ms time budget and was abandoned",
        pageUrl: "https://example.com/b",
        details: { timedOut: true, budgetMs: 1000, pages: 1 },
      },
    ]);
    expect(ruleResults.get("test/other")?.checks).toHaveLength(1);
    expect(ruleResults.get("test/gated")?.checks).toHaveLength(1);
    expect(checks).toHaveLength(4);
  });

  test("a collector timing out on many pages is one check per rule with a page count", async () => {
    const timedOut = { budgetMs: 1000, ruleIds: ["test/collected"] };
    const collected: CollectedSiteSignals = {
      pages: ["a", "b", "c"].map((p) => ({ ...emptySignal(`https://example.com/${p}`), timedOut })),
    };
    const runner = makeRunner([rule("test/collected", "site", () => pass("test/collected"))]);
    const { ruleResults } = await runner.runSiteRules(siteData(3), undefined, collected);
    const errors = ruleResults.get("test/collected")!.checks.filter((c) => c.name === "test/collected-error");
    expect(errors).toHaveLength(1);
    expect(errors[0].pageUrl).toBe("https://example.com/a");
    expect(errors[0].details).toEqual({ timedOut: true, budgetMs: 1000, pages: 3 });
  });

  test("buildCollectedPageSignal yields empty values and lists the rules past the budget", () => {
    // ~4 MB of inline script: far past a 1 ms budget for the secrets scan.
    const body = `<script>${"var token = 'abcdefghijklmnopqrstuvwxyz0123456789';\n".repeat(80_000)}</script>`;
    const url = "https://example.com/big";
    const parsed = parsePage(`<html><body>${body}</body></html>`, url);
    const signal = buildCollectedPageSignal({ url, parsed, budgetMs: 1 });
    expect(signal.timedOut?.budgetMs).toBe(1);
    expect(signal.timedOut?.ruleIds).toContain("security/leaked-secrets");
    expect(signal.secrets).toEqual([]);

    const fine = buildCollectedPageSignal({
      url: "https://example.com/small",
      parsed: parsePage("<html><body><p>hi</p></body></html>", "https://example.com/small"),
    });
    expect(fine.timedOut).toBeUndefined();
  });
});

function emptySignal(url: string) {
  return {
    url,
    secrets: [],
    inlineCssLen: 0,
    inlineJsLen: 0,
    externalCssCount: 0,
    externalJsCount: 0,
    imageCount: 0,
    fingerprint: null,
    signals: [],
    scriptSrcs: [],
    subprocessorMatch: null,
    commercialOffer: false,
  };
}
