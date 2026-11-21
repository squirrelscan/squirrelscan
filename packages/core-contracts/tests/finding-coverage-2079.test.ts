import { describe, expect, test } from "bun:test";

import {
  FINDING_COVERAGE_MAX_ROWS,
  REQUESTED_PAGES_MAX_URLS,
  summarizeFindingCoverage,
  summarizeRequestedPages,
} from "../src/finding-coverage";

const f = (url: string, ruleId = "core/meta-title", checkName = "Meta Title") => ({
  normalizedUrl: `https://a.test/${url}`,
  ruleId,
  checkName,
});

describe("summarizeFindingCoverage (#2079)", () => {
  test("is null when nothing was held (a first run)", () => {
    expect(summarizeFindingCoverage({ held: [], carried: [] })).toBeNull();
  });

  test("states pages held, re-checked and carried per rule check", () => {
    const cov = summarizeFindingCoverage({
      held: [f("a"), f("b"), f("c"), f("a", "core/h1", "H1")],
      carried: [f("b"), f("c")],
    })!;
    expect(cov.rows).toEqual([
      { ruleId: "core/meta-title", checkName: "Meta Title", pagesHeld: 3, pagesRechecked: 1, pagesCarried: 2 },
      { ruleId: "core/h1", checkName: "H1", pagesHeld: 1, pagesRechecked: 1, pagesCarried: 0 },
    ]);
  });

  test("counts a page once per check and ignores a carried page that was not held", () => {
    const cov = summarizeFindingCoverage({
      held: [f("a"), f("a")],
      carried: [f("a"), f("a"), f("zzz")],
    })!;
    expect(cov.rows[0]).toMatchObject({ pagesHeld: 1, pagesRechecked: 0, pagesCarried: 1 });
  });

  test("clips rows at the cap, keeping the most carried, and says so", () => {
    const held = Array.from({ length: FINDING_COVERAGE_MAX_ROWS + 5 }, (_, i) =>
      f("p", `r/x${String(i).padStart(3, "0")}`, "c"),
    );
    const last = held[held.length - 1]!;
    const cov = summarizeFindingCoverage({ held, carried: [last] })!;
    expect(cov.rows).toHaveLength(FINDING_COVERAGE_MAX_ROWS);
    expect(cov.truncated).toBe(true);
    expect(cov.rows[0]!.ruleId).toBe(last.ruleId);
  });
});

describe("summarizeRequestedPages (#2079)", () => {
  test("is null when nothing was requested", () => {
    expect(summarizeRequestedPages({ requested: [], observed: new Set() })).toBeNull();
  });

  test("counts the requested set and how much of it was re-observed", () => {
    const r = summarizeRequestedPages({
      requested: ["https://a.test/b", "https://a.test/a", "https://a.test/a"],
      observed: new Set(["https://a.test/a", "https://a.test/other"]),
    })!;
    expect(r).toEqual({ pages: 2, rechecked: 1, urls: ["https://a.test/a", "https://a.test/b"] });
  });

  test("clips the listed urls but keeps the counts exact", () => {
    const requested = Array.from({ length: REQUESTED_PAGES_MAX_URLS + 3 }, (_, i) => `https://a.test/${i}`);
    const r = summarizeRequestedPages({ requested, observed: new Set(requested) })!;
    expect(r.pages).toBe(REQUESTED_PAGES_MAX_URLS + 3);
    expect(r.rechecked).toBe(REQUESTED_PAGES_MAX_URLS + 3);
    expect(r.urls).toHaveLength(REQUESTED_PAGES_MAX_URLS);
    expect(r.urlsTruncated).toBe(true);
  });
});
