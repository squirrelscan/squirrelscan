// Render spend lines surface the ACTUAL server debit per feature, so a render
// cache hit shows as its own render_cached (1cr) line — not lumped under render
// at the 2cr estimate. #279

import type { RenderChargeLine } from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";

import { foldRenderSpendLines } from "../../src/controllers/audit";

describe("foldRenderSpendLines", () => {
  test("no charges → no lines", () => {
    expect(foldRenderSpendLines([])).toEqual([]);
  });

  test("a render cache hit shows render_cached (1cr), matching the ledger", () => {
    const breakdown: RenderChargeLine[] = [
      { feature: "render_cached", units: 1, credits: 1 },
    ];
    expect(foldRenderSpendLines(breakdown)).toEqual([
      {
        service: "render_cached",
        feature: "render_cached",
        units: 1,
        credits: 1,
      },
    ]);
  });

  test("only misses → a single render line at the real debit", () => {
    const breakdown: RenderChargeLine[] = [
      { feature: "render", units: 2, credits: 4 },
    ];
    expect(foldRenderSpendLines(breakdown)).toEqual([
      { service: "render", feature: "render", units: 2, credits: 4 },
    ]);
  });

  test("mixed batches fold into separate render + render_cached lines, summed", () => {
    // Two batches: batch 1 = 2 misses + 1 hit, batch 2 = 1 miss + 2 hits.
    const breakdown: RenderChargeLine[] = [
      { feature: "render", units: 2, credits: 4 },
      { feature: "render_cached", units: 1, credits: 1 },
      { feature: "render", units: 1, credits: 2 },
      { feature: "render_cached", units: 2, credits: 2 },
    ];
    expect(foldRenderSpendLines(breakdown)).toEqual([
      { service: "render", feature: "render", units: 3, credits: 6 },
      {
        service: "render_cached",
        feature: "render_cached",
        units: 3,
        credits: 3,
      },
    ]);
  });
});
