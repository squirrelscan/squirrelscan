// Retention census for the streaming pipeline (#1860).
//
// Peak RSS tells you IF a pipeline is bounded; it does not tell you WHICH
// structure is unbounded. This walks the objects `runStreamingRules` returns and
// the universe it holds, and reports each one's size and its size per page, so
// an O(pages) term can be named and priced rather than guessed at.
//
// Sizes are JSON byte lengths, used as a stable proxy for retained size. They
// understate the real heap (object headers, Map overhead, UTF-16 strings) by
// roughly 2-3x, and they are directly comparable between structures and between
// page counts, which is what matters for finding the terms that scale.
//
//   bun run scripts/retention-census.ts --db /tmp/bench.sqlite
//
// Run it at two page counts and compare the per-page columns: a bounded term's
// TOTAL stays flat, an O(pages) term's per-page figure stays flat instead.

import { getDefaultConfig, type Config } from "@squirrelscan/config";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import { runStreamingRules, type PreFetchedAssets } from "../src/adapter";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const DB = arg("db", "/tmp/squirrel-bench.sqlite")!;
const BATCH = Number.parseInt(arg("batch", "50")!, 10);

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

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

/** JSON byte length, tolerant of cycles and of a live DOM (never serialized). */
function sizeOf(value: unknown): number {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (key, v) => {
      // A linkedom Document would serialize the whole tree; it is also exactly
      // what this pipeline is supposed to have dropped, so report its presence
      // rather than its size.
      if (key === "document") return v == null ? null : "<LIVE DOCUMENT>";
      if (typeof v === "object" && v !== null) {
        if (seen.has(v as object)) return "<cycle>";
        seen.add(v as object);
        if (v instanceof Map) return Object.fromEntries(v);
        if (v instanceof Set) return [...v];
      }
      return v;
    })?.length ?? 0;
  } catch {
    return -1;
  }
}

const MB = 1024 * 1024;

async function main(): Promise<void> {
  const storage = new SQLiteStorage(DB);
  await run(storage.init());
  const crawls = await run(storage.listCrawls(1));
  const crawlId = crawls[0]?.id;
  if (!crawlId) throw new Error(`no crawl in ${DB}`);
  const pageCount = await run(storage.getPageCount(crawlId));

  const result = await run(
    runStreamingRules(storage, crawlId, benchConfig(), EMPTY_ASSETS, undefined, {
      batchSize: BATCH,
    }),
  );

  // Every structure the streamed rules pass hands back or holds open. `parsedPages`
  // is the site-rule universe (the `siteData.pages` array); it is the same object
  // set as parsedPagesCache, so it is reported once and noted.
  const rows: Array<[string, unknown]> = [
    ["parsedPages (site universe + cache)", result.parsedPages],
    ["ruleResultsMap", result.ruleResultsMap],
    ["pageResults", result.pageResults],
    ["pageRuleResults", result.pageRuleResults],
    ["siteResults", result.siteResults],
    ["siteRuleResults", result.siteRuleResults],
    ["tallies", result.tallies],
  ];

  console.log(`db=${DB} pages=${pageCount} batch=${BATCH}`);
  console.log(`${"structure".padEnd(38)} ${"total".padStart(10)} ${"per page".padStart(10)}`);
  let total = 0;
  for (const [name, value] of rows) {
    const bytes = sizeOf(value);
    total += Math.max(0, bytes);
    console.log(
      `${name.padEnd(38)} ${`${(bytes / MB).toFixed(1)} MB`.padStart(10)} ${`${Math.round(bytes / pageCount)} B`.padStart(10)}`,
    );
  }
  console.log(
    `${"TOTAL".padEnd(38)} ${`${(total / MB).toFixed(1)} MB`.padStart(10)} ${`${Math.round(total / pageCount)} B`.padStart(10)}`,
  );

  // Break the universe down: which FIELD of a retained ParsedPage is the weight.
  const parsed = [...result.parsedPages.values()];
  const fields = ["content", "links", "images", "schemas", "headings", "schema", "meta", "og"];
  console.log(`\nretained ParsedPage, by field (${parsed.length} pages):`);
  for (const f of fields) {
    const bytes = parsed.reduce(
      (n, p) => n + sizeOf((p as unknown as Record<string, unknown>)[f]),
      0,
    );
    console.log(
      `  ${f.padEnd(14)} ${`${(bytes / MB).toFixed(1)} MB`.padStart(10)} ${`${Math.round(bytes / parsed.length)} B/page`.padStart(14)}`,
    );
  }
  const textBytes = parsed.reduce((n, p) => n + (p.content?.textContent?.length ?? 0), 0);
  console.log(
    `  ${"of which textContent".padEnd(14)} ${`${(textBytes / MB).toFixed(1)} MB`.padStart(10)} ${`${Math.round(textBytes / parsed.length)} B/page`.padStart(14)}`,
  );
  const liveDocs = parsed.filter((p) => p.document != null).length;
  console.log(`  live documents retained: ${liveDocs} (must be 0)`);

  console.log(`\nrss now: ${(process.memoryUsage().rss / MB).toFixed(0)} MB`);
  await run(storage.close());
}

await main();
