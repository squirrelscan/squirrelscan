// pub#2121 AC4: starting the rules while the cloud prefetch is still running
// changes no finding, score or report output. The canonical 518-page golden
// fixture runs twice with every cloud rule on, against the same deterministic
// stub cloud: once serially (prefetch awaited, its store in `scope`, today's
// path) and once with late-bound cloud results. Render latency is injected per
// batch, batch 0 slowest, so batches return out of order and pages start while
// later batches are still out. Both the golden snapshot and the whole report
// JSON (timestamps removed) must match to the byte.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import type { CloudServiceId } from "@squirrelscan/core-contracts";
import type { PreFetchedAssets } from "@squirrelscan/audit-engine";

import { generateReportFromStorage, runStreamingRules } from "../src/adapter";
import { CloudPrefetchAccumulator, prefetchCloudData } from "../src/cloud-prefetch";
import { LateCloudResults } from "../src/late-cloud-results";
import {
  buildSnapshot,
  canonicalFixtureDb,
  getGoldenBaselineConfig,
  serializeBaseline,
} from "./helpers/golden-baseline";
import { lateCloudConfig, payloadsFor, prefetchInputFor, stubCloudClient } from "./helpers/late-cloud-fixture";

const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e);

function emptyAssets(): PreFetchedAssets {
  return { resourceSizes: { css: [], images: [] }, scripts: [], pdfSizes: [], sitemapUrlStatuses: [] };
}

/** Render batch 0 takes 150 ms, every later one 10 ms; other services answer at once. */
function latency(service: CloudServiceId, call: number): Promise<void> | undefined {
  if (service !== "render") return undefined;
  return new Promise((r) => setTimeout(r, call === 0 ? 150 : 10));
}

async function capture(mode: "serial" | "late") {
  const dbPath = await canonicalFixtureDb();
  const storage = new SQLiteStorage(dbPath);
  try {
    await run(storage.init());
    const crawlId = (await run(storage.listCrawls(1)))[0]!.id;
    const pages = await run(storage.getPages(crawlId));
    const config = lateCloudConfig(getGoldenBaselineConfig());
    const input = prefetchInputFor(stubCloudClient(latency), config, payloadsFor(pages), "http://synthetic.example.com", 10);
    let earlyPages = 0;
    let results;
    if (mode === "serial") {
      const prefetch = await prefetchCloudData(input);
      results = await run(
        runStreamingRules(storage, crawlId, config, emptyAssets(), {
          cloudResults: prefetch.store,
          siteMetadata: prefetch.siteMetadata ?? undefined,
        }),
      );
    } else {
      const acc = new CloudPrefetchAccumulator();
      const late = new LateCloudResults(acc, prefetchCloudData({ ...input, accumulator: acc }));
      results = await run(
        runStreamingRules(storage, crawlId, config, emptyAssets(), undefined, { lateCloudResults: late }),
      );
      earlyPages = late.earlyPages;
    }
    const report = await run(generateReportFromStorage(storage, crawlId, results));
    const stripped = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    delete stripped.timestamp;
    const meta = stripped.meta as Record<string, unknown> | undefined;
    if (meta) delete meta.timestamp;
    return {
      snapshot: serializeBaseline(buildSnapshot(pages.length, results, report)),
      report: JSON.stringify(stripped),
      earlyPages,
    };
  } finally {
    await run(storage.close());
  }
}

describe("late cloud results: canonical golden parity (pub#2121 AC4)", () => {
  test(
    "the late run's snapshot and report are byte-identical to the serial run's",
    async () => {
      const serial = await capture("serial");
      const late = await capture("late");
      // The overlap really happened: pages started while render batches were still out.
      expect(late.earlyPages).toBeGreaterThan(0);
      // Not vacuous: the cloud rules read real results on the canonical crawl.
      expect(serial.report).toContain("Authority signals:");
      expect(serial.report).toContain("console.error message(s) from first-party code");
      expect(late.snapshot).toBe(serial.snapshot);
      expect(late.report).toBe(serial.report);
    },
    300_000,
  );
});
