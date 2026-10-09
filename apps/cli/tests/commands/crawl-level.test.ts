// `squirrel crawl -C fast` used to crawl unbounded: the command cast the raw
// flag to a level, the page lookup for `fast` was undefined, and
// `Math.min(undefined, cap)` is NaN, which no `pages >= cap` check ever stops.
// The crawl now resolves its level through the same parser as `audit`.
import { describe, expect, test } from "bun:test";

import { resolveCrawlBudget } from "@/cli/commands/crawl";

const DEFAULT_CONFIG = { crawler: { max_pages: 100 } };

function budget(input: Partial<Parameters<typeof resolveCrawlBudget>[0]>) {
  return resolveCrawlBudget({ config: DEFAULT_CONFIG, ...input });
}

describe("resolveCrawlBudget", () => {
  test.each([
    ["fast", "quick", 25],
    ["quick", "quick", 25],
    ["surface", "surface", 100],
    ["full", "full", 500],
    ["FULL", "full", 500],
  ] as const)(
    "-C %s crawls at the %s level, max %d pages",
    (raw, level, pages) => {
      for (const flags of [{ coverage: raw }, { level: raw }]) {
        const out = budget(flags);
        expect(out.ok).toBe(true);
        if (!out.ok) continue;
        expect(out.level).toBe(level);
        expect(out.coverageMode).toBe(level);
        expect(out.pageLimit.effective).toBe(pages);
        expect(Number.isFinite(out.pageLimit.effective)).toBe(true);
      }
    }
  );

  test("an unknown level is refused, naming the levels, never a NaN cap", () => {
    for (const raw of ["turbo", "deep", "", "full,full"]) {
      const out = budget({ coverage: raw });
      expect(out).toEqual({
        ok: false,
        error: `unknown audit level '${raw}'. Valid: quick, surface, full (fast is accepted as quick).`,
      });
    }
  });

  test("no flag: [crawler] coverage, else quick", () => {
    const fromConfig = budget({
      config: { crawler: { coverage: "full", max_pages: 100 } },
    });
    expect(fromConfig.ok && fromConfig.level).toBe("full");
    const fallback = budget({});
    expect(fallback.ok && fallback.level).toBe("quick");
    expect(fallback.ok && fallback.pageLimit.effective).toBe(25);
  });

  test("--max-pages overrides the level's budget and makes it custom", () => {
    const out = budget({ coverage: "fast", maxPages: "200" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.pageLimit.effective).toBe(200);
    expect(out.resolved).toMatchObject({
      level: "custom",
      basedOn: "quick",
      changes: ["pages"],
    });
  });

  test("a non-default [crawler] max_pages overrides it too", () => {
    const out = budget({
      level: "surface",
      config: { crawler: { max_pages: 40 } },
    });
    expect(out.ok && out.pageLimit.effective).toBe(40);
  });

  test("a non-numeric --max-pages is refused rather than crawling unbounded", () => {
    expect(budget({ maxPages: "abc" })).toEqual({
      ok: false,
      error: "--max-pages must be a positive integer (got 'abc').",
    });
    expect(budget({ maxPages: "0" }).ok).toBe(false);
  });

  test("the hard cap still applies", () => {
    const out = budget({ maxPages: "50000" });
    expect(out.ok && out.pageLimit.effective).toBe(10_000);
    expect(out.ok && out.pageLimit.clamped).toBe(true);
  });

  test("--level and -C naming different levels is refused", () => {
    const out = budget({ level: "full", coverage: "quick" });
    expect(out.ok).toBe(false);
  });
});
