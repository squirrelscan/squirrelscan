// repo#2307 acceptance criterion 8: a labelled before/after evaluation of
// component-aware findings, run through the REAL rules and the REAL report
// grouping. The case corpus and its human labels live in
// fixtures/component-eval/cases.ts; the scoring in component-eval/evaluate.ts
// (shared with benchmarks/harness/component-findings-eval.ts).

import { describe, expect, test } from "bun:test";

import { renderJson } from "../../report/src/output/json";
import { renderLlm } from "../../report/src/output/llm";
import { renderText } from "../../report/src/output/text";
import {
  buildReport,
  evaluateCase,
  runCaseRules,
  ruleResults,
  type EvalOrder,
} from "./component-eval/evaluate";
import {
  EVAL_CASES,
  EVAL_RULES_UNDER_TEST,
} from "./fixtures/component-eval/cases";

const ORDERS: EvalOrder[] = ["forward", "reversed", "shuffled"];

describe("component findings evaluation (repo#2307)", () => {
  test("the corpus covers every case of the evaluation plan", () => {
    const plans = EVAL_CASES.map((c) => c.plan.split(".")[0]);
    for (const n of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]) {
      expect(plans).toContain(n);
    }
    expect(plans.filter((p) => p?.startsWith("stale-copyright"))).toHaveLength(
      3
    );
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
    expect(EVAL_RULES_UNDER_TEST).toEqual([
      "a11y/link-text",
      "content/stale-copyright",
    ]);
  });

  for (const evalCase of EVAL_CASES) {
    describe(evalCase.id, () => {
      test("labels agree with the observations: none missing, none extra", async () => {
        const result = await evaluateCase(evalCase);
        expect(result.unlabeled).toEqual([]);
        expect(result.unmatchedLabels).toEqual([]);
        expect(result.observations).toBe(
          evalCase.legacy ? 0 : evalCase.labels.length
        );
      });

      test("zero incorrect merges, zero missed merges, zero overclaims", async () => {
        const result = await evaluateCase(evalCase);
        expect(result.incorrectMerges).toBe(0);
        expect(result.missedMerges).toBe(0);
        expect(result.overclaims).toBe(0);
      });

      test("group counts match the authored expectations", async () => {
        const result = await evaluateCase(evalCase);
        expect(result.observedGroups).toBe(evalCase.expect.observedGroups);
        expect(result.afterGroups).toBe(evalCase.expect.afterGroups);
        expect(result.rollups).toBe(evalCase.expect.rollups);
      });

      test("an expected group covers exactly the pages its fixKey is labelled on", async () => {
        const result = await evaluateCase(evalCase);
        for (const group of result.groups) {
          // A group is a unit of ONE fix, so its pages are exactly the pages its labelled fix occurs on.
          expect(group.fixKeys).toHaveLength(1);
          const pages = new Set(
            evalCase.labels
              .filter((l) => l.fixKey === group.fixKeys[0])
              .map((l) => l.page)
          );
          expect([...pages].sort()).toEqual(group.pages);
        }
        for (const label of evalCase.labels.filter((l) => l.expectGrouped)) {
          const group = result.groups.find((g) =>
            g.fixKeys.includes(label.fixKey)
          );
          expect(group?.attribution).toBe("observed-component-evidence");
        }
      });

      test("no page is skipped: every page with a detection is accounted for", async () => {
        const { checks, pagesRun } = await runCaseRules(evalCase, "forward");
        // Every page is handed to every rule, whatever layout it shares with another page.
        expect(pagesRun).toBe(evalCase.pages.length);
        const result = await evaluateCase(evalCase);
        expect(result.pagesSkipped).toEqual([]);
        expect(result.coverageOk).toBe(true);
        if (!evalCase.legacy) {
          for (const rule of Object.values(checks)) {
            for (const check of rule.filter(
              (c) => c.status === "warn" || c.status === "fail"
            )) {
              expect(check.componentOccurrences?.length ?? 0).toBeGreaterThan(
                0
              );
            }
          }
        }
      });

      test("ids, membership and rollups do not depend on page order", async () => {
        const [forward, ...others] = await Promise.all(
          ORDERS.map((order) => evaluateCase(evalCase, { order }))
        );
        const shape = (r: NonNullable<typeof forward>) =>
          JSON.stringify({
            groups: r.groups.map((g) => [
              g.id,
              g.attribution,
              g.pages,
              g.members,
            ]),
            rollups: r.rollupSummary.map((x) => [
              x.level,
              x.variants,
              x.groupIds,
              x.pages,
            ]),
            counts: [
              r.observations,
              r.beforeGroups,
              r.afterGroups,
              r.affectedPages,
            ],
          });
        for (const other of others) expect(shape(other!)).toBe(shape(forward!));
      });

      test("the rules' detections equal the pinned golden (AC6)", async () => {
        const result = await evaluateCase(evalCase);
        for (const id of EVAL_RULES_UNDER_TEST) {
          expect(result.detectionRows[id] ?? []).toEqual(
            evalCase.expect.detections[id] ?? []
          );
        }
      });

      test("evidence changes presentation only: message grouping and health score are identical", async () => {
        const result = await evaluateCase(evalCase);
        expect(result.presentationOnly).toBe(true);
        expect(result.healthScoreOn).toBe(result.healthScoreOff);
        expect(result.healthScoreOn).not.toBeNull();
      });

      test("a legacy report (evidence stripped) renders without fix groups and without throwing", async () => {
        const { checks } = await runCaseRules(evalCase, "forward");
        const legacy = buildReport(evalCase, ruleResults(checks, true));
        const json = JSON.parse(renderJson(legacy)) as {
          issues: Array<{
            componentFixGroups?: unknown;
            checks: Array<{ componentOccurrences?: unknown }>;
          }>;
        };
        expect(json.issues.length).toBeGreaterThan(0);
        for (const issue of json.issues) {
          expect(issue.componentFixGroups).toBeUndefined();
          for (const check of issue.checks)
            expect(check.componentOccurrences).toBeUndefined();
        }
        const llm = renderLlm(legacy);
        const text = renderText(legacy);
        expect(llm).not.toContain("fix-once");
        expect(text).not.toContain("Fix once");
        // Falls back to the message grouping that existed before: the message is still reported.
        expect(`${llm}\n${text}`).toMatch(/generic text|copyright year/);
      });
    });
  }

  test("with evidence, a shared footer renders as one fix-once line", async () => {
    const evalCase = EVAL_CASES.find(
      (c) => c.id === "identical-footer-across-layouts"
    )!;
    const { checks } = await runCaseRules(evalCase, "forward");
    const report = buildReport(evalCase, ruleResults(checks, false));
    expect(renderLlm(report)).toContain('<fix-once pages="4">');
    expect(renderText(report)).toContain("Fix once in the site footer");
  });

  test("repeated cards and landmark-less blocks never claim observed (site-chrome) attribution", async () => {
    for (const id of [
      "repeated-cards-with-differing-data",
      "no-semantic-landmarks",
    ]) {
      const result = await evaluateCase(EVAL_CASES.find((c) => c.id === id)!);
      expect(
        result.groups.every((g) => g.attribution === "repeated-subtree")
      ).toBe(true);
    }
  });

  test("the legacy case has no observations at all, yet detections remain", async () => {
    const result = await evaluateCase(EVAL_CASES.find((c) => c.legacy)!);
    expect(result.observations).toBe(0);
    expect(result.afterGroups).toBe(0);
    expect(result.beforeGroups).toBeGreaterThan(0);
    expect(result.pagesWithDetections).toBeGreaterThan(0);
  });
});
