// PER-BATCH FLATNESS (#1021, PR-E §1). The streaming page pass keeps DOM residency
// bounded to one batch, so its per-batch wall-time is roughly CONSTANT across the
// crawl. v1's resident loop degrades superlinearly at scale (observed 6-10s →
// 100+s per 100 pages at 5k, driven by GC + paging of the ever-growing resident
// set). This test asserts streamPageRules' per-batch time does not trend upward —
// an algorithmic guard against a future O(n²) regression in the batch loop.
//
// (The dramatic v1↔v2 wall-time gap only materializes once the resident set spills
// to paging, which an in-memory unit test can't provoke; a larger real-scale run
// is kept skip-tagged below.)

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import { createRunner, type SiteData } from "@squirrelscan/rules";

import { streamPageRules } from "../src/streaming";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CONFIG = { rule_options: {}, rules: { enable: ["*"] } };

// Page rules read only non-`pages` site fields; a minimal SiteData suffices.
function siteData(): SiteData {
  return { baseUrl: "http://synthetic.test", pages: [], robotsTxt: null, sitemaps: null };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function collectBatchTimings(pageCount: number, batchSize: number): Promise<number[]> {
  const model = generateSiteModel({ seed: 21, pageCount });
  const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");
  const batchMs: number[] = [];
  await run(
    streamPageRules(storage, crawlId, createRunner(CONFIG), siteData(), {
      batchSize,
      hooks: { onBatch: (info) => batchMs.push(info.batchMs) },
    }),
  );
  await run(storage.close());
  return batchMs;
}

// Assert the last third of batches isn't meaningfully slower than the first third
// (batch 0 dropped — it pays one-time JIT warmup). Generous factor + absolute floor
// absorb timing noise; a superlinear loop would blow the last third far past this.
function assertFlat(batchMs: number[], minBatches: number) {
  expect(batchMs.length).toBeGreaterThanOrEqual(minBatches);
  const firstThird = batchMs.slice(1, Math.max(2, Math.ceil(batchMs.length / 3)));
  const lastThird = batchMs.slice(Math.floor((batchMs.length * 2) / 3));
  const firstMed = median(firstThird);
  const lastMed = median(lastThird);
  expect(lastMed).toBeLessThanOrEqual(firstMed * 4 + 40);
}

describe("streaming page pass — per-batch wall-time flatness", () => {
  test(
    "per-batch time stays flat across a 160-page crawl",
    async () => {
      const batchMs = await collectBatchTimings(160, 16);
      assertFlat(batchMs, 9);
    },
    30_000,
  );

  // Real-scale confirmation — slow (thousands of pages). Run manually:
  //   bun test -t "flat across a large crawl" (after removing .skip)
  test.skip("per-batch time stays flat across a large crawl (manual)", async () => {
    const batchMs = await collectBatchTimings(4000, 200);
    assertFlat(batchMs, 15);
  });
});
