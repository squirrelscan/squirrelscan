// `--max-duration` (#1271): the budget's deadlines, the flag parser and the
// report's reason sentence.

import { maxDurationReason } from "@squirrelscan/core-contracts/failure-reason";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DURATION_MAX_SECONDS,
  MAX_DURATION_MIN_MARGIN_MS,
  createDurationBudget,
  maxDurationMarginMs,
  msUntil,
  raceUntil,
  wasCut,
} from "@/audit/max-duration";
import { parseMaxDurationFlag } from "@/cli/commands/audit";
import { loadReport, slimMaxDuration } from "@/controllers/report";

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
    expect(b.checksDoneAt).toBeLessThan(b.probesDoneAt);
    expect(b.probesDoneAt).toBeLessThan(b.pageRulesStopAt);
    expect(b.pageRulesStopAt).toBeLessThan(b.hardStopAt);
    // The hard stop leaves part of the margin for writing the report.
    expect(b.hardStopAt).toBeLessThan(b.crawlStopAt + b.marginMs);
  });

  test("discovery ends at 30% of the budget, before the crawl stops", () => {
    const b = createDurationBudget(100, 1_000_000)!;
    expect(b.discoveryDoneAt).toBe(1_000_000 + 30_000);
    expect(b.discoveryDoneAt).toBeLessThan(b.crawlStopAt);
  });

  test("a budget past 7 days is clamped, never a timer overflow", () => {
    const b = createDurationBudget(99_999_999, 0)!;
    expect(b.budgetMs).toBe(MAX_DURATION_MAX_SECONDS * 1000);
    expect(b.crawlStopAt).toBeLessThan(2 ** 31 * 1000);
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
    probesSkipped: [] as string[],
    pagesTooLarge: 0,
    tooLargePages: [] as string[],
  };
  test("a crawl the budget stopped with nothing left queued is not a cut", () => {
    expect(wasCut(none)).toBe(false);
  });
  test("pages left queued, pages not evaluated or a cut rules phase is", () => {
    expect(wasCut({ ...none, unfetched: 3 })).toBe(true);
    expect(wasCut({ ...none, pagesNotEvaluated: 2 })).toBe(true);
    expect(wasCut({ ...none, rulesCut: true })).toBe(true);
    expect(wasCut({ ...none, probesSkipped: ["soft-404-confirmation"] })).toBe(
      true
    );
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
  test("7 days is the ceiling", () => {
    expect(parseMaxDurationFlag("604800")).toBe(604800);
    expect(parseMaxDurationFlag("604801")).toBeNull();
    expect(parseMaxDurationFlag("99999999")).toBeNull();
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
        unfetchedPages: 0,
        pagesNotEvaluated: 0,
        siteChecksCut: false,
        probesSkipped: ["soft-404-confirmation"],
      })
    ).toBe(
      "Stopped at the 5 s time limit (--max-duration): soft-404-confirmation did not finish and was skipped"
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

describe("resource checks cut short (#1271)", () => {
  test("the reason names them", () => {
    expect(
      maxDurationReason({
        seconds: 4,
        unfetchedPages: 0,
        pagesNotEvaluated: 0,
        siteChecksCut: false,
        resourceChecksCut: true,
      })
    ).toBe(
      "Stopped at the 4 s time limit (--max-duration): resource checks were cut short"
    );
  });
  test("alone, they are a cut", () => {
    expect(
      wasCut({
        crawlStopped: false,
        unfetched: 0,
        pagesNotEvaluated: 0,
        rulesCut: false,
        probesSkipped: [],
        pagesTooLarge: 0,
        tooLargePages: [],
        resourceChecksCut: true,
      })
    ).toBe(true);
    expect(
      wasCut({
        crawlStopped: false,
        unfetched: 0,
        pagesNotEvaluated: 0,
        rulesCut: false,
        probesSkipped: [],
        pagesTooLarge: 0,
        tooLargePages: [],
      })
    ).toBe(false);
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

  test("resourceChecksCut survives a round trip", async () => {
    const cut = {
      seconds: 5,
      unfetchedPages: 0,
      pagesNotEvaluated: 0,
      siteChecksCut: false,
      resourceChecksCut: true,
    };
    const loaded = await reload(slim({ maxDuration: cut }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
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

describe("the page rules keep a window after the probes (#1327)", () => {
  test("at least 3 s on the smallest margin, still inside the hard stop", () => {
    const b = createDurationBudget(10, 0)!;
    expect(b.marginMs).toBe(15_000);
    expect(b.pageRulesStopAt - b.probesDoneAt).toBeGreaterThanOrEqual(3_000);
    expect(b.pageRulesStopAt).toBeLessThan(b.hardStopAt);
  });
  test("a large budget keeps the proportional window", () => {
    const b = createDurationBudget(1000, 0)!;
    expect(b.pageRulesStopAt).toBe(1_000_000 + Math.round(b.marginMs * 0.4));
  });
});

describe("raceUntil", () => {
  test("no deadline waits for the work", async () => {
    expect(await raceUntil(Promise.resolve(3), undefined)).toEqual({
      timedOut: false,
      value: 3,
    });
  });
  test("work that ends in time returns its value", async () => {
    expect(await raceUntil(Promise.resolve("ok"), Date.now() + 1000)).toEqual({
      timedOut: false,
      value: "ok",
    });
  });
  test("a hung call is abandoned at the deadline and its late failure is swallowed", async () => {
    const hung = new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("late")), 80)
    );
    const started = Date.now();
    expect(await raceUntil(hung, Date.now() + 20)).toEqual({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(70);
    await new Promise((r) => setTimeout(r, 120));
  });
});

describe("slimMaxDuration keeps probesSkipped from stored JSON (#1327)", () => {
  const base = {
    seconds: 30,
    unfetchedPages: 0,
    pagesNotEvaluated: 0,
    siteChecksCut: false,
  };
  test("probe ids pass through, anything else is dropped", () => {
    expect(
      slimMaxDuration({
        ...base,
        probesSkipped: [
          "soft-404-confirmation",
          "../../x y",
          5,
          "cloaking-probe",
        ],
      })?.probesSkipped
    ).toEqual(["soft-404-confirmation", "cloaking-probe"]);
  });
  test("absent or malformed means none", () => {
    expect(slimMaxDuration(base)?.probesSkipped).toBeUndefined();
    expect(
      slimMaxDuration({ ...base, probesSkipped: "cloaking-probe" })
        ?.probesSkipped
    ).toBeUndefined();
  });
});

describe("maxDurationReason for pages too large to parse (#1332)", () => {
  const base = {
    seconds: 20,
    unfetchedPages: 0,
    pagesNotEvaluated: 0,
    siteChecksCut: false,
  };
  test("alone it does not claim the time ran out", () => {
    const reason = maxDurationReason({ ...base, pagesTooLarge: 1 });
    expect(reason).toBe(
      "Run under the 20 s time limit (--max-duration): 1 page was too large to parse within the time limit and not evaluated"
    );
  });
  test("with a real cut it is one more part of the sentence", () => {
    const reason = maxDurationReason({
      ...base,
      unfetchedPages: 4,
      pagesTooLarge: 2,
    });
    expect(reason).toBe(
      "Stopped at the 20 s time limit (--max-duration): 4 discovered pages were not fetched, 2 pages were too large to parse within the time limit and not evaluated"
    );
  });
  test("wasCut counts them", () => {
    expect(
      wasCut({
        crawlStopped: false,
        unfetched: 0,
        pagesNotEvaluated: 0,
        pagesTooLarge: 1,
        tooLargePages: ["https://x.test/a"],
        rulesCut: false,
        probesSkipped: [],
      })
    ).toBe(true);
  });
  test("slimMaxDuration keeps the count and a bounded list", () => {
    const slim = slimMaxDuration({
      seconds: 20,
      unfetchedPages: 0,
      pagesNotEvaluated: 0,
      siteChecksCut: false,
      pagesTooLarge: 3,
      tooLargePages: ["https://x.test/a", 7, "https://x.test/b"],
    });
    expect(slim?.pagesTooLarge).toBe(3);
    expect(slim?.tooLargePages).toEqual([
      "https://x.test/a",
      "https://x.test/b",
    ]);
  });
});
