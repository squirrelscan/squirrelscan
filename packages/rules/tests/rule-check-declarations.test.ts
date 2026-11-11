// #1741: every rule declares the check names it can emit, by outcome class, so a consumer comparing two
// audits can map a problem check to the clean check that supersedes it without guessing from names.
//
// Rules adopt `meta.checks` in steps. `fixtures/rule-checks-undeclared.json` lists the ones that have not;
// it only shrinks. A rule that declares its checks must be removed from it (the test says so), and a new
// rule that declares nothing fails here, so the list never grows.
import { describe, expect, test } from "bun:test";

import { splitSuccessor } from "@squirrelscan/core-contracts/resolution";

import { loadAllRules } from "../src/loader";
import undeclaredBaseline from "./fixtures/rule-checks-undeclared.json";

const rules = [...loadAllRules().values()];
const declared = rules.filter((r) => r.meta.checks !== undefined);

describe("meta.checks declarations (#1741)", () => {
  test("a declaration is well formed", () => {
    for (const { meta } of declared) {
      const checks = meta.checks!;
      const id = meta.id;
      const keys = checks.map((c) => `${c.name}/${c.outcome}`);
      expect(new Set(keys).size, `${id} declares a name twice with the same outcome`).toBe(keys.length);
      expect(checks.some((c) => c.outcome === "clean"), `${id} declares no clean check`).toBe(true);
      expect(checks.some((c) => c.outcome === "problem"), `${id} declares no problem check`).toBe(true);
      const problems = new Set(checks.filter((c) => c.outcome === "problem").map((c) => c.name));
      for (const c of checks) {
        if (c.outcome !== "clean") {
          expect(c.clears, `${id}: only a clean check clears (${c.name})`).toBeUndefined();
          continue;
        }
        expect(c.clears?.length ?? 0, `${id}: clean check ${c.name} clears nothing`).toBeGreaterThan(0);
        for (const cleared of c.clears ?? []) {
          expect(problems.has(cleared), `${id}: ${c.name} clears "${cleared}", not a declared problem check`).toBe(true);
        }
      }
    }
  });

  test("the rules without a declaration are exactly the baseline, which only shrinks", () => {
    const undeclared = rules.filter((r) => r.meta.checks === undefined).map((r) => r.meta.id).sort();
    const baseline = new Set<string>(undeclaredBaseline);
    const nowDeclared = [...baseline].filter((id) => declared.some((r) => r.meta.id === id));
    expect(nowDeclared, "declare-d rules still in the baseline: remove them from fixtures/rule-checks-undeclared.json").toEqual([]);
    const added = undeclared.filter((id) => !baseline.has(id));
    expect(added, "a new rule must declare meta.checks (see RuleMeta.checks)").toEqual([]);
    const gone = [...baseline].filter((id) => !rules.some((r) => r.meta.id === id));
    expect(gone, "rules in the baseline that no longer exist: remove them").toEqual([]);
  });

  test("the baseline is sorted and has no duplicates", () => {
    expect([...undeclaredBaseline]).toEqual([...new Set(undeclaredBaseline)].sort());
  });

  test("the rules this issue names declare their problem to clean linkage", () => {
    const byId = new Map(rules.map((r) => [r.meta.id, r]));
    const clearsOf = (id: string, clean: string) =>
      byId.get(id)?.meta.checks?.find((c) => c.name === clean && c.outcome === "clean")?.clears ?? [];
    expect(clearsOf("security/leaked-secrets", "leaked-secrets")).toContain("leaked-secrets-critical");
    expect(clearsOf("security/hsts", "hsts")).toContain("hsts-missing");
    expect(clearsOf("security/x-frame-options", "x-frame-options")).toContain("x-frame-options-missing");
    expect(clearsOf("security/csp", "csp-present")).toContain("csp-missing");
    expect(clearsOf("content/dev-leakage", "dev-leakage")).toEqual(["dev-leakage"]);
  });

  // The rules that used to emit an EMPTY checks list when clean. A clean run says so now. The one case that
  // stays empty is a run that switched the rule off (kit-signature without a threat-intel handle).
  test("the formerly silent rules declare a clean check", () => {
    for (const id of [
      "content/date-agreement",
      "schema/rating-scope",
      "integrity/brand-impersonation",
      "integrity/cloaking",
      "integrity/fake-auth-overlay",
      "integrity/kit-signature",
      "integrity/known-malicious-url",
      "integrity/obfuscated-script",
      "integrity/seo-doorway",
    ]) {
      const rule = rules.find((r) => r.meta.id === id);
      expect(rule?.meta.checks?.some((c) => c.outcome === "clean"), id).toBe(true);
    }
  });

  test("supersededChecks (#1765) name successors, never the old name itself", () => {
    const withSuperseded = rules.filter((r) => r.meta.supersededChecks !== undefined);
    expect(withSuperseded.map((r) => r.meta.id).sort()).toEqual([
      "ax/ai-crawlers",
      "core/meta-description",
      "core/meta-title",
      "crawl/robots-txt",
      "links/broken-external-links",
      "links/broken-links",
      "links/internal-links",
    ]);
    for (const { meta } of withSuperseded) {
      for (const [oldName, successors] of Object.entries(meta.supersededChecks!)) {
        expect(successors.length, `${meta.id}: ${oldName} has no successor`).toBeGreaterThan(0);
        // A successor is a check name, or `check@locator` (#1780).
        const names = successors.map((x) => splitSuccessor(x).check);
        expect(names, `${meta.id}: ${oldName} supersedes itself`).not.toContain(oldName);
        expect(new Set(successors).size, `${meta.id}: duplicate successor`).toBe(successors.length);
        // `|` is the members separator (the LAST one): `chk@a|b` is locator `a` and members `b`, so a locator
        // containing `|` would be misread. At most one `|`, and what follows it is a meta key.
        for (const x of successors) {
          const bars = x.split("|").length - 1;
          expect(bars, `${meta.id}: ${oldName} successor "${x}" has more than one "|" (a locator cannot contain one)`).toBeLessThanOrEqual(1);
          if (bars === 1) {
            expect(x.split("|")[1], `${meta.id}: successor "${x}" has a "|" but no members key after it`).toMatch(/^[a-z][A-Za-z0-9]*$/);
            expect(x.includes("@"), `${meta.id}: successor "${x}" lists members without a locator`).toBe(true);
          }
        }
        for (const s of names) {
          // No chains. The one allowed shape is a pair of peers that name each other (a link that moves between
          // two checks, #1772): the merge decides one level, so a pair cannot loop.
          const back = meta.supersededChecks![s];
          if (back !== undefined) {
            expect(
              back.map((x) => splitSuccessor(x).check),
              `${meta.id}: ${s} is itself superseded, but not by ${oldName}`
            ).toEqual([oldName]);
          }
        }
      }
    }
    expect(withSuperseded.find((r) => r.meta.id === "core/meta-title")!.meta.supersededChecks).toEqual({
      "meta-title": ["meta-title-too-short", "meta-title-too-long"],
    });
  });
});
