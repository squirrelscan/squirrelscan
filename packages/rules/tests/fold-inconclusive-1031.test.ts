// #1031: the `details.inconclusive` marker of an `info` check survives folding, so resolution still
// reads a folded aggregate as "could not judge" and not as evidence the pages are clean.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { DEFAULT_FOLD_LIMITS, foldOverflowChecks, slimPageChecksForShell } from "../src/fold";
import { buildResolutionSignal } from "../src/resolution";

const RULE = "schema/expected-type";
const meta = { id: RULE, name: "Expected type", description: "d", category: "schema", scope: "page" as const, severity: "warning" as const, weight: 3 };
const url = (i: number) => `https://example.com/p${i}`;
const row = (i: number, extra: Partial<CheckResult> = {}): CheckResult => ({ name: "expected-type", status: "info", message: "Page type not classified", pageUrl: url(i), ...extra });
const inconclusive = (i: number) => row(i, { details: { inconclusive: true } });

const evaluatedFor = (checks: CheckResult[], pages: string[]) => {
  const signal = buildResolutionSignal({ [RULE]: { meta, checks } } as never, pages)!;
  return signal;
};

describe("the inconclusive marker through the fold (#1031)", () => {
  test("600 inconclusive rows fold into one aggregate that keeps the marker, and the signal evaluates no page", () => {
    const rows = Array.from({ length: 600 }, (_, i) => inconclusive(i));
    const folded = foldOverflowChecks(rows, DEFAULT_FOLD_LIMITS);
    expect(folded.length).toBeLessThan(600);
    const aggregate = folded.find((c) => c.details?.aggregated === true)!;
    expect(aggregate.details?.inconclusive).toBe(true);
    // Raw rows and the folded aggregate say the same thing to resolution: nothing evaluated.
    const pages = rows.map((r) => r.pageUrl!);
    const raw = evaluatedFor(rows, pages);
    const viaFold = evaluatedFor(folded, pages);
    expect(Object.keys(viaFold.failing ?? {})).toEqual(Object.keys(raw.failing ?? {}));
    expect(JSON.stringify(viaFold.evaluated ?? null)).toBe(JSON.stringify(raw.evaluated ?? null));
    expect(Object.keys(viaFold.evaluated ?? {})).not.toContain(`${RULE}|expected-type`);
  });

  test("inconclusive and plain info of the same name fold apart, not into one smeared aggregate", () => {
    const rows = [...Array.from({ length: 300 }, (_, i) => inconclusive(i)), ...Array.from({ length: 300 }, (_, i) => row(300 + i))];
    const folded = foldOverflowChecks(rows, DEFAULT_FOLD_LIMITS).filter((c) => c.details?.aggregated === true);
    expect(folded.map((c) => c.details?.inconclusive === true).sort()).toEqual([false, true]);
  });

  test("the chunked-publish shell slim keeps the marker, even for three rows, and keeps plain info separate", () => {
    const slim = slimPageChecksForShell([inconclusive(1), inconclusive(2), inconclusive(3), row(4), row(5)]);
    const marked = slim.filter((c) => c.details?.inconclusive === true);
    const plain = slim.filter((c) => c.details?.inconclusive !== true);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.pages ?? []).toHaveLength(3);
    expect(plain).toHaveLength(1);
    expect(plain[0]!.pages ?? []).toHaveLength(2);
  });
});
