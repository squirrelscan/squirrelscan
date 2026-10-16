// pub#836, pub#843: a dead link is a reliability problem for visitors, not a
// search-engine one. The three broken-link rules moved from the Links category
// (SEO group) to Reliability. Their ids are unchanged, so configs, disable
// lists, `rule_options`, the rule cache and docs URLs keep working.

import { describe, expect, test } from "bun:test";

import { matchesRulePattern } from "@squirrelscan/utils/rule-pattern";

import { getCategoryGroup } from "../src/categories";
import { loadAllRules } from "../src/loader";

const MOVED = ["links/broken-links", "links/broken-external-links", "links/broken-anchors"];

describe("broken-link rules are reliability findings (pub#836, pub#843)", () => {
  test("the three rules sit in Reliability, under the Performance group, with their ids unchanged", () => {
    const rules = loadAllRules();
    for (const id of MOVED) {
      const rule = rules.get(id);
      expect(rule?.meta.category).toBe("reliability");
      expect(getCategoryGroup(rule!.meta.category)).toBe("performance");
    }
  });

  test("the other link rules stay in Links", () => {
    const links = [...loadAllRules().values()].filter(
      (r) => r.meta.id.startsWith("links/") && !MOVED.includes(r.meta.id),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const rule of links) expect(rule.meta.category).toBe("links");
  });

  test("existing patterns still select them by id", () => {
    for (const id of MOVED) {
      expect(matchesRulePattern(id, "links/*")).toBe(true);
      expect(matchesRulePattern(id, id)).toBe(true);
    }
  });
});
