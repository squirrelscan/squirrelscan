import { describe, it, expect } from "bun:test";

import { summarizeRenderTimings } from "@/utils/render-timing-summary";

describe("summarizeRenderTimings", () => {
  it("returns null for an empty sample set (e.g. an all-HTTP crawl)", () => {
    expect(summarizeRenderTimings([])).toBeNull();
  });

  it("computes avg/p50/p95 for both render and queue-wait series", () => {
    const samples = [
      { renderTimeMs: 100, queueWaitMs: 900 },
      { renderTimeMs: 200, queueWaitMs: 1800 },
      { renderTimeMs: 300, queueWaitMs: 2700 },
      { renderTimeMs: 400, queueWaitMs: 3600 },
    ];
    const summary = summarizeRenderTimings(samples);
    expect(summary).not.toBeNull();
    expect(summary?.count).toBe(4);
    expect(summary?.avgRenderMs).toBe(250);
    expect(summary?.avgQueueWaitMs).toBe(2250);
    // Nearest-rank p50 over 4 sorted samples lands on the 2nd value.
    expect(summary?.p50RenderMs).toBe(200);
    expect(summary?.p50QueueWaitMs).toBe(1800);
    // p95 over 4 samples lands on the last (largest) value.
    expect(summary?.p95RenderMs).toBe(400);
    expect(summary?.p95QueueWaitMs).toBe(3600);
  });

  it("handles a single sample without dividing by zero or indexing out of bounds", () => {
    const summary = summarizeRenderTimings([
      { renderTimeMs: 150, queueWaitMs: 50 },
    ]);
    expect(summary).toEqual({
      count: 1,
      avgRenderMs: 150,
      p50RenderMs: 150,
      p95RenderMs: 150,
      avgQueueWaitMs: 50,
      p50QueueWaitMs: 50,
      p95QueueWaitMs: 50,
    });
  });

  it("is order-independent (sorts internally)", () => {
    const ascending = summarizeRenderTimings([
      { renderTimeMs: 100, queueWaitMs: 100 },
      { renderTimeMs: 200, queueWaitMs: 200 },
      { renderTimeMs: 300, queueWaitMs: 300 },
    ]);
    const shuffled = summarizeRenderTimings([
      { renderTimeMs: 300, queueWaitMs: 300 },
      { renderTimeMs: 100, queueWaitMs: 100 },
      { renderTimeMs: 200, queueWaitMs: 200 },
    ]);
    expect(shuffled).toEqual(ascending);
  });
});
