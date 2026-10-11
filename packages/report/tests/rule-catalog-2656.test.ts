// squirrelscan/repo#2656: a capped published report carries no rule text; the
// renderer joins it from the rule catalog, and an old report that still carries
// its own text shows the catalog's current text too.

import { describe, expect, test } from "bun:test";

import { ruleCatalogLookup, withCatalogRuleText } from "../src/rule-catalog";

const lookup = ruleCatalogLookup([
  { id: "core/doctype", description: "Checks for a doctype", solution: "Add <!DOCTYPE html>." },
  { id: "core/charset", description: "Checks the charset" },
]);

function report(meta: Record<string, { description: string; solution?: string }>) {
  return {
    baseUrl: "https://example.com/",
    ruleResults: Object.fromEntries(
      Object.entries(meta).map(([id, text]) => [
        id,
        { meta: { id, name: id, ...text }, checks: [{ name: "x", status: "fail", message: "m" }] },
      ]),
    ),
  };
}

describe("withCatalogRuleText", () => {
  test("fills the text a capped report left out", () => {
    const out = withCatalogRuleText(report({ "core/doctype": { description: "" } }), lookup);
    expect(out.ruleResults["core/doctype"]!.meta).toEqual({
      id: "core/doctype",
      name: "core/doctype",
      description: "Checks for a doctype",
      solution: "Add <!DOCTYPE html>.",
    });
  });

  test("an old report shows the catalog's current text", () => {
    const out = withCatalogRuleText(
      report({ "core/doctype": { description: "Old text", solution: "Old fix" } }),
      lookup,
    );
    expect(out.ruleResults["core/doctype"]!.meta.description).toBe("Checks for a doctype");
    expect(out.ruleResults["core/doctype"]!.meta.solution).toBe("Add <!DOCTYPE html>.");
  });

  test("a rule the catalog no longer has keeps its report's text", () => {
    const input = report({ "core/retired": { description: "Retired rule", solution: "Fix" } });
    expect(withCatalogRuleText(input, lookup)).toBe(input);
  });

  test("a catalog entry without a solution keeps the report's", () => {
    const out = withCatalogRuleText(
      report({ "core/charset": { description: "", solution: "Use UTF-8." } }),
      lookup,
    );
    expect(out.ruleResults["core/charset"]!.meta).toMatchObject({
      description: "Checks the charset",
      solution: "Use UTF-8.",
    });
  });

  test("never mutates its input and keeps the checks arrays", () => {
    const input = report({ "core/doctype": { description: "" } });
    const before = JSON.stringify(input);
    const out = withCatalogRuleText(input, lookup);
    expect(JSON.stringify(input)).toBe(before);
    expect(out.ruleResults["core/doctype"]!.checks).toBe(input.ruleResults["core/doctype"]!.checks);
  });
});
