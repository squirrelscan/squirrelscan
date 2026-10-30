// `[[ignore]]` and template fan-out (#1262): a verdict copied from one page of a
// template cluster onto another must not carry a page-dependent waiver with it.

import { describe, expect, test } from "bun:test";

import { RuleRunner, mayFanOutAcrossTemplate, type IgnoreEntry, type RulesConfig } from "@squirrelscan/rules";

import { createTemplateFanout } from "../src/template-fanout";

function runnerWith(ignore: IgnoreEntry[] | undefined): RuleRunner {
  const config: RulesConfig = { rule_options: {}, rules: { enable: ["*"], disable: [] }, ...(ignore ? { ignore } : {}) };
  return new RuleRunner({ config });
}

/** A built-in rule that declares its verdict a property of the template, so fan-out would copy it. */
const declared = (runner: RuleRunner): string[] =>
  runner
    .getEnabledRules()
    .filter((r) => mayFanOutAcrossTemplate(r.meta) && !r.meta.skipOnSoft404 && !r.meta.skipOnNoindex)
    .map((r) => r.meta.id);

describe("template fan-out", () => {
  const ruleResults = (ids: string[]) =>
    new Map(ids.map((id) => [id, { meta: { id } as never, checks: [{ name: "c", status: "warn" as const, message: "m" }] }]));

  test("copies declared rules between cluster members when no entry depends on the page", () => {
    const runner = runnerWith(undefined);
    const ids = declared(runner);
    expect(ids.length).toBeGreaterThan(3);
    const fanout = createTemplateFanout(runner);
    fanout.record("k", ruleResults(ids));
    expect([...(fanout.take("k")?.keys() ?? [])].sort()).toEqual([...ids].sort());
  });

  test("an items-only entry does not disqualify a rule: the filter is idempotent and page independent", () => {
    const ids = declared(runnerWith(undefined));
    const runner = runnerWith([{ rule: ids[0]!, items: ["x"] }]);
    expect(runner.ignoresByPage(ids[0]!)).toBe(false);
  });

  test("a rule an entry names by url is left out of the copied verdicts, the others still fan out", () => {
    const base = declared(runnerWith(undefined));
    const target = base[0]!;
    const runner = runnerWith([{ rule: target, urls: ["/apps/"] }]);
    const fanout = createTemplateFanout(runner);
    fanout.record("k", ruleResults(base));
    const taken = fanout.take("k");
    expect(taken?.has(target)).toBe(false);
    expect([...(taken?.keys() ?? [])].sort()).toEqual(base.filter((id) => id !== target).sort());
  });
});
