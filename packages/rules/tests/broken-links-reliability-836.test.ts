// pub#836 and pub#843: broken links, internal, external and in-page anchors, are a reliability
// finding, not an SEO one.
//
// A dead link is a failed request a visitor hits. The rules keep their ids (configs,
// disable lists, `rule_options`, the rule cache and docs URLs all name `links/broken-links`)
// and change only `meta.category`, which is what a report badge and a score group read.
// `reliability` rolls up into the Performance group: that is a consequence of the decision,
// pinned here so changing it is deliberate.

import { describe, expect, test } from "bun:test";

import { matchesRulePattern } from "@squirrelscan/utils/rule-pattern";

import { getCategoryGroup, getCategoryName } from "../src/categories";
import { getRulesOutsideTheirPrefixCategory, loadAllRules } from "../src/loader";

const MOVED = ["links/broken-links", "links/broken-external-links", "links/broken-anchors"] as const;

describe("links/broken-links, links/broken-external-links and links/broken-anchors are Reliability rules", () => {
  const rules = loadAllRules();

  test("ids are unchanged and the category is reliability", () => {
    for (const id of MOVED) {
      const rule = rules.get(id);
      expect(rule?.meta.id).toBe(id);
      expect(rule?.meta.category).toBe("reliability");
    }
  });

  test("they report under the Reliability badge and score with the Performance group, not SEO", () => {
    for (const id of MOVED) {
      const category = rules.get(id)!.meta.category;
      expect(getCategoryName(category)).toBe("Reliability");
      expect(getCategoryGroup(category)).toBe("performance");
    }
  });

  test("every other links/* rule stays a Links rule", () => {
    const stayed = [...rules.values()].filter(
      (r) => r.meta.id.startsWith("links/") && !(MOVED as readonly string[]).includes(r.meta.id),
    );
    expect(stayed.length).toBeGreaterThan(5);
    for (const rule of stayed) expect(rule.meta.category).toBe("links");
  });

  test("existing configs keep working: patterns select by id, so links/* still names all of them", () => {
    for (const id of MOVED) {
      expect(matchesRulePattern(id, "links/*")).toBe(true);
      expect(matchesRulePattern(id, id)).toBe(true);
      expect(matchesRulePattern(id, "reliability/*")).toBe(false);
    }
  });

  test("the rules already in Reliability are unaffected", () => {
    expect(rules.get("reliability/broken-resources")?.meta.category).toBe("reliability");
    expect(rules.get("reliability/broken-forms")?.meta.category).toBe("reliability");
  });

  test("the registry names exactly these three as sitting outside their id prefix's category", () => {
    // A new mismatch is a decision (patterns match on the id), so it fails here until recorded.
    const found = getRulesOutsideTheirPrefixCategory().map((r) => `${r.id}:${r.category}`).sort();
    expect(found).toEqual(MOVED.map((id) => `${id}:reliability`).sort());
  });
});
