import { describe, expect, test } from "bun:test";

import {
  WCAG_CRITERIA,
  lowestWcagLevel,
  meetsWcagTarget,
  wcag,
} from "@squirrelscan/core-contracts/wcag";

import { loadAllRules } from "../src/loader";
import { wcagLevelDisablePatterns } from "../src/wcag-filter";

const a11y = [...loadAllRules().values()].filter((r) => r.meta.category === "a11y");

/** The a11y rules whose run() tests no WCAG success criterion (`wcagNone`). */
const UNMAPPED = [
  "a11y/accesskeys",
  "a11y/aria-text",
  "a11y/duplicate-id-active",
  "a11y/heading-order",
  "a11y/image-redundant-alt",
  "a11y/input-types",
  "a11y/landmark-one-main",
  "a11y/landmark-regions",
  "a11y/paste-inputs",
  "a11y/table-duplicate-name",
];

describe("a11y rules declare WCAG criteria (repo#3093)", () => {
  test("there are a11y rules to check", () => {
    expect(a11y.length).toBeGreaterThan(50);
  });

  test("every a11y rule declares exactly one of wcag or wcagNone", () => {
    const neither = a11y.filter((r) => !r.meta.wcag && r.meta.wcagNone === undefined).map((r) => r.meta.id);
    const both = a11y.filter((r) => r.meta.wcag && r.meta.wcagNone !== undefined).map((r) => r.meta.id);
    expect(neither).toEqual([]);
    expect(both).toEqual([]);
  });

  test("a declared wcag list names criteria from the table with their level and version", () => {
    for (const r of a11y.filter((x) => x.meta.wcag)) {
      expect(r.meta.wcag!.length, `${r.meta.id} declares an empty wcag list`).toBeGreaterThan(0);
      for (const c of r.meta.wcag!) {
        const entry = WCAG_CRITERIA[c.sc];
        expect(entry, `${r.meta.id} cites unknown ${c.sc}`).toBeDefined();
        expect(c.level).toBe(entry!.level);
        expect(c.version).toBe(entry!.version);
      }
    }
  });

  test("a wcagNone reason is one non-empty sentence", () => {
    for (const r of a11y.filter((x) => x.meta.wcagNone !== undefined)) {
      const reason = r.meta.wcagNone!.trim();
      expect(reason.length, `${r.meta.id} has an empty wcagNone`).toBeGreaterThan(20);
      expect(reason.endsWith("."), `${r.meta.id} wcagNone is not a sentence`).toBe(true);
      expect(reason, `${r.meta.id} wcagNone has an em dash`).not.toContain("\u2014");
    }
  });

  test("the rules that test no WCAG success criterion say why (pub#2024 review)", () => {
    const none = a11y
      .filter((r) => r.meta.wcagNone !== undefined)
      .map((r) => r.meta.id)
      .sort();
    expect(none).toEqual(UNMAPPED);
    const paste = a11y.find((r) => r.meta.id === "a11y/paste-inputs")!.meta;
    expect(paste.wcagNone).toContain("squirrelscan/squirrelscan#2106");
  });

  test("every criterion any rule cites, in any category, is in the table (pub#2024 review)", () => {
    const missing = [...loadAllRules().values()].flatMap((r) =>
      (r.meta.wcag ?? []).filter((c) => !WCAG_CRITERIA[c.sc]).map((c) => `${r.meta.id} ${c.sc}`),
    );
    expect(missing).toEqual([]);
  });

  test("the table has no 4.1.1, which WCAG 2.2 removed (pub#2024 review)", () => {
    expect(Object.keys(WCAG_CRITERIA)).not.toContain("4.1.1");
    expect(() => wcag("4.1.1")).toThrow('Unknown WCAG success criterion "4.1.1"');
  });

  test("duplicate-id-aria cites 4.1.2 Name, Role, Value, not the obsolete 4.1.1", () => {
    const meta = a11y.find((r) => r.meta.id === "a11y/duplicate-id-aria")!.meta;
    expect(meta.wcag).toEqual([wcag("4.1.2")]);
  });

  test("touch-targets cites 2.5.5 at AAA", () => {
    const meta = a11y.find((r) => r.meta.id === "a11y/touch-targets")!.meta;
    expect(meta.wcag).toEqual([wcag("2.5.5")]);
    expect(lowestWcagLevel(meta.wcag)).toBe("AAA");
  });

  test("reduced-motion cites 2.3.3 at AAA, not 2.2.2", () => {
    const meta = a11y.find((r) => r.meta.id === "a11y/reduced-motion")!.meta;
    expect(meta.wcag).toEqual([wcag("2.3.3")]);
    expect(lowestWcagLevel(meta.wcag)).toBe("AAA");
  });

  test("images/alt-text cites 1.1.1 Non-text Content at A; viewport-zoom and meta-title cite none (repo#3094)", () => {
    const all = loadAllRules();
    expect(all.get("images/alt-text")!.meta.wcag).toEqual([{ sc: "1.1.1", level: "A", version: "2.0" }]);
    expect(all.get("mobile/viewport-zoom")!.meta.wcag).toBeUndefined();
    expect(all.get("core/meta-title")!.meta.wcag).toBeUndefined();
  });

  test("wcag() rejects an unknown criterion", () => {
    expect(() => wcag("9.9.9")).toThrow();
  });
});

describe("meetsWcagTarget / wcagLevelDisablePatterns", () => {
  test("AA keeps A and AA, drops AAA-only rules", () => {
    expect(meetsWcagTarget([wcag("1.4.3")], "AA")).toBe(true);
    expect(meetsWcagTarget([wcag("1.1.1")], "AA")).toBe(true);
    expect(meetsWcagTarget([wcag("2.4.9")], "AA")).toBe(false);
    expect(meetsWcagTarget([wcag("1.4.3")], "A")).toBe(false);
    expect(meetsWcagTarget([wcag("1.4.3"), wcag("1.1.1")], "A")).toBe(true);
    expect(meetsWcagTarget(undefined, "A")).toBe(true);
  });

  test("patterns cover only a11y rules above the target", () => {
    const metas = [...loadAllRules().values()].map((r) => r.meta);
    const aa = wcagLevelDisablePatterns(metas, "AA");
    expect(aa).toContain("a11y/touch-targets");
    expect(aa).toContain("a11y/identical-links-same-purpose");
    expect(aa).not.toContain("a11y/color-contrast");
    expect(aa.every((id) => id.startsWith("a11y/"))).toBe(true);
    expect(wcagLevelDisablePatterns(metas, "AAA")).toEqual(UNMAPPED);
    const a = wcagLevelDisablePatterns(metas, "A");
    expect(a).toContain("a11y/color-contrast");
    expect(a).not.toContain("a11y/button-name");
  });
});

describe("images/alt-text under --wcag-level (repo#3094)", () => {
  test("is never in a level's disables, nor are untagged non-a11y rules: the level filters a11y rules only", () => {
    const metas = [...loadAllRules().values()].map((r) => r.meta);
    expect(metas.find((m) => m.id === "images/alt-text")!.wcag).toEqual([{ sc: "1.1.1", level: "A", version: "2.0" }]);
    for (const level of ["A", "AA", "AAA"] as const) {
      const out = wcagLevelDisablePatterns(metas, level);
      expect(out, level).not.toContain("images/alt-text");
      expect(out, level).not.toContain("mobile/viewport-zoom");
      expect(out, level).not.toContain("core/meta-title");
    }
  });
});

describe("a rule with no WCAG success criterion under --wcag-level", () => {
  test("is left out at every level, since the level keeps only mapped rules", () => {
    const metas = [...loadAllRules().values()].map((r) => r.meta);
    for (const level of ["A", "AA", "AAA"] as const) {
      const out = wcagLevelDisablePatterns(metas, level);
      for (const id of UNMAPPED) expect(out, `${id} at ${level}`).toContain(id);
    }
  });
});
