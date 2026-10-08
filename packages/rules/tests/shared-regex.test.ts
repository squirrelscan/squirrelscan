// A rule abandoned by the time budget mid `exec()` loop must not leave the shared
// regex's `lastIndex` in the middle of the string for the next rule.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RuleNamespace } from "../src/loader";
import { runWithinBudget, RuleTimeoutError } from "../src/rule-budget";
import { RuleRunner, type RulesConfig } from "../src/runner";
import { resetSharedRegexes, sharedRegex } from "../src/shared-regex";
import type { PageData, Rule, RuleContext, RuleResult } from "../src/types";

const TEXT = "a1 b2 c3 d4 e5";
const SHARED = sharedRegex(/[a-z]\d/g);

function rule(id: string, run: (ctx: RuleContext) => RuleResult): Rule {
  return {
    meta: { id, name: id, description: "test rule", category: "core", scope: "page", severity: "info", weight: 1 },
    run,
  };
}

/** Counts every match, driving the shared regex with exec and no reset of its own. */
function countMatches(): number {
  let n = 0;
  while (SHARED.exec(TEXT) !== null) n++;
  return n;
}

describe("shared regex reset on abandon", () => {
  test("a rule killed mid-exec does not make the next rule on the same regex miss matches", async () => {
    const killed = rule("test/killed", () => {
      SHARED.exec(TEXT); // lastIndex is now past the first match
      const until = performance.now() + 300;
      while (performance.now() < until) {
        // spin until the watchdog abandons the rule
      }
      return { checks: [{ name: "test/killed", status: "pass", message: "ok" }] };
    });
    const next = rule("test/next", () => ({
      checks: [{ name: "test/next", status: "pass", message: `matches ${countMatches()}` }],
    }));
    const rules = [killed, next];
    const config: RulesConfig = { rule_options: {}, rules: { enable: rules.map((r) => r.meta.id) } };
    const ns: RuleNamespace = { name: "test", rules };
    const runner = new RuleRunner({ config, additionalNamespaces: [ns], ruleTimeBudgetMs: 50 });
    const page: PageData = { url: "https://example.com/", html: "<p>x</p>", statusCode: 200, loadTime: 0, headers: {} };

    const { checks } = await runner.runPageRules(page, { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null });

    expect(checks.find((c) => c.name === "test/killed-error")?.details).toMatchObject({ timedOut: true });
    expect(checks.find((c) => c.name === "test/next")?.message).toBe("matches 5");
  }, 30_000);

  test("runWithinBudget resets registered regexes on a timeout, and only then", () => {
    SHARED.lastIndex = 0;
    SHARED.exec(TEXT);
    expect(SHARED.lastIndex).toBeGreaterThan(0);
    // A call that finishes does not touch it.
    runWithinBudget(() => "done", 1000);
    expect(SHARED.lastIndex).toBeGreaterThan(0);
    expect(() =>
      runWithinBudget(() => {
        for (;;) {
          // spin
        }
      }, 30)
    ).toThrow(RuleTimeoutError);
    expect(SHARED.lastIndex).toBe(0);
    resetSharedRegexes();
  });

  test("sharedRegex ignores a non-stateful regex", () => {
    const plain = sharedRegex(/x/);
    expect(plain.global).toBe(false);
  });
});

// Guard: a module-level /g or /y regex driven with exec/test must be registered,
// or the abandon path cannot reset it.
describe("module-level stateful regexes are registered", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []
    );
  }

  test("every /g or /y constant used with exec or test goes through sharedRegex", () => {
    const decl = /^(?:export )?const (\w+)\b[^=\n]*= *(sharedRegex\()?(?:\/.*\/[a-z]*[gy][a-z]*|new RegExp\(.*"[a-z]*[gy][a-z]*"\))\)?[;,]?\s*$/gm;
    const unregistered: string[] = [];
    for (const file of sourceFiles(join(import.meta.dir, "../src"))) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(decl)) {
        const [, name, wrapped] = m;
        if (wrapped) continue;
        if (new RegExp(`\\b${name}\\.(?:exec|test)\\(`).test(source)) unregistered.push(`${file}: ${name}`);
      }
    }
    expect(unregistered).toEqual([]);
  });
});
