// EVERY page rule declares a verdictScope (#1950).
//
// `meta.verdictScope` is optional in the type — making it required would turn
// `RuleMeta` into a discriminated union and every rule literal into a union member
// — so THIS is the enforcement. It is deliberately a named per-rule failure rather
// than a count: "3 rules are unclassified" sends you looking, "content/foo is
// unclassified" tells you.
//
// The direction that matters is safety. An unclassified rule must keep running per
// page, never be fanned out across a template cluster, which is why
// `mayFanOutAcrossTemplate` requires an explicit "template" and this file asserts
// that an absent declaration answers false.

import { describe, expect, test } from "bun:test";

import { loadAllRules } from "../src/loader";
import { mayFanOutAcrossTemplate, type RuleMeta } from "../src/types";

import measured from "./fixtures/template-invariance-measured.json";

const rules = [...loadAllRules().values()];
const pageRules = rules.filter((r) => r.meta.scope === "page");
const siteRules = rules.filter((r) => r.meta.scope === "site");

describe("verdictScope declarations", () => {
  test("the catalog loaded", () => {
    expect(pageRules.length).toBeGreaterThan(100);
    expect(siteRules.length).toBeGreaterThan(0);
  });

  test.each(pageRules.map((r) => [r.meta.id, r.meta] as const))(
    "%s declares a verdictScope",
    (_id, meta) => {
      expect(meta.verdictScope).toBeDefined();
      expect(["template", "page"]).toContain(meta.verdictScope);
    },
  );

  test.each(siteRules.map((r) => [r.meta.id, r.meta] as const))(
    "%s (site scope) does not declare one",
    (_id, meta) => {
      // A site rule runs once for the whole crawl; there is no cluster to fan it
      // across, so a declaration here would be a claim about nothing.
      expect(meta.verdictScope).toBeUndefined();
    },
  );
});

describe("mayFanOutAcrossTemplate", () => {
  test("an unclassified page rule does not fan out", () => {
    const meta = { id: "x/y", scope: "page" } as unknown as RuleMeta;
    expect(mayFanOutAcrossTemplate(meta)).toBe(false);
  });

  test("a site rule does not fan out even if it declares template", () => {
    const meta = { id: "x/y", scope: "site", verdictScope: "template" } as unknown as RuleMeta;
    expect(mayFanOutAcrossTemplate(meta)).toBe(false);
  });

  test("only an explicit page + template declaration fans out", () => {
    const yes = { id: "x/y", scope: "page", verdictScope: "template" } as unknown as RuleMeta;
    const no = { id: "x/y", scope: "page", verdictScope: "page" } as unknown as RuleMeta;
    expect(mayFanOutAcrossTemplate(yes)).toBe(true);
    expect(mayFanOutAcrossTemplate(no)).toBe(false);
  });

  test("the declared template set is a small minority and is not empty", () => {
    // Two failure modes this catches at a glance: a codemod that stamped
    // "template" on everything, and one that stamped "page" on everything.
    const fannable = pageRules.filter((r) => mayFanOutAcrossTemplate(r.meta));
    expect(fannable.length).toBeGreaterThan(20);
    expect(fannable.length).toBeLessThan(pageRules.length / 4);
  });
});

// ---------------------------------------------------------------------------
// The declarations against the measurement
// ---------------------------------------------------------------------------

describe("declared template rules vs the measurement on two real crawls", () => {
  // The crawls themselves cannot be checked in, so the RESULT is:
  // tests/fixtures/template-invariance-measured.json, produced by
  // apps/cli/scripts/template-rule-invariance.ts over gymshark.com (247 pages, 8
  // multi-page clusters) and openelectricity.org.au (100 pages, 3). This is the
  // half of #1950 that turns "a rule's inputs changed" into a named failure: the
  // parity gate in audit-engine catches a rule that varies on the AUTHORED corpus,
  // and this catches a rule promoted past what either real corpus supports.
  const corpora = Object.entries(measured.corpora) as Array<
    [string, { constantRules: string[]; varyingRules: string[] }]
  >;
  const constantIn = new Map(corpora.map(([name, c]) => [name, new Set(c.constantRules)]));

  test("the recorded measurement is intact", () => {
    expect(corpora.length).toBe(2);
    for (const [, c] of corpora) {
      expect(c.constantRules.length + c.varyingRules.length).toBe(pageRules.length);
    }
  });

  test.each(
    pageRules.filter((r) => mayFanOutAcrossTemplate(r.meta)).map((r) => [r.meta.id] as const),
  )('%s is constant on both measured corpora', (ruleId) => {
    for (const [name, ids] of constantIn) {
      if (!ids.has(ruleId)) {
        throw new Error(
          `${ruleId} declares verdictScope "template" but VARIED inside a cluster on ${name}. ` +
            "Either its inputs changed and it is now page-scoped, or the measurement is stale — " +
            "re-run apps/cli/scripts/template-rule-invariance.ts.",
        );
      }
    }
  });

  test("the declaration is a strict subset of what both corpora support", () => {
    // Deliberately NOT equality. A rule can be constant on both crawls and still
    // be page-scoped by construction: everything keyed only on the page url, every
    // parsed.links/images/schemas/meta reader, and every rule reading per-page site
    // data an offline probe leaves empty. Those are classified "page" by hand and
    // this asserts that judgement was actually exercised rather than skipped.
    const declared = pageRules.filter((r) => mayFanOutAcrossTemplate(r.meta)).length;
    const supported = [...constantIn.values()].reduce(
      (acc, ids) => new Set([...acc].filter((id) => ids.has(id))),
      new Set(pageRules.map((r) => r.meta.id)),
    ).size;
    expect(declared).toBeGreaterThan(20);
    expect(declared).toBeLessThan(supported / 2);
  });
});
