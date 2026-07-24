#!/usr/bin/env bun
// bunx-able CLI entry:
//   bun run packages/synthetic-site/src/cli.ts --pages 5000 --serve
//   bun run packages/synthetic-site/src/cli.ts --pages 5000 --write-db ./crawl.sqlite
//
// Dev-only tool, never imported by the shipping CLI or hosted runtimes.

import { parseArgs } from "node:util";

import type { GenerateSiteModelOptions, IssueMixOptions } from "./types";

import { Effect } from "effect";

import { generateSiteModel } from "./page-model";
import { serveSite } from "./server";
import { writeCrawlToStorage } from "./storage-writer";

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  // Rejects NaN AND ±Infinity — an unbounded pageCount/size would otherwise
  // try to allocate an infinite-length array or loop forever downstream.
  if (!Number.isFinite(n)) throw new Error(`Expected a finite number, got "${value}"`);
  return n;
}

function issueSpec(count: string | undefined): { count: number } | undefined {
  const n = num(count);
  return n === undefined ? undefined : { count: n };
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    pages: { type: "string" },
    seed: { type: "string", default: "synthetic-site" },
    serve: { type: "boolean", default: false },
    "write-db": { type: "string" },
    port: { type: "string", default: "0" },
    "base-url": { type: "string", default: "http://synthetic.test" },
    "template-count": { type: "string" },
    "min-size": { type: "string" },
    "max-size": { type: "string" },
    "clean-ratio": { type: "string" },
    "latency-ms": { type: "string" },
    "long-h1": { type: "string" },
    "oversize-title": { type: "string" },
    "oversize-description": { type: "string" },
    "long-urls": { type: "string" },
    "orphan-pages": { type: "string" },
    "broken-links": { type: "string" },
    "noindex-in-sitemap": { type: "string" },
    "dup-title-groups": { type: "string" },
    "dup-title-group-size": { type: "string" },
    "dup-description-groups": { type: "string" },
    "dup-description-group-size": { type: "string" },
    "redirect-chains": { type: "string" },
    "redirect-chain-length": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help || !values.pages) {
  console.log(
    `Usage: synthetic-site --pages <n> [--serve | --write-db <path>] [options]

  --pages <n>                 Page count (required)
  --seed <string>              Seed — same seed reproduces the identical model (default: "synthetic-site")
  --serve                      Start an HTTP server serving the generated site
  --write-db <path>            Write a crawl directly into a SQLite storage file at <path>
  --port <n>                   Port for --serve (default: random free port)
  --base-url <url>             Origin used for --write-db page URLs (default: http://synthetic.test)
  --template-count <n>         Distinct structural page templates (default: 5)
  --min-size / --max-size <n>  Target page HTML size range in bytes (default: 30000-80000)
  --clean-ratio <0..1>         Approximate share of issue-free pages (default: 0.5)
  --latency-ms <n>              Artificial per-response delay for --serve (tarpit simulation)
  --long-h1 / --oversize-title / --oversize-description / --long-urls /
  --orphan-pages / --broken-links / --noindex-in-sitemap <n>   Issue counts
  --dup-title-groups / --dup-title-group-size <n>
  --dup-description-groups / --dup-description-group-size <n>
  --redirect-chains / --redirect-chain-length <n>
`,
  );
  process.exit(values.help ? 0 : 1);
}

// Building these calls `num()`, which throws on a non-finite value — kept
// INSIDE main() (not at module top level) so that failure is caught by
// main().catch() below and surfaces as a clean one-line error + exit 1,
// instead of an unhandled top-level throw dumping a raw stack trace.
function buildOptions(): GenerateSiteModelOptions {
  const issues: IssueMixOptions = {
    longH1: issueSpec(values["long-h1"]),
    oversizeTitle: issueSpec(values["oversize-title"]),
    oversizeDescription: issueSpec(values["oversize-description"]),
    longUrls: issueSpec(values["long-urls"]),
    orphanPages: issueSpec(values["orphan-pages"]),
    brokenLinks: issueSpec(values["broken-links"]),
    noindexInSitemap: issueSpec(values["noindex-in-sitemap"]),
    duplicateTitles:
      values["dup-title-groups"] || values["dup-title-group-size"]
        ? {
            groupCount: num(values["dup-title-groups"]),
            groupSize: num(values["dup-title-group-size"]),
          }
        : undefined,
    duplicateDescriptions:
      values["dup-description-groups"] || values["dup-description-group-size"]
        ? {
            groupCount: num(values["dup-description-groups"]),
            groupSize: num(values["dup-description-group-size"]),
          }
        : undefined,
    redirectChains:
      values["redirect-chains"] || values["redirect-chain-length"]
        ? {
            count: num(values["redirect-chains"]),
            chainLength: num(values["redirect-chain-length"]),
          }
        : undefined,
  };

  return {
    seed: values.seed as string,
    pageCount: num(values.pages)!,
    templateCount: num(values["template-count"]),
    minPageSizeBytes: num(values["min-size"]),
    maxPageSizeBytes: num(values["max-size"]),
    cleanRatio: num(values["clean-ratio"]),
    issues,
  };
}

async function main(): Promise<void> {
  const options = buildOptions();
  const start = performance.now();
  const model = generateSiteModel(options);
  const generateMs = performance.now() - start;
  console.log(
    `Generated ${model.pages.length} pages (seed="${model.seed}") in ${generateMs.toFixed(0)}ms. Issue summary:`,
  );
  console.table(model.issueSummary);

  if (values["write-db"]) {
    const dbStart = performance.now();
    const result = await writeCrawlToStorage(model, values["write-db"] as string, {
      baseUrl: values["base-url"] as string,
    });
    console.log(
      `Wrote crawl ${result.crawlId} (${result.pageCount} pages, ${result.linkAppearanceCount} link appearances) to ${values["write-db"]} in ${(performance.now() - dbStart).toFixed(0)}ms`,
    );
    await Effect.runPromise(result.storage.close() as Effect.Effect<void, never, never>);
    return;
  }

  if (values.serve) {
    const latencyMs = num(values["latency-ms"]);
    const served = serveSite(model, { port: num(values.port), latencyMs });
    console.log(`Serving synthetic site at ${served.url} (Ctrl-C to stop)`);
    process.on("SIGINT", () => {
      served.stop();
      process.exit(0);
    });
    return;
  }

  console.log("Nothing to do — pass --serve or --write-db <path>.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
