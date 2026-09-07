// Per-batch collector nudge for the streaming pipeline (#1860).
//
// Dropping a batch's DOMs makes them garbage; it does not make them GONE. JSC
// grows the heap in preference to collecting, so a streamed walk that parses
// and releases 50 pages at a time still climbs: the pages are unreachable, but
// the collector has not run, and a container with a hard memory ceiling is
// killed on garbage exactly as readily as on live data.
//
// Measured on a 200-page crawl of ~1 MB, ~19k-node pages, batch of 50, peak RSS
// sampled inside the loop (a setInterval sampler never fires — the walk is sync
// CPU and does not yield):
//
//   no nudge          1424 MB
//   Bun.gc(false)     1481 MB   (opportunistic: no help at all)
//   Bun.gc(true)      1148 MB   (synchronous: the bound actually holds)
//
// 1148 MB is ~= one batch's live working set, which is the residency bound the
// streaming design promises. Without the synchronous collect the walk drifts
// above it by however much the collector happens to be behind — which is not a
// property anything in the pipeline controls.
//
// So: a SYNCHRONOUS collect, once per batch, not the opportunistic one. The cost
// is a full GC every `batchSize` pages (tens of milliseconds on a heap this
// size, a few dozen times across an audit that runs for minutes) in exchange for
// the peak being a function of batch size rather than of collector timing.

/** Bun's GC hook, when running under Bun. Undefined elsewhere (Workers, node). */
type GcHost = { Bun?: { gc?: (synchronous: boolean) => void } };

/**
 * Collect the batch just dropped. Best-effort and never throws: on a runtime
 * without `Bun.gc` this is a no-op and the pipeline still behaves correctly,
 * just with the collector's own timing deciding the peak.
 */
export function collectDroppedBatch(): void {
  const gc = (globalThis as GcHost).Bun?.gc;
  if (!gc) return;
  try {
    gc(true);
  } catch {
    // A runtime that exposes the hook but refuses the call — nothing to do.
  }
}
