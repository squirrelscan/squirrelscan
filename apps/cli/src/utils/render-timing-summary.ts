// #826: aggregate per-page queue-wait vs render-time samples collected during
// a rendered crawl into a debug-level summary, so a slow cloud crawl reads as
// "browser-pool queueing" or "render cost" instead of one opaque load_time_ms.

export interface RenderTimingSample {
  renderTimeMs: number;
  queueWaitMs: number;
}

export interface RenderTimingSummary {
  count: number;
  avgRenderMs: number;
  p50RenderMs: number;
  p95RenderMs: number;
  avgQueueWaitMs: number;
  p50QueueWaitMs: number;
  p95QueueWaitMs: number;
}

/** Nearest-rank percentile over a sorted ascending array (linear interpolation is overkill for a debug summary). */
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, idx)] ?? 0;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Returns null when there are no rendered-page samples (e.g. an all-HTTP crawl). */
export function summarizeRenderTimings(
  samples: RenderTimingSample[]
): RenderTimingSummary | null {
  if (samples.length === 0) return null;

  const renderTimes = samples.map((s) => s.renderTimeMs).sort((a, b) => a - b);
  const queueWaits = samples.map((s) => s.queueWaitMs).sort((a, b) => a - b);

  return {
    count: samples.length,
    avgRenderMs: Math.round(average(renderTimes)),
    p50RenderMs: percentile(renderTimes, 50),
    p95RenderMs: percentile(renderTimes, 95),
    avgQueueWaitMs: Math.round(average(queueWaits)),
    p50QueueWaitMs: percentile(queueWaits, 50),
    p95QueueWaitMs: percentile(queueWaits, 95),
  };
}
