// `--max-duration` (#1271): the budget's deadlines, the flag parser and the
// report's reason sentence.

import { maxDurationReason } from "@squirrelscan/core-contracts/failure-reason";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DURATION_MIN_MARGIN_MS,
  createDurationBudget,
  maxDurationMarginMs,
  msUntil,
  wasCut,
} from "@/audit/max-duration";
import { parseMaxDurationFlag } from "@/cli/commands/audit";
import { loadReport } from "@/controllers/report";

describe("margin: max(10% of the budget, 15 s)", () => {
  test.each([
    [10, 15_000],
    [60, 15_000],
    [150, 15_000],
    [300, 30_000],
    [3600, 360_000],
  ])("a %i s budget has a %i ms margin", (seconds, margin) => {
    expect(maxDurationMarginMs(seconds * 1000)).toBe(margin);
  });
  test("never below the floor", () => {
    expect(maxDurationMarginMs(1)).toBe(MAX_DURATION_MIN_MARGIN_MS);
  });
});

describe("createDurationBudget", () => {
  test("unset, zero, negative and non-finite mean no budget", () => {
    for (const bad of [
      undefined,
      0,
      -3,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(createDurationBudget(bad, 1000)).toBeUndefined();
    }
  });

  test("every deadline sits inside the margin, in order", () => {
    const b = createDurationBudget(100, 1_000_000)!;
    expect(b.crawlStopAt).toBe(1_000_000 + 100_000);
    expect(b.crawlStopAt).toBeLessThan(b.checksDoneAt);
    expect(b.checksDoneAt).toBeLessThan(b.pageRulesStopAt);
    expect(b.pageRulesStopAt).toBeLessThan(b.hardStopAt);
    // The hard stop leaves part of the margin for writing the report.
    expect(b.hardStopAt).toBeLessThan(b.crawlStopAt + b.marginMs);
  });

  test("msUntil is never below 1, so a spent budget is not read as no budget", () => {
    expect(msUntil(10, 5000)).toBe(1);
    expect(msUntil(7000, 5000)).toBe(2000);
  });
});

describe("wasCut", () => {
  const none = {
    crawlStopped: true,
    unfetched: 0,
    pagesNotEvaluated: 0,
    rulesCut: false,
  };
  test("a crawl the budget stopped with nothing left queued is not a cut", () => {
    expect(wasCut(none)).toBe(false);
  });
  test("pages left queued, pages not evaluated or a cut rules phase is", () => {
    expect(wasCut({ ...none, unfetched: 3 })).toBe(true);
    expect(wasCut({ ...none, pagesNotEvaluated: 2 })).toBe(true);
    expect(wasCut({ ...none, rulesCut: true })).toBe(true);
  });
});

describe("--max-duration flag", () => {
  test("unset is undefined (no budget)", () => {
    expect(parseMaxDurationFlag(undefined)).toBeUndefined();
  });
  test.each([
    ["30", 30],
    ["90.5", 90.5],
    [" 12 ", 12],
  ])("%p parses to %p seconds", (raw, expected) => {
    expect(parseMaxDurationFlag(raw)).toBe(expected);
  });
  test.each(["0", "0.0", "-1", "abc", "", "1e3", "Infinity", "5s"])(
    "%p is rejected",
    (raw) => {
      expect(parseMaxDurationFlag(raw)).toBeNull();
    }
  );
});

describe("the reason sentence", () => {
  test("names the budget and what was left", () => {
    expect(
      maxDurationReason({
        seconds: 60,
        unfetchedPages: 12,
        pagesNotEvaluated: 1,
        siteChecksCut: true,
      })
    ).toBe(
      "Stopped at the 60 s time limit (--max-duration): 12 discovered pages were not fetched, 1 fetched page was not evaluated, site-wide checks did not finish"
    );
    expect(
      maxDurationReason({
        seconds: 5,
        unfetchedPages: 1,
        pagesNotEvaluated: 0,
        siteChecksCut: false,
      })
    ).toBe(
      "Stopped at the 5 s time limit (--max-duration): 1 discovered page was not fetched"
    );
  });
});

describe("a saved JSON report keeps the cut", () => {
  const slim = (extra: Record<string, unknown>) => ({
    meta: {
      version: "0.0.0",
      baseUrl: "http://example.test",
      timestamp: new Date(0).toISOString(),
      totalPages: 9,
    },
    score: { overall: 90, categories: {} },
    summary: { passed: 1, warnings: 0, failed: 0 },
    issues: [],
    status: "partial",
    statusReason:
      "Stopped at the 5 s time limit (--max-duration): 3 discovered pages were not fetched",
    statusReasonCode: "max_duration",
    ...extra,
  });

  async function reload(report: unknown) {
    const path = join(
      tmpdir(),
      `squirrel-maxdur-${Math.random().toString(36).slice(2)}.json`
    );
    await Bun.write(path, JSON.stringify(report));
    try {
      return await loadReport(path);
    } finally {
      await Bun.file(path).delete();
    }
  }

  test("status, reason code and the counts survive a round trip", async () => {
    const cut = {
      seconds: 5,
      unfetchedPages: 3,
      pagesNotEvaluated: 0,
      siteChecksCut: false,
    };
    const loaded = await reload(slim({ maxDuration: cut }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.data.status).toBe("partial");
    expect(loaded.data.statusReasonCode).toBe("max_duration");
    expect(loaded.data.maxDuration).toEqual(cut);
  });

  test("a malformed maxDuration is dropped, not trusted", async () => {
    for (const bad of [
      {
        seconds: "5",
        unfetchedPages: 3,
        pagesNotEvaluated: 0,
        siteChecksCut: false,
      },
      {
        seconds: 5,
        unfetchedPages: -1,
        pagesNotEvaluated: 0,
        siteChecksCut: false,
      },
      {
        seconds: 5,
        unfetchedPages: 3,
        pagesNotEvaluated: 0,
        siteChecksCut: "no",
      },
      "x",
    ]) {
      const loaded = await reload(slim({ maxDuration: bad }));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.data.maxDuration).toBeUndefined();
    }
  });
});
