// What the pre-rules walk's site-wide collectors retain per page (#1860).
//
// The walk reads the crawl one batch at a time, absorbs each batch with its DOMs
// live, and drops it. Three collectors outlive every batch, so anything they
// keep that is a SLICE of a page's html pins that whole page as UTF-16 for the
// rest of the walk — the same failure #234 fixed inside the page loop.
//
//   bun run scripts/prerules-retention.ts --db /tmp/real150.sqlite --mode links
//
// modes: none (control) | links | links-attached | assets | prefetch
//
// `links-attached` is the pre-#1860 body of absorbExternalLinkOccurrences, kept
// here as the control the fix is measured against; without it the retained
// figure has nothing to be a figure OF.
//
// A fixture of identical pages cannot show any of this: the collectors are keyed
// by href / asset URL, so 150 copies of one page give them five keys and five
// pinned pages. Build the fixture with per-page-distinct externals and assets,
// which is what a real catalogue looks like.

import { SQLiteStorage } from "@squirrelscan/crawler";
import { extractLinks } from "@squirrelscan/parser";
import { Effect } from "effect";

import {
  absorbExternalLinkOccurrences,
  buildSiteContext,
  createSiteAssetCollector,
  releaseSiteContextDocuments,
  type ExternalLinkOccurrences,
  type SiteContextPage,
} from "../src/adapter";
import { collectDroppedBatch } from "../src/batch-gc";
import { createCloudPrefetchCollector } from "../src/cloud-prefetch-run";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DB = arg("db", "");
const MODE = arg("mode", "links");
const BATCH = Number.parseInt(arg("batch", "50"), 10);
const MB = 1024 * 1024;

/** The pre-#1860 body: every retained string still a slice of its page. */
function absorbAttached(target: ExternalLinkOccurrences, siteContext: SiteContextPage[]): void {
  for (const { page, parsed } of siteContext) {
    if (!parsed || !parsed.document) continue;
    for (const link of extractLinks(parsed.document, page.finalUrl)) {
      if (link.isInternal || !link.href) continue;
      const list = target.get(link.href) ?? [];
      list.push({
        pageUrl: page.normalizedUrl,
        text: link.text,
        position: link.position,
        isNofollow: link.isNofollow,
      });
      target.set(link.href, list);
    }
  }
}

/**
 * Live page-sized strings, from a heap snapshot. The count is the honest
 * measure here: a pinned page shows up as its whole html buffer still alive,
 * and one batch's worth is the floor (the loop's last batch is still in scope).
 */
function livePageStrings(): { count: number; mb: number } {
  const snapshot = Bun.generateHeapSnapshot() as unknown as {
    nodes: number[];
    nodeClassNames: string[];
  };
  const { nodes, nodeClassNames } = snapshot;
  let count = 0;
  let bytes = 0;
  for (let i = 0; i < nodes.length / 4; i++) {
    if (nodeClassNames[nodes[i * 4 + 2]!] !== "string") continue;
    const size = nodes[i * 4 + 1]!;
    if (size > 1_000_000) {
      count++;
      bytes += size;
    }
  }
  return { count, mb: Math.round(bytes / MB) };
}

const storage = new SQLiteStorage(DB);
await run(storage.init());
const crawls = await run(storage.listCrawls(1));
const crawlId = (crawls as Array<{ id: string }>)[0]!.id;
const crawl = (await run(storage.getCrawl(crawlId))) as { baseUrl: string } | null;
const baseUrl = crawl?.baseUrl ?? "";

const links: ExternalLinkOccurrences = new Map();
const assets = createSiteAssetCollector(baseUrl);
const prefetch = createCloudPrefetchCollector(baseUrl);

Bun.gc(true);
const before = process.memoryUsage();
let pages = 0;

for (let offset = 0; ; offset += BATCH) {
  const batch = await run(storage.getPages(crawlId, { limit: BATCH, offset }));
  if (batch.length === 0) break;
  pages += batch.length;
  const ctx = await run(buildSiteContext(batch));
  if (MODE === "links") absorbExternalLinkOccurrences(links, ctx);
  if (MODE === "links-attached") absorbAttached(links, ctx);
  if (MODE === "assets") assets.absorb(ctx);
  if (MODE === "prefetch") prefetch.absorb(ctx);
  releaseSiteContextDocuments(ctx);
  collectDroppedBatch();
  if (batch.length < BATCH) break;
}

Bun.gc(true);
const after = process.memoryUsage();
const live = livePageStrings();
let occurrences = 0;
for (const list of links.values()) occurrences += list.length;

console.log(
  JSON.stringify({
    db: DB.split("/").pop(),
    mode: MODE,
    pages,
    batch: BATCH,
    // heapUsed alone reports nothing here: a slice pins the string BUFFER, which
    // is external, and the arena hides it from RSS entirely.
    heapMB: Math.round((after.heapUsed - before.heapUsed) / MB),
    externalMB: Math.round((after.external - before.external) / MB),
    livePageStrings: live.count,
    livePageMB: live.mb,
    hrefs: links.size,
    occurrences,
  }),
);
await run(storage.close());
