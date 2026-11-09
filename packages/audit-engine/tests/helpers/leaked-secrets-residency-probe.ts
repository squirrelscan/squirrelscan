// Child-process probe for leaked-secrets-residency-1552.test.ts (#1552).
//
//   bun tests/helpers/leaked-secrets-residency-probe.ts
//
// Runs the streaming engine (`runStreamingRules`, the path `squirrel audit` and the hosted worker take) over pages that each hold
// secret-shaped values, with only security/leaked-secrets enabled, and prints one JSON line: the live heap after a forced GC at the end
// of every batch. What the page-time collector keeps for each page (its secret records, until the site rule runs) shows up as growth
// from batch to batch. Own process, like residency-probe.ts: in one `bun test` process a stale stack root can pin a finished pass.
// The heap is `heapStats().heapSize` (process.memoryUsage().heapUsed lags string memory on Bun). The values are synthetic.

import { heapStats } from "bun:jsc";
import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import type { Config } from "@squirrelscan/config";
import type { PageRecord } from "@squirrelscan/core-contracts";

import { runStreamingRules, type PreFetchedAssets } from "../../src/adapter";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A, never, never>);
const CONFIG = { rule_options: {}, rules: { enable: ["security/leaked-secrets"] } } as unknown as Config;
const ASSETS: PreFetchedAssets = { resourceSizes: { css: [], images: [] }, scripts: [], pdfSizes: [], sitemapUrlStatuses: [] } as unknown as PreFetchedAssets;

export const PROBE_PAGES = 16;
export const PROBE_PAGE_BYTES = 1_500_000;
const ORIGIN = "https://shop.example";

const j = (...parts: string[]): string => parts.join("");
const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const rnd = (next: () => number, n: number, alphabet = ALNUM): string => Array.from({ length: n }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");

function html(i: number): string {
  const next = lcg(9_000 + i);
  const secrets = [
    `<script>var cfg={"apiKey":"${j("AI", "za")}${rnd(next, 35)}","awsKey":"${j("AK", "IA")}${rnd(next, 16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}"};</script>`,
    `<script>window.__ENV__={"stripe":"${j("pk_", "live_")}${rnd(next, 24)}","token":"${j("gh", "p_")}${rnd(next, 36)}","secret":"${j("sk_", "live_")}${rnd(next, 24)}"};</script>`,
    // an attribute value, which a record holds as a slice of the page's serialized markup
    `<div data-key="${j("xo", "xb-")}${rnd(next, 12, "0123456789")}-${rnd(next, 24)}"></div>`,
  ].join("\n");
  const filler = `<p>${"lorem ipsum dolor sit amet ".repeat(40)}</p>\n`;
  const body = filler.repeat(Math.floor(PROBE_PAGE_BYTES / filler.length));
  return `<!doctype html><html lang="en"><head><title>Page ${i} of the shop</title></head><body><main><h1>P${i}</h1>${body}${secrets}</main></body></html>`;
}

function record(i: number): PageRecord {
  const body = html(i);
  const url = `${ORIGIN}/p${i}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 1,
    status: 200,
    contentType: "text/html; charset=utf-8",
    sizeBytes: body.length,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `h${i}`,
    html: body,
    parsedData: null,
    headers: { contentType: "text/html; charset=utf-8" },
    securityHeaders: {},
  } as unknown as PageRecord;
}

if (import.meta.main) {
  const { storage, crawlId } = await writeCrawlToStorage(generateSiteModel({ seed: 3, pageCount: 1 }), ":memory:");
  for (let i = 0; i < PROBE_PAGES; i++) await run(storage.upsertPage(crawlId, record(i)));
  const heap: number[] = [];
  const result = await run(
    runStreamingRules(storage, crawlId, CONFIG, ASSETS, undefined, {
      batchSize: 1,
      hooks: {
        onBatch: () => {
          Bun.gc(true);
          Bun.gc(true);
          heap.push(heapStats().heapSize);
        },
      },
    }),
  );
  const checks = result.ruleResultsMap.get("security/leaked-secrets")?.checks ?? [];
  await run(storage.close());
  console.log(JSON.stringify({ heap, findings: checks.filter((c) => c.status === "fail" || c.status === "warn").length }));
}
