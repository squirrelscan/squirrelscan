import { afterEach, describe, expect, test } from "bun:test";

import { pickTip, shouldShowTip, tipLabel, TIPS } from "@/cli/tips";
import { COVERAGE_FULL_MAX_PAGES } from "@/constants";

/**
 * Terminal-column width for the ASCII + one astral emoji + one variation
 * selector tipLabel() actually prints — not a general Unicode-width table.
 * Mirrors the accounting tipLabel()'s hand-padding relies on: a variation
 * selector is zero-width, a supplementary-plane code point (e.g. the
 * squirrel emoji, which needs a surrogate pair) renders 2 columns, anything
 * else is 1. Locks the invariant the kv-block alignment depends on.
 */
function renderedWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint === 0xfe0f) continue; // variation selector-16
    width += codePoint > 0xffff ? 2 : 1;
  }
  return width;
}

describe("pickTip", () => {
  test("always returns one of the 20 tips", () => {
    for (let i = 0; i < 200; i++) {
      expect(TIPS).toContain(pickTip());
    }
  });

  test("has exactly 20 tips (per the spec)", () => {
    expect(TIPS.length).toBe(20);
  });

  test("never returns undefined at either random-index boundary", () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0; // lowest index
      expect(pickTip()).toBe(TIPS[0]);
      Math.random = () => 0.9999999999; // highest index, never rounds out of bounds
      expect(pickTip()).toBe(TIPS[TIPS.length - 1]);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("interpolates the coverage constant instead of a hardcoded page count", () => {
    const fullCoverageTip = TIPS.find((t) => t.includes("--coverage full"));
    expect(fullCoverageTip).toBeDefined();
    expect(fullCoverageTip).not.toMatch(/\{COVERAGE_FULL_MAX_PAGES\}/);
    expect(fullCoverageTip).toContain(`up to ${COVERAGE_FULL_MAX_PAGES} pages`);
  });
});

describe("shouldShowTip", () => {
  const base = {
    tipsEnabled: true,
    stderrIsTTY: true,
    isConsoleFormat: true,
    outputPath: undefined,
  };

  test("shows for an interactive console run with tips enabled", () => {
    expect(shouldShowTip(base)).toBe(true);
  });

  test("suppresses when the tips setting is false", () => {
    expect(shouldShowTip({ ...base, tipsEnabled: false })).toBe(false);
  });

  test("suppresses when stderr is not a TTY (agents/CI)", () => {
    expect(shouldShowTip({ ...base, stderrIsTTY: false })).toBe(false);
  });

  test("suppresses for machine formats (json/text/html/markdown/xml/llm)", () => {
    expect(shouldShowTip({ ...base, isConsoleFormat: false })).toBe(false);
  });

  test("suppresses when the report is redirected to a file via --output", () => {
    expect(shouldShowTip({ ...base, outputPath: "report.html" })).toBe(false);
  });
});

describe("tipLabel", () => {
  const originalNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  test("renders exactly 10 columns with the emoji prefix, matching the kv block", () => {
    delete process.env.NO_COLOR;
    expect(renderedWidth(tipLabel())).toBe(10);
  });

  test("renders exactly 10 columns in the NO_COLOR plain fallback", () => {
    process.env.NO_COLOR = "1";
    expect(renderedWidth(tipLabel())).toBe(10);
    expect(tipLabel()).toBe("Tip".padEnd(10));
  });
});
