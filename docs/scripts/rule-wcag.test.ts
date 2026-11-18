import { describe, expect, test } from "bun:test";

import { wcag } from "../../packages/core-contracts/src/wcag";
import type { RuleMeta } from "../../packages/rules/src/types";
import { renderBlock, rulesWithWcagBlock, withBlock } from "./rule-wcag";

const meta = (over: Partial<RuleMeta>): RuleMeta =>
  ({ id: "a11y/x", name: "X", description: "", category: "a11y", scope: "page", severity: "warning", weight: 1, ...over }) as RuleMeta;

describe("rule-wcag generated block (pub#2024 review)", () => {
  test("a mapped rule's intro says the checks do not prove conformance", () => {
    const block = renderBlock(meta({ wcag: [wcag("4.1.2")] }));
    expect(block).toContain("These automated checks cover part of WCAG; passing them does not mean a site conforms.");
    expect(block).toContain("| 4.1.2 Name, Role, Value | A | WCAG 2.0 |");
    expect(block.match(/does not mean a site conforms/g)).toHaveLength(1);
  });

  test("a rule with no criterion shows the reason, not a table", () => {
    const block = renderBlock(meta({ wcagNone: "It checks something WCAG does not require." }));
    expect(block).toContain("No WCAG success criterion: It checks something WCAG does not require.");
    expect(block).not.toContain("| Criterion |");
  });

  test("an old page with the intro outside the markers is rewritten with one heading and one intro", () => {
    const old = [
      "# X",
      "",
      "## WCAG success criteria",
      "",
      "The WCAG success criteria this rule's findings map to. Run `squirrel audit --wcag-level AA` to keep only the accessibility rules with a criterion at Level A or AA.",
      "",
      "{/* rule-wcag:start */}",
      "",
      "| Criterion | Level | Introduced in |",
      "| --- | --- | --- |",
      "| 4.1.1 Parsing | A | WCAG 2.0 |",
      "",
      "{/* rule-wcag:end */}",
      "",
      "## Related rules",
      "",
    ].join("\n");
    const next = withBlock(old, meta({ wcagNone: "It checks something WCAG does not require." }));
    expect(next.match(/## WCAG success criteria/g)).toHaveLength(1);
    expect(next).not.toContain("4.1.1 Parsing");
    expect(next).not.toContain("with a criterion at Level A or AA");
    expect(next).toContain("No WCAG success criterion: It checks something WCAG does not require.");
    expect(next).toContain("\n## Related rules\n");
    expect(withBlock(next, meta({ wcagNone: "It checks something WCAG does not require." }))).toBe(next);
  });

  test("a page with no block gets the section before Related rules", () => {
    const next = withBlock("# X\n\n## Related rules\n\n- y\n", meta({ wcag: [wcag("1.1.1")] }));
    expect(next.indexOf("## WCAG success criteria")).toBeLessThan(next.indexOf("## Related rules"));
    expect(withBlock(next, meta({ wcag: [wcag("1.1.1")] }))).toBe(next);
  });
});

describe("rule-wcag pages (repo#3094)", () => {
  test("a non-a11y rule that declares wcag gets the block; one that declares nothing does not", () => {
    const ids = rulesWithWcagBlock([
      meta({ id: "images/alt-text", category: "images", wcag: [wcag("1.1.1")] }),
      meta({ id: "core/meta-title", category: "core" }),
      meta({ id: "a11y/x", wcagNone: "It checks something WCAG does not require." }),
    ]).map((m) => m.id);
    expect(ids).toEqual(["images/alt-text", "a11y/x"]);
  });
});
