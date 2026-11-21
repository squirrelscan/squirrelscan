// Wall time saved by starting the rules while the cloud prefetch is still
// running (pub#2121), on the canonical 518-page golden fixture with every cloud
// rule on.
//
//   bun run scripts/bench-late-cloud-results.ts [--runs N] [--render-ms MS] [--page-ms MS]
//
// LATENCY MODEL (mocked, no network): the cloud is the deterministic stub from
// tests/helpers/late-cloud-fixture.ts with a fixed delay per call:
//   - Stage 0 site-metadata: 1500 ms, once.
//   - each site-unit service (blocklist-check, archive-indexing): 500 ms, once.
//   - ai-parse and authority-signals: --page-ms (default 500 ms) per batch.
//   - render: --render-ms (default 2000 ms) per batch, paid on submit.
// Page batches are `batch_size` 10 (render's server cap) with the default 4 in
// flight per service, exactly as the prefetch dispatches them.
//
// ARMS, same process, alternating, each from a fresh storage connection:
//   serial: await the whole prefetch, then runStreamingRules with its store in
//           scope (today's container path).
//   late:   start the prefetch, then runStreamingRules with LateCloudResults.
// Both are timed from "prefetch started" to "rules returned". The report JSON
// of both arms is compared, so a number here is never bought with a different answer.

import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import type { CloudServiceId } from "@squirrelscan/core-contracts";
import type { PreFetchedAssets } from "../src/adapter";

import { generateReportFromStorage, runStreamingRules } from "../src/adapter";
import { CloudPrefetchAccumulator, prefetchCloudData } from "../src/cloud-prefetch";
import { LateCloudResults } from "../src/late-cloud-results";
import { canonicalFixtureDb, getGoldenBaselineConfig } from "../tests/helpers/golden-baseline";
import {
  lateCloudConfig,
  payloadsFor,
  prefetchInputFor,
  stubCloudClient,
} from "../tests/helpers/late-cloud-fixture";

const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e);

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const RUNS = arg("runs", 1);
const RENDER_MS = arg("render-ms", 2000);
const PAGE_MS = arg("page-ms", 500);
const SITE = "http://synthetic.example.com";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function latency(service: CloudServiceId): Promise<void> {
  switch (service) {
    case "site-metadata":
      return sleep(1500);
    case "render":
      return sleep(RENDER_MS);
    case "ai-parse":
    case "authority-signals":
      return sleep(PAGE_MS);
    default:
      return sleep(500);
  }
}

function emptyAssets(): PreFetchedAssets {
  return { resourceSizes: { css: [], images: [] }, scripts: [], pdfSizes: [], sitemapUrlStatuses: [] };
}

async function arm(mode: "serial" | "late"): Promise<{ ms: number; report: string; earlyPages: number }> {
  const storage = new SQLiteStorage(await canonicalFixtureDb());
  try {
    await run(storage.init());
    const crawlId = (await run(storage.listCrawls(1)))[0]!.id;
    const config = lateCloudConfig(getGoldenBaselineConfig());
    const payloads = payloadsFor(await run(storage.getPages(crawlId)));
    const input = prefetchInputFor(stubCloudClient(latency), config, payloads, SITE, 10);
    const t0 = performance.now();
    let results;
    let earlyPages = 0;
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
    const ms = performance.now() - t0;
    const report = JSON.parse(JSON.stringify(await run(generateReportFromStorage(storage, crawlId, results))));
    delete report.timestamp;
    if (report.meta) delete report.meta.timestamp;
    return { ms, report: JSON.stringify(report), earlyPages };
  } finally {
    await run(storage.close());
  }
}

const pages = payloadsFor(
  await (async () => {
    const s = new SQLiteStorage(await canonicalFixtureDb());
    await run(s.init());
    const crawlId = (await run(s.listCrawls(1)))[0]!.id;
    const all = await run(s.getPages(crawlId));
    await run(s.close());
    return all;
  })(),
).length;
console.log(
  `fixture: canonical golden, ${pages} cloud page payloads; render ${RENDER_MS} ms/batch, ` +
    `ai-parse + authority-signals ${PAGE_MS} ms/batch, Stage 0 1500 ms, site services 500 ms; batch 10, 4 in flight`,
);
const rows: string[] = [];
for (let i = 0; i < RUNS; i++) {
  const serial = await arm("serial");
  const late = await arm("late");
  const same = serial.report === late.report;
  const saved = serial.ms - late.ms;
  rows.push(
    `run ${i + 1}: serial ${(serial.ms / 1000).toFixed(1)} s, late ${(late.ms / 1000).toFixed(1)} s, ` +
      `saved ${(saved / 1000).toFixed(1)} s (${((saved / serial.ms) * 100).toFixed(0)}%), ` +
      `early pages ${late.earlyPages}, report identical: ${same}`,
  );
  console.log(rows[rows.length - 1]);
  if (!same) process.exitCode = 1;
}
