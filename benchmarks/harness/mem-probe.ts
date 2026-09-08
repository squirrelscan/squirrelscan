/**
 * Harness-side memory probe, injected with `bun --preload`. NOT product code.
 *
 * Samples process.memoryUsage() (rss / heapUsed / external / arrayBuffers) on a
 * fixed cadence into $BENCH_MEM_LOG as JSONL, plus a final sample at exit.
 * The interval is unref'd so it never keeps the CLI alive.
 *
 * Env:
 *   BENCH_MEM_LOG   path to write JSONL samples (required, else probe is inert)
 *   BENCH_MEM_MS    sample period, default 500ms
 */

const out = process.env.BENCH_MEM_LOG;

if (out) {
  const periodMs = Number(process.env.BENCH_MEM_MS ?? 500);
  const t0 = Date.now();
  const samples: string[] = [];
  let peakRss = 0;

  const sample = (tag: string) => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    samples.push(
      JSON.stringify({
        t: Date.now() - t0,
        tag,
        rss: m.rss,
        heapUsed: m.heapUsed,
        heapTotal: m.heapTotal,
        external: m.external,
        arrayBuffers: m.arrayBuffers,
      }),
    );
  };

  const timer = setInterval(() => sample("tick"), periodMs);
  // never hold the process open on the probe's account
  (timer as unknown as { unref?: () => void }).unref?.();

  const flush = () => {
    // Collect BEFORE the exit sample, or this is the heap at whatever moment the
    // process happened to stop, not what the run retained. Without it two runs of
    // the same 5,000-page workload reported 2,461 MB and 1,275 MB, and the number
    // reads as a per-page retention slope it cannot support.
    //
    // This does cost wall time on a multi-GB heap, and `/usr/bin/time` measures
    // until the process exits, so a stage's wall time now includes one forced
    // collection. Rows recorded before this landed do not.
    try {
      (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun?.gc?.(true);
    } catch {
      /* not Bun, or gc unavailable: still take the sample */
    }
    sample("exit");
    samples.push(JSON.stringify({ t: Date.now() - t0, tag: "peakRssInProc", rss: peakRss }));
    try {
      require("node:fs").writeFileSync(out, samples.join("\n") + "\n");
    } catch {
      /* best effort: never break the run being measured */
    }
  };

  process.on("exit", flush);
  sample("start");
}
