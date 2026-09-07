// Peak-RSS bench for the resident vs streaming audit pipelines (#1860).
//
// Reproduces the shape that OOM-killed the drscholls.com audits (#1862): a
// 500-page crawl whose pages are ~1 MB of mostly inline script. The golden
// fixture's own pages are 20-60 KB of text, which parses to a DOM small enough
// that the resident pipeline looks fine — the wall only appears once each page
// carries hundreds of KB of script for linkedom to build nodes for. So the
// fixture is built from the golden model and then INFLATED: a deterministic
// filler script is appended to each page's stored html.
//
// Two modes, run as separate processes so neither heap can flatter the other:
//
//   old — getPages -> buildSiteContext -> fetchResourceAssets -> runRulesOnStorage
//         -> report with an effectively unbounded page batch. This is the pipeline
//         as it stood before #1860.
//   new — runStreamingPreRules -> runStreamingRules -> batched report.
//
// Network: the synthetic pages carry no sub-resources, and `--max-resources 0`
// zeroes the sitemap-status and PDF fetch limits, so both modes are fully offline
// and the only difference measured is residency.
//
// Usage (build once, then measure each mode under /usr/bin/time -l):
//   bun run scripts/bench-streaming-memory.ts build --db /tmp/bench.sqlite --pages 500 --inflate-kb 950
//   /usr/bin/time -l bun run scripts/bench-streaming-memory.ts old --db /tmp/bench.sqlite
//   /usr/bin/time -l bun run scripts/bench-streaming-memory.ts new --db /tmp/bench.sqlite
//
// The script also samples `process.memoryUsage().rss` on a timer and prints its
// own peak, because /usr/bin/time -l reports the process maximum resident set
// size and the in-process sample is the number the container's own heartbeat
// would have reported. Both are printed; they should agree closely.

import { rmSync } from "node:fs";

import { getDefaultConfig, type Config } from "@squirrelscan/config";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import { Effect } from "effect";

import {
  buildSiteContext,
  fetchResourceAssets,
  generateReportFromStorage,
  parseHtmlForRules,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const MODE = process.argv[2] ?? "new";
const DB = arg("db", "/tmp/squirrel-bench.sqlite")!;
const PAGES = Number.parseInt(arg("pages", "500")!, 10);
const INFLATE_KB = Number.parseInt(arg("inflate-kb", "950")!, 10);
const BATCH = Number.parseInt(arg("batch", "50")!, 10);
const SCRIPT_SHARE = Number.parseFloat(arg("script-share", "0.8")!);
// One getPages for the whole crawl — the pre-#1860 report behaviour.
const UNBOUNDED_BATCH = 1_000_000;

const MB = 1024 * 1024;
const fmt = (bytes: number) => `${(bytes / MB).toFixed(0)} MB`;

/** Offline config: no cloud, no intel, no integrity probes (no network). */
function benchConfig(): Config {
  const base = getDefaultConfig();
  return {
    ...base,
    cloud: { ...base.cloud, enabled: false },
    intel: { ...base.intel, enabled: false },
    external_links: { ...base.external_links, enabled: false },
    integrity: {
      ...base.integrity,
      soft404_confirm: { ...(base.integrity?.soft404_confirm ?? {}), enabled: false },
    },
  } as Config;
}

const RESOURCE_OVERRIDES = { resourceCheckMaxItems: 0 };

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

/**
 * Deterministic page filler shaped like a real script-heavy commerce page.
 *
 * This matters more than it looks. A first attempt filled the page with ONE
 * `<script>` holding ~950 KB of text: the stored html hit 1 MB, but linkedom
 * built a single text node for it and the parsed document cost only ~0.44 MB per
 * page — a twelfth of the ~4.7 MB per page measured on drscholls.com (#1862). The
 * bench then "showed" the resident pipeline using less memory than the streaming
 * one, because the term the streaming pipeline exists to remove had been filled
 * with something that does not cost anything to parse.
 *
 * linkedom's cost is dominated by NODE COUNT, not by html byte length. So the
 * filler is half inline script split across many tags and half real markup:
 * nested divs, spans, attributes and text, the way a product grid is. The bench
 * prints the achieved per-page DOM cost so this can be checked rather than
 * assumed.
 */
function fillerMarkup(kb: number, seed: string, scriptShare = SCRIPT_SHARE): string {
  const targetBytes = kb * 1024;
  const parts: string[] = [];
  let size = 0;

  // Most of the budget as inline script, split across many small tags (analytics,
  // config blobs, per-product JSON) rather than one monolith. `scriptShare` is
  // the dial that sets the achieved DOM cost per page: script text is cheap per
  // byte, markup is not, so lowering it makes the fixture harsher. The default is
  // tuned so the fixture lands near the ~4.7 MB/page measured on drscholls.com
  // (#1862) rather than well past it — a fixture that is 3x harsher than
  // production would overstate the fix.
  let i = 0;
  while (size < targetBytes * scriptShare) {
    const tag = `<script>window.__q${seed}_${i}={a:${i},b:"t${i}"};</script>`;
    parts.push(tag);
    size += tag.length;
    i++;
  }

  // The rest as element-dense markup — this is what actually builds nodes.
  let card = 0;
  while (size < targetBytes) {
    const block =
      `<div class="c${card % 7}" data-id="${card}">` +
      `<span class="t">P${card}</span>` +
      `<span class="p">$${card % 90}</span>` +
      `<ul><li>s${card % 5}</li><li>c${card % 9}</li></ul>` +
      `</div>`;
    parts.push(block);
    size += block.length;
    card++;
  }

  return parts.join("");
}

async function build(): Promise<void> {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });

  const model = generateSiteModel({
    seed: "bench-streaming-memory-1860",
    pageCount: PAGES,
    templateCount: 6,
    minPageSizeBytes: 20_000,
    maxPageSizeBytes: 60_000,
    cleanRatio: 0.35,
  });
  const { storage, crawlId } = await writeCrawlToStorage(model, DB);

  // Inflate in batches so the builder itself never holds the whole crawl.
  let inflated = 0;
  for (let offset = 0; ; offset += 100) {
    const batch = await run(storage.getPages(crawlId, { limit: 100, offset }));
    if (batch.length === 0) break;
    for (const page of batch) {
      if (!page.html) continue;
      const filler = fillerMarkup(INFLATE_KB, page.normalizedUrl.slice(-8).replace(/\W/g, ""));
      const html = page.html.replace("</body>", `${filler}</body>`);
      await run(storage.upsertPage(crawlId, { ...page, html }));
      inflated++;
    }
    if (batch.length < 100) break;
  }
  // Report the ACHIEVED per-page DOM cost. The whole bench is meaningless if this
  // is far off the ~4.7 MB/page measured on drscholls.com (#1862) — that is how
  // the first filler shape slipped through looking plausible (one giant script
  // text node: 1 MB of html, 0.44 MB of DOM).
  // Report the fixture's shape so a future reader can tell whether it still
  // resembles the pages that caused #1862. NODE COUNT is the number that matters:
  // linkedom's cost tracks nodes, not html bytes, and the first version of this
  // filler put ~950 KB into a single script text node — 1 MB of html that parsed
  // to almost no DOM, which made the resident pipeline look cheaper than the
  // streaming one. Per-page retained MB is deliberately NOT reported: measuring it
  // from RSS deltas gave readings between 0.7 and 13 MB for the same fixture, so
  // the honest memory number is the end-to-end peak each mode prints, not a
  // synthetic per-page figure.
  const probe = await run(storage.getPages(crawlId, { limit: 5, offset: 0 }));
  const htmlAvg = probe.reduce((n, pg) => n + (pg.html?.length ?? 0), 0) / Math.max(1, probe.length);
  const first = probe[0];
  const nodes = first?.html
    ? (parseHtmlForRules(first.html, first.normalizedUrl).document?.querySelectorAll("*").length ?? 0)
    : 0;
  console.log(
    `built ${DB}: crawl=${crawlId} pages inflated=${inflated}\n` +
      `  avg html=${(htmlAvg / 1024).toFixed(0)} KB  nodes/page=${nodes}`,
  );
  await run(storage.close());
}

async function openCrawl(): Promise<{ storage: SQLiteStorage; crawlId: string }> {
  const storage = new SQLiteStorage(DB);
  await run(storage.init());
  const crawls = await run(storage.listCrawls(1));
  const crawlId = crawls[0]?.id;
  if (!crawlId) throw new Error(`no crawl in ${DB} — run \`build\` first`);
  return { storage, crawlId };
}

async function main(): Promise<void> {
  if (MODE === "build") {
    await build();
    return;
  }

  let peak = 0;
  const sample = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  };
  const timer = setInterval(sample, 100);
  const mark = (label: string) => {
    sample();
    console.log(`  ${label.padEnd(22)} rss=${fmt(process.memoryUsage().rss)} peak=${fmt(peak)}`);
  };

  const { storage, crawlId } = await openCrawl();
  const config = benchConfig();
  const started = Date.now();
  console.log(`mode=${MODE} db=${DB} batch=${MODE === "new" ? BATCH : "unbounded"}`);

  if (MODE === "old") {
    const pages = await run(storage.getPages(crawlId));
    mark(`getPages(${pages.length})`);
    const siteContext = await run(buildSiteContext(pages));
    mark("buildSiteContext");
    const assets = await run(
      fetchResourceAssets(storage, crawlId, siteContext, config, RESOURCE_OVERRIDES),
    );
    mark("fetchResourceAssets");
    const rules = await run(
      runRulesOnStorage(storage, crawlId, siteContext, config, assets, undefined),
    );
    mark("runRulesOnStorage");
    const report = await run(
      generateReportFromStorage(storage, crawlId, rules, { batchSize: UNBOUNDED_BATCH }),
    );
    mark("report");
    console.log(`  report pages=${report.pages.length} score=${report.healthScore.overall}`);
  } else {
    const pre = await run(
      runStreamingPreRules(storage, crawlId, config, {
        batchSize: BATCH,
        resourceOverrides: RESOURCE_OVERRIDES,
      }),
    );
    mark(`preRules(${pre.pageCount})`);
    const rules = await run(
      runStreamingRules(storage, crawlId, config, pre.assets ?? EMPTY_ASSETS, undefined, {
        batchSize: BATCH,
      }),
    );
    mark("runStreamingRules");
    const report = await run(
      generateReportFromStorage(storage, crawlId, rules, { batchSize: BATCH }),
    );
    mark("report");
    console.log(`  report pages=${report.pages.length} score=${report.healthScore.overall}`);
  }

  clearInterval(timer);
  await run(storage.close());
  console.log(`PEAK_RSS_MB=${(peak / MB).toFixed(0)} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
}

await main();
