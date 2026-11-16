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

describe("a11y rules declare WCAG criteria (repo#3093)", () => {
  test("there are a11y rules to check", () => {
    expect(a11y.length).toBeGreaterThan(50);
  });

  test("every a11y rule declares a criterion with level and version from the table", () => {
    const missing = a11y.filter((r) => !r.meta.wcag || r.meta.wcag.length === 0).map((r) => r.meta.id);
    expect(missing).toEqual([]);
    for (const r of a11y) {
      for (const c of r.meta.wcag!) {
        const entry = WCAG_CRITERIA[c.sc];
        expect(entry, `${r.meta.id} cites unknown ${c.sc}`).toBeDefined();
        expect(c.level).toBe(entry!.level);
        expect(c.version).toBe(entry!.version);
      }
    }
  });

  test("touch-targets cites 2.5.5 at AAA", () => {
    const meta = a11y.find((r) => r.meta.id === "a11y/touch-targets")!.meta;
    expect(meta.wcag).toEqual([wcag("2.5.5")]);
    expect(lowestWcagLevel(meta.wcag)).toBe("AAA");
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
    expect(wcagLevelDisablePatterns(metas, "AAA")).toEqual([]);
    const a = wcagLevelDisablePatterns(metas, "A");
    expect(a).toContain("a11y/color-contrast");
    expect(a).not.toContain("a11y/button-name");
  });
});
