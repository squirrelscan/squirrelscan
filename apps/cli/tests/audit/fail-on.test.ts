import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import {
  normalizeFailOnArgs,
  parseFailOn,
  evaluateFailOn,
  formatFailOnSummary,
} from "../../src/audit/fail-on";

function makeReport(opts: {
  overall?: number;
  categories?: { category: string; score: number }[];
  errorCount?: number;
  warningCount?: number;
  noHealthScore?: boolean;
  status?: AuditReport["status"];
}): AuditReport {
  const healthScore = opts.noHealthScore
    ? undefined
    : {
        overall: opts.overall ?? 100,
        categories: (opts.categories ?? []).map((c) => ({
          category: c.category,
          name: c.category,
          score: c.score,
          passed: 0,
          warnings: 0,
          failed: 0,
          total: 0,
        })),
        errorCount: opts.errorCount ?? 0,
        warningCount: opts.warningCount ?? 0,
        passedCount: 0,
      };
  return {
    healthScore,
    failed: opts.errorCount ?? 0,
    warnings: opts.warningCount ?? 0,
    ...(opts.status ? { status: opts.status } : {}),
  } as unknown as AuditReport;
}

describe("normalizeFailOnArgs", () => {
  test("handles undefined, comma-lists, repeats and whitespace", () => {
    expect(normalizeFailOnArgs(undefined)).toEqual([]);
    expect(normalizeFailOnArgs("score<90")).toEqual(["score<90"]);
    expect(normalizeFailOnArgs("score<90, severity>=error")).toEqual([
      "score<90",
      "severity>=error",
    ]);
    expect(normalizeFailOnArgs(["score<90", "errors>0,warnings>0"])).toEqual([
      "score<90",
      "errors>0",
      "warnings>0",
    ]);
    expect(normalizeFailOnArgs([" score<90 ", ""])).toEqual(["score<90"]);
  });
});

describe("parseFailOn", () => {
  test("parses numeric metrics + operators", () => {
    const { conditions, errors } = parseFailOn([
      "score<90",
      "score<=90",
      "score>50",
      "score>=50",
      "score=90",
      "score==90",
      "errors>0",
      "warnings>0",
    ]);
    expect(errors).toEqual([]);
    expect(conditions).toHaveLength(8);
    expect(conditions[0]).toMatchObject({
      metric: "score",
      op: "<",
      value: 90,
    });
    expect(conditions[1]!.op).toBe("<=");
    expect(conditions[4]).toMatchObject({ op: "=", value: 90 });
    expect(conditions[5]).toMatchObject({ op: "=", value: 90 }); // == tolerated
    expect(conditions[6]).toMatchObject({
      metric: "errors",
      op: ">",
      value: 0,
    });
    expect(conditions[7]!.metric).toBe("warnings");
  });

  test("parses category-score", () => {
    const { conditions, errors } = parseFailOn(["score:perf<80"]);
    expect(errors).toEqual([]);
    expect(conditions[0]).toMatchObject({
      metric: "category-score",
      category: "perf",
      op: "<",
      value: 80,
    });
  });

  test("parses severity with rank", () => {
    const { conditions, errors } = parseFailOn([
      "severity>=error",
      "severity>=warning",
      "severity=error",
    ]);
    expect(errors).toEqual([]);
    expect(conditions[0]).toMatchObject({
      metric: "severity",
      op: ">=",
      value: 3,
      severityName: "error",
    });
    expect(conditions[1]!.value).toBe(2);
  });

  test("rejects bad expressions with helpful messages", () => {
    const { conditions, errors } = parseFailOn([
      "score90", // no operator
      "foo<3", // unknown metric
      "score<abc", // not a number
      "score:bogus<80", // unknown category
      "severity<error", // unsupported op for severity
      "severity>=critical", // bad severity value
      "new-issues>0", // not supported yet
    ]);
    expect(conditions).toHaveLength(0);
    expect(errors).toHaveLength(7);
    expect(errors[0]).toContain("expected <metric>");
    expect(errors[1]).toContain("unknown metric");
    expect(errors[2]).toContain("not a number");
    expect(errors[3]).toContain("unknown category");
    expect(errors[4]).toContain("severity supports");
    expect(errors[5]).toContain("severity value must be");
    expect(errors[6]).toContain("not supported yet");
  });

  test("rejects empty values (Number('') === 0 would false-gate)", () => {
    const { conditions, errors } = parseFailOn([
      "score<",
      "errors>",
      "warnings=",
    ]);
    expect(conditions).toHaveLength(0);
    expect(errors).toHaveLength(3);
    for (const e of errors) expect(e).toContain("missing value");
  });

  test("rejects severity>error (can never trip — error is the top rank)", () => {
    const { conditions, errors } = parseFailOn(["severity>error"]);
    expect(conditions).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("can never trip");
  });

  test("rejects severity=info (info findings are not counted)", () => {
    const { conditions, errors } = parseFailOn([
      "severity>=info",
      "severity=info",
    ]);
    expect(conditions).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("error or warning");
  });
});

describe("evaluateFailOn", () => {
  test("score gate trips below threshold, passes at/above", () => {
    const { conditions } = parseFailOn(["score<90"]);
    expect(
      evaluateFailOn(conditions, makeReport({ overall: 82 })).trips
    ).toHaveLength(1);
    expect(
      evaluateFailOn(conditions, makeReport({ overall: 95 })).trips
    ).toHaveLength(0);
    expect(
      evaluateFailOn(conditions, makeReport({ overall: 90 })).trips
    ).toHaveLength(0);
  });

  test("score gate supports > (trips above threshold)", () => {
    const { conditions } = parseFailOn(["score>50"]);
    expect(
      evaluateFailOn(conditions, makeReport({ overall: 80 })).trips
    ).toHaveLength(1);
    expect(
      evaluateFailOn(conditions, makeReport({ overall: 40 })).trips
    ).toHaveLength(0);
  });

  test("category-score gate uses the named category, notes when absent", () => {
    const { conditions } = parseFailOn(["score:perf<80"]);
    const tripped = evaluateFailOn(
      conditions,
      makeReport({ categories: [{ category: "perf", score: 70 }] })
    );
    expect(tripped.trips).toHaveLength(1);

    const passed = evaluateFailOn(
      conditions,
      makeReport({ categories: [{ category: "perf", score: 85 }] })
    );
    expect(passed.trips).toHaveLength(0);

    const absent = evaluateFailOn(conditions, makeReport({ categories: [] }));
    expect(absent.trips).toHaveLength(0);
    expect(absent.notes).toHaveLength(1);
    expect(absent.notes[0]).toContain("not present");
  });

  test("severity gate respects rank", () => {
    const err = parseFailOn(["severity>=error"]).conditions;
    expect(
      evaluateFailOn(err, makeReport({ errorCount: 2 })).trips
    ).toHaveLength(1);
    expect(
      evaluateFailOn(err, makeReport({ errorCount: 0, warningCount: 5 })).trips
    ).toHaveLength(0);

    const warn = parseFailOn(["severity>=warning"]).conditions;
    expect(
      evaluateFailOn(warn, makeReport({ warningCount: 3 })).trips
    ).toHaveLength(1);
    expect(
      evaluateFailOn(warn, makeReport({ errorCount: 0, warningCount: 0 })).trips
    ).toHaveLength(0);

    // strict `>warning` = errors only (not warnings)
    const gtWarn = parseFailOn(["severity>warning"]).conditions;
    expect(
      evaluateFailOn(gtWarn, makeReport({ errorCount: 1 })).trips
    ).toHaveLength(1);
    expect(
      evaluateFailOn(gtWarn, makeReport({ errorCount: 0, warningCount: 9 }))
        .trips
    ).toHaveLength(0);

    // exact `=warning` = warnings only (independent of errors)
    const eqWarn = parseFailOn(["severity=warning"]).conditions;
    expect(
      evaluateFailOn(eqWarn, makeReport({ warningCount: 2 })).trips
    ).toHaveLength(1);
    expect(
      evaluateFailOn(eqWarn, makeReport({ errorCount: 4, warningCount: 0 }))
        .trips
    ).toHaveLength(0);
  });

  test("notes (but still allows) a score threshold outside 0–100", () => {
    const { conditions } = parseFailOn(["score<110"]);
    const ev = evaluateFailOn(conditions, makeReport({ overall: 95 }));
    expect(ev.trips).toHaveLength(1); // score<110 always trips
    expect(
      ev.notes.some((n) => n.includes("outside the 0–100 score range"))
    ).toBe(true);
  });

  test("errors/warnings count gates", () => {
    const { conditions } = parseFailOn(["errors>0", "warnings>0"]);
    const ev = evaluateFailOn(
      conditions,
      makeReport({ errorCount: 1, warningCount: 0 })
    );
    expect(ev.trips).toHaveLength(1);
    expect(ev.trips[0]!.condition.metric).toBe("errors");
  });

  test("errors/warnings fall back to report.failed/warnings when healthScore absent", () => {
    const { conditions } = parseFailOn(["errors>0", "warnings>0"]);
    const ev = evaluateFailOn(
      conditions,
      makeReport({ noHealthScore: true, errorCount: 2, warningCount: 1 })
    );
    expect(ev.trips).toHaveLength(2);
  });

  test("score gate notes (does not trip) when no health score", () => {
    const { conditions } = parseFailOn(["score<90"]);
    const ev = evaluateFailOn(conditions, makeReport({ noHealthScore: true }));
    expect(ev.trips).toHaveLength(0);
    expect(ev.notes).toHaveLength(1);
  });

  test("failed/blocked audit skips all conditions, never trips the score gate (#489)", () => {
    // overall:0 on a failed audit must NOT trip `score<50` (that's exit-2 score
    // gate); the failed audit itself is the signal.
    const { conditions } = parseFailOn(["score<50", "errors>0"]);
    for (const status of ["failed", "blocked"] as const) {
      const ev = evaluateFailOn(conditions, makeReport({ overall: 0, status }));
      expect(ev.trips).toHaveLength(0);
      expect(ev.notes.some((n) => n.includes(status))).toBe(true);
    }
  });
});

describe("formatFailOnSummary", () => {
  test("pass summary", () => {
    const { conditions } = parseFailOn(["score<90"]);
    const lines = formatFailOnSummary(
      evaluateFailOn(conditions, makeReport({ overall: 95 }))
    );
    expect(lines.some((l) => l.includes("all 1 threshold passed"))).toBe(true);
  });

  test("trip summary lists the tripped expressions", () => {
    const { conditions } = parseFailOn(["score<90", "errors>0"]);
    const lines = formatFailOnSummary(
      evaluateFailOn(conditions, makeReport({ overall: 50, errorCount: 3 }))
    );
    expect(lines[0]).toContain("2 of 2 thresholds tripped");
    expect(lines.some((l) => l.includes("score<90"))).toBe(true);
    expect(lines.some((l) => l.includes("errors>0"))).toBe(true);
  });
});
