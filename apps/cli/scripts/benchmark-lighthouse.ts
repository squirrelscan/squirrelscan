#!/usr/bin/env bun

/**
 * Lighthouse Benchmark System
 *
 * E2E benchmark comparing squirrelscan vs Lighthouse using PageSpeed Insights API
 * (no local headless browser required)
 *
 * Usage (run from repo root):
 *   bun run app/scripts/benchmark-lighthouse.ts
 *   bun run app/scripts/benchmark-lighthouse.ts --sites nikcub.me,squirrelscan.com
 *   bun run app/scripts/benchmark-lighthouse.ts --refresh
 *   bun run app/scripts/benchmark-lighthouse.ts --strategy desktop
 */

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "util";

import type {
  LighthouseResult,
  PageSpeedInsightsResponse,
  SiteBenchmark,
  SquirrelScanResult,
  TestSite,
} from "../src/benchmark/types";

import { compareSite, generateReport } from "../src/benchmark/analysis";
import { fetchPageSpeedInsights } from "../src/benchmark/pagespeed";
import {
  generateMarkdownReport,
  printCorrelations,
  printGapAnalysis,
  printSummary,
} from "../src/benchmark/report";

// Test sites
const SITES: TestSite[] = [
  { domain: "nikcub.me", url: "https://nikcub.me" },
  { domain: "techmeme.com", url: "https://www.techmeme.com" },
  { domain: "gymshark.com", url: "https://www.gymshark.com" },
  { domain: "smh.com.au", url: "https://www.smh.com.au" },
  { domain: "squirrelscan.com", url: "https://squirrelscan.com" },
];

const DATA_DIR = "data/benchmark";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Parse CLI args
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    sites: { type: "string" },
    refresh: { type: "boolean", default: false },
    strategy: { type: "string", default: "mobile" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Lighthouse Benchmark - Compare SquirrelScan vs Lighthouse (via PSI API)

Usage:
  bun run scripts/benchmark-lighthouse.ts [options]

Options:
  --sites <domains>    Comma-separated list of domains to test (default: all)
  --refresh            Force refresh cached results
  --strategy <type>    mobile or desktop (default: mobile)
  -h, --help           Show this help

Environment:
  GOOGLE_PSI_API_KEY   Required. Get free key from:
                       https://console.cloud.google.com/apis/credentials
                       Enable "PageSpeed Insights API" in the project.

Examples:
  GOOGLE_PSI_API_KEY=xxx bun run scripts/benchmark-lighthouse.ts
  bun run scripts/benchmark-lighthouse.ts --sites nikcub.me,squirrelscan.com
  bun run scripts/benchmark-lighthouse.ts --refresh --strategy desktop
`);
  process.exit(0);
}

// Utilities
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isCacheValid(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const stats = Bun.file(filePath);
  const mtime = stats.lastModified;
  return Date.now() - mtime < CACHE_TTL_MS;
}

// Fetch PSI with caching
async function fetchPSICached(
  url: string,
  outputPath: string,
  strategy: "mobile" | "desktop",
  forceRefresh: boolean
): Promise<PageSpeedInsightsResponse> {
  if (!forceRefresh && isCacheValid(outputPath)) {
    console.log(`   📦 Using cached PSI result`);
    const raw = readFileSync(outputPath, "utf8");
    return JSON.parse(raw);
  }

  console.log(`   🌐 Fetching PageSpeed Insights (${strategy})...`);
  ensureDir(dirname(outputPath));

  const psi = await fetchPageSpeedInsights(url, { strategy });
  writeFileSync(outputPath, JSON.stringify(psi, null, 2));
  return psi;
}

// Run SquirrelScan with caching
async function runSquirrelScanCached(
  url: string,
  outputPath: string,
  forceRefresh: boolean
): Promise<SquirrelScanResult> {
  if (!forceRefresh && isCacheValid(outputPath)) {
    console.log(`   📦 Using cached SquirrelScan result`);
    const raw = readFileSync(outputPath, "utf8");
    return JSON.parse(raw);
  }

  console.log(`   🐿️  Running SquirrelScan (10 pages)...`);
  ensureDir(dirname(outputPath));

  // Run from local source code (not installed binary) to test recent changes
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
  await $`bun run ${cliPath} audit ${url} --max-pages=10 --format=json -o ${outputPath}`.quiet();

  if (!existsSync(outputPath)) {
    throw new Error(`Output file not created: ${outputPath}`);
  }

  const raw = readFileSync(outputPath, "utf8");
  return JSON.parse(raw);
}

// Main
async function main(): Promise<void> {
  const strategy = (args.strategy === "desktop" ? "desktop" : "mobile") as
    | "mobile"
    | "desktop";
  const forceRefresh = args.refresh ?? false;

  // Filter sites if specified
  let sitesToRun = SITES;
  if (args.sites) {
    const requested = args.sites.split(",").map((s) => s.trim().toLowerCase());
    sitesToRun = SITES.filter((s) =>
      requested.some((r) => s.domain.toLowerCase().includes(r))
    );

    if (sitesToRun.length === 0) {
      console.error(
        `No matching sites found. Available: ${SITES.map((s) => s.domain).join(", ")}`
      );
      process.exit(1);
    }
  }

  // Check for API key
  if (!process.env.GOOGLE_PSI_API_KEY) {
    console.error("\n❌ GOOGLE_PSI_API_KEY environment variable required.");
    console.error(
      "Get a free key from: https://console.cloud.google.com/apis/credentials"
    );
    console.error(
      "Enable 'PageSpeed Insights API' in your Google Cloud project.\n"
    );
    process.exit(1);
  }

  console.log("\n" + "=".repeat(60));
  console.log("LIGHTHOUSE BENCHMARK (via PageSpeed Insights API)");
  console.log("=".repeat(60));
  console.log(`\nSites: ${sitesToRun.map((s) => s.domain).join(", ")}`);
  console.log(`Strategy: ${strategy}`);
  console.log(`Force refresh: ${forceRefresh}\n`);

  ensureDir(DATA_DIR);

  // Run all sites concurrently
  const results = await Promise.all(
    sitesToRun.map(async (site): Promise<SiteBenchmark | null> => {
      console.log(`\n📊 Analyzing ${site.domain}...`);

      const psiPath = join(DATA_DIR, site.domain, `psi-${strategy}.json`);
      const ssPath = join(DATA_DIR, site.domain, "squirrelscan.json");

      try {
        // Run PSI and SquirrelScan concurrently
        const [psi, ss] = await Promise.all([
          fetchPSICached(site.url, psiPath, strategy, forceRefresh),
          runSquirrelScanCached(site.url, ssPath, forceRefresh),
        ]);

        // Compare results
        const comparison = compareSite(
          site.domain,
          site.url,
          psi.lighthouseResult,
          ss,
          strategy
        );

        console.log(`   ✅ Analysis complete`);
        return comparison;
      } catch (error) {
        console.error(`   ❌ Failed to analyze ${site.domain}: ${error}`);
        return null;
      }
    })
  );

  // Filter out failed sites
  const successfulResults = results.filter(
    (r): r is SiteBenchmark => r !== null
  );

  if (successfulResults.length === 0) {
    console.error("\n❌ No sites were successfully analyzed.");
    process.exit(1);
  }

  // Generate report
  const report = generateReport(successfulResults);

  // Print console output
  printSummary(successfulResults);
  printCorrelations(report);
  printGapAnalysis(report);

  // Write files
  const jsonPath = join(DATA_DIR, "lighthouse-report.json");
  const mdPath = join(DATA_DIR, "lighthouse-report.md");

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, generateMarkdownReport(report));

  console.log("\n" + "=".repeat(60));
  console.log("OUTPUT FILES");
  console.log("=".repeat(60));
  console.log(`\n📄 JSON: ${jsonPath}`);
  console.log(`📄 Markdown: ${mdPath}`);

  console.log("\n✅ Benchmark complete!\n");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
