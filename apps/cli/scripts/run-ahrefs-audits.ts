#!/usr/bin/env bun

/**
 * Run fresh audits for all Ahrefs fixtures and store timestamped reports.
 *
 * - Crawls every domain under app/data/ahrefs
 * - Saves reports (json, html, markdown, text, llm) under reports/ahrefs-runs/<timestamp>/<domain>/
 * - Updates latest comparison inputs at app/data/reports/ahrefs-comparison/<domain>/
 * - Executes the Ahrefs comparison scripts and snapshots their outputs into the same run folder
 *
 * Usage (from repo root or app/):
 *   bun run scripts/run-ahrefs-audits.ts [--max-pages 300] [--no-refresh] [--skip-compare]
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  generateHtmlReport,
  generateJsonReport,
  generateLlmReport,
  generateMarkdownReport,
  generateTextReport,
} from "../src/audit/report";
import { runAudit } from "../src/controllers/audit";

// Surface failures instead of silently exiting
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

type AuditSummary = {
  domain: string;
  url: string;
  pages: number;
  score: number;
  passed: number;
  warnings: number;
  failed: number;
  outputDir: string;
  error?: string;
};

const args = parseArgs({
  options: {
    "max-pages": { type: "string" },
    refresh: { type: "boolean", default: true },
    "skip-compare": { type: "boolean", default: false },
    target: { type: "string" },
    "run-id": { type: "string" },
    child: { type: "boolean", default: false },
    "summarize-only": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const maxPagesRaw =
  args.values["max-pages"] !== undefined
    ? Number.parseInt(String(args.values["max-pages"]), 10)
    : undefined;
if (Number.isNaN(maxPagesRaw as number)) {
  console.error("Invalid --max-pages value. Expected a number.");
  process.exit(1);
}
const maxPages = maxPagesRaw;
const refresh = args.values.refresh !== false;
const skipCompare = args.values["skip-compare"] === true;
const runId =
  args.values["run-id"] !== undefined
    ? String(args.values["run-id"])
    : new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
const isChild = args.values.child === true;
const summarizeOnly = args.values["summarize-only"] === true;
const targetFilter = args.values.target
  ? String(args.values.target)
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  : undefined;

const repoRoot = resolve(import.meta.dir, "..", "..");
const appDir = join(repoRoot, "app");
const ahrefsRoot = join(appDir, "data", "ahrefs");
const latestOutputRoot = join(appDir, "data", "reports", "ahrefs-comparison");
const runRoot = join(repoRoot, "reports", "ahrefs-runs", runId);

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function listTargets(): string[] {
  const entries = readdirSync(ahrefsRoot, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function runCompareScripts(): Promise<void> {
  const scripts = [
    "scripts/compare-ahrefs.ts",
    "scripts/compare-ahrefs-detailed.ts",
  ];
  for (const script of scripts) {
    console.log(`\n▶ Running ${script}...`);
    const proc = Bun.spawn(["bun", "run", script], {
      cwd: appDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`${script} failed with exit code ${exitCode}`);
    }
  }
}

function copyComparisonOutputs(snapshotDir: string) {
  const comparisonRoot = latestOutputRoot;
  const comparisonDir = join(snapshotDir, "comparisons");
  ensureDir(comparisonDir);

  const candidates = readdirSync(comparisonRoot, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        e.name.match(
          /^(comparison_report_|ahrefs-comparison|ahrefs-gap).+\.md$/
        )
    )
    .map((e) => e.name);

  for (const file of candidates) {
    const src = join(comparisonRoot, file);
    const dest = join(comparisonDir, file);
    copyFileSync(src, dest);
  }
}

function copyLatestPerSite(siteDir: string, latestDir: string) {
  const files = [
    "squirrelscan.json",
    "squirrelscan.html",
    "squirrelscan.md",
    "squirrelscan.txt",
    "squirrelscan.llm.xml",
  ];
  ensureDir(latestDir);
  for (const file of files) {
    const src = join(siteDir, file);
    const dest = join(latestDir, file);
    copyFileSync(src, dest);
  }
}

function writeMetaFile(siteDir: string, meta: Record<string, unknown>): void {
  ensureDir(siteDir);
  writeFileSync(join(siteDir, "meta.json"), JSON.stringify(meta, null, 2));
}

function loadSummariesFromMeta(
  domains: string[],
  runDir: string
): AuditSummary[] {
  const summaries: AuditSummary[] = [];
  for (const domain of domains) {
    const metaPath = join(runDir, domain, "meta.json");
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
        pages?: number;
        score?: number;
        passed?: number;
        warnings?: number;
        failed?: number;
        error?: string;
      };
      summaries.push({
        domain,
        url: `https://${domain}`,
        pages: meta.pages ?? 0,
        score: meta.score ?? 0,
        passed: meta.passed ?? 0,
        warnings: meta.warnings ?? 0,
        failed: meta.failed ?? 0,
        outputDir: join(runDir, domain),
        error: meta.error,
      });
    } else {
      // Fallback: derive summary from latest output if available
      const latestJson = join(latestOutputRoot, domain, "squirrelscan.json");

      if (existsSync(latestJson)) {
        const latest = JSON.parse(readFileSync(latestJson, "utf-8")) as {
          meta: { totalPages: number };
          score: { overall: number };
          summary: { passed: number; warnings: number; failed: number };
        };

        const siteDir = join(runDir, domain);
        ensureDir(siteDir);

        // Mirror latest reports into the run snapshot for completeness
        for (const file of [
          "squirrelscan.json",
          "squirrelscan.html",
          "squirrelscan.md",
          "squirrelscan.txt",
          "squirrelscan.llm.xml",
        ]) {
          const src = join(latestOutputRoot, domain, file);
          if (existsSync(src)) {
            copyFileSync(src, join(siteDir, file));
          }
        }

        const derived = {
          domain,
          url: `https://${domain}`,
          pages: latest.meta?.totalPages ?? 0,
          score: latest.score?.overall ?? "N/A", // null ⇒ N/A (failed/0-page, #586)
          passed: latest.summary?.passed ?? 0,
          warnings: latest.summary?.warnings ?? 0,
          failed: latest.summary?.failed ?? 0,
          outputDir: siteDir,
          error: undefined as string | undefined,
        };

        writeMetaFile(siteDir, {
          timestamp: new Date().toISOString(),
          pages: derived.pages,
          score: derived.score,
          passed: derived.passed,
          warnings: derived.warnings,
          failed: derived.failed,
          error: derived.error,
          options: { maxPages, refresh },
        });

        summaries.push(derived);
      } else {
        summaries.push({
          domain,
          url: `https://${domain}`,
          pages: 0,
          score: 0,
          passed: 0,
          warnings: 0,
          failed: 0,
          outputDir: "",
          error: "No meta.json found",
        });
      }
    }
  }
  return summaries;
}

function writeSummaryFile(
  runDir: string,
  runIdentifier: string,
  summaries: AuditSummary[]
): void {
  const summaryLines: string[] = [];
  summaryLines.push(`# Ahrefs Fixture Audit Run - ${runIdentifier}`);
  summaryLines.push("");
  summaryLines.push(`- Refresh: ${refresh ? "enabled" : "disabled"}`);
  summaryLines.push(`- Max pages: ${maxPages ?? "config default"}`);
  summaryLines.push(`- Run directory: ${runDir.replace(`${repoRoot}/`, "")}`);
  summaryLines.push("");
  summaryLines.push(
    "| Site | Pages | Score | Passed | Warnings | Failed | Output | Status |"
  );
  summaryLines.push(
    "|------|-------|-------|--------|----------|--------|--------|--------|"
  );
  for (const s of summaries) {
    summaryLines.push(
      `| ${s.domain} | ${s.pages} | ${s.score} | ${s.passed} | ${s.warnings} | ${s.failed} | ${s.outputDir.replace(`${repoRoot}/`, "") || "n/a"} | ${s.error ? `❌ ${s.error}` : "✅"} |`
    );
  }
  summaryLines.push("");
  if (!skipCompare) {
    summaryLines.push(
      "Comparison outputs mirrored to `reports/ahrefs-runs/" +
        runIdentifier +
        "/comparisons/`."
    );
  }

  writeFileSync(join(runDir, "summary.md"), summaryLines.join("\n"));
  console.log(`\nRun complete. Summary: ${join(runDir, "summary.md")}`);
}

async function run(): Promise<void> {
  ensureDir(runRoot);
  ensureDir(latestOutputRoot);

  const targets = listTargets();
  if (targets.length === 0) {
    console.error(`No targets found under ${ahrefsRoot}`);
    process.exit(1);
  }

  const filteredTargets =
    targetFilter && targetFilter.length > 0
      ? targets.filter((t) => targetFilter.includes(t.toLowerCase()))
      : targets;

  if (filteredTargets.length === 0) {
    console.error(
      `No targets matched filter: ${targetFilter?.join(", ") ?? "unknown"}`
    );
    process.exit(1);
  }

  console.log(
    `Starting Ahrefs fixture audits (${filteredTargets.length}/${targets.length} sites)`
  );
  console.log(`Run ID: ${runId}`);
  console.log(`Refresh: ${refresh ? "on" : "off"}`);
  if (maxPages) {
    console.log(`Max pages override: ${maxPages}`);
  }

  if (summarizeOnly) {
    const summaries = loadSummariesFromMeta(filteredTargets, runRoot);
    if (!skipCompare) {
      await runCompareScripts();
      copyComparisonOutputs(runRoot);
    }
    writeSummaryFile(runRoot, runId, summaries);
    return;
  }

  // Orchestrate child runs to avoid cross-run TLS flakiness
  if (!isChild && filteredTargets.length > 1) {
    for (const domain of filteredTargets) {
      const childArgs = [
        "bun",
        "run",
        "scripts/run-ahrefs-audits.ts",
        "--target",
        domain,
        "--run-id",
        runId,
        "--skip-compare",
        "--child",
      ];
      if (maxPages) {
        childArgs.push("--max-pages", String(maxPages));
      }
      if (!refresh) {
        childArgs.push("--no-refresh");
      }

      console.log(`\n▶ Spawning isolated audit for ${domain}...`);
      const child = Bun.spawn(childArgs, {
        cwd: appDir,
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        throw new Error(`Child audit for ${domain} failed (exit ${exitCode})`);
      }
    }

    const summaries = loadSummariesFromMeta(filteredTargets, runRoot);
    if (!skipCompare) {
      await runCompareScripts();
      copyComparisonOutputs(runRoot);
    }
    writeSummaryFile(runRoot, runId, summaries);
    return;
  }

  const summaries: AuditSummary[] = [];

  for (const domain of filteredTargets) {
    const url = `https://${domain}`;
    const projectName = `${domain.replace(/[^a-zA-Z0-9]+/g, "-")}-${runId}`;

    console.log(`\n=== Auditing ${url} ===`);
    try {
      const result = await runAudit({
        url,
        maxPages,
        refresh,
        projectName,
        verbose: true,
      });
      console.log(`Result for ${domain}: ${result.ok ? "ok" : "error"}`);

      if (!result.ok) {
        console.error(`✗ Failed audit for ${url}: ${result.error.message}`);
        const siteDir = join(runRoot, domain);
        writeMetaFile(siteDir, {
          timestamp: new Date().toISOString(),
          pages: 0,
          score: 0,
          passed: 0,
          warnings: 0,
          failed: 0,
          error: result.error.message,
          options: { maxPages, refresh, projectName },
        });
        summaries.push({
          domain,
          url,
          pages: 0,
          score: 0,
          passed: 0,
          warnings: 0,
          failed: 0,
          outputDir: "",
          error: result.error.message,
        });
        continue;
      }

      const report = result.data;
      const siteDir = join(runRoot, domain);
      ensureDir(siteDir);

      const basePath = join(siteDir, "squirrelscan");
      generateJsonReport(report, `${basePath}.json`);
      generateMarkdownReport(report, `${basePath}.md`);
      generateTextReport(report, `${basePath}.txt`);
      generateHtmlReport(report, `${basePath}.html`);
      generateLlmReport(report, `${basePath}.llm.xml`);

      const latestDir = join(latestOutputRoot, domain);
      copyLatestPerSite(siteDir, latestDir);

      // Store a small metadata snapshot for quick diffing
      writeMetaFile(siteDir, {
        timestamp: report.timestamp,
        pages: report.totalPages,
        score: report.healthScore?.overall ?? "N/A", // null ⇒ N/A (failed/0-page, #586)
        passed: report.passed,
        warnings: report.warnings,
        failed: report.failed,
        options: { maxPages, refresh, projectName },
      });

      summaries.push({
        domain,
        url,
        pages: report.totalPages,
        score: report.healthScore?.overall ?? "N/A", // null ⇒ N/A (failed/0-page, #586)
        passed: report.passed,
        warnings: report.warnings,
        failed: report.failed,
        outputDir: siteDir,
      });

      console.log(
        `✓ Saved reports to ${siteDir} (score ${report.healthScore?.overall ?? "N/A"}, pages ${report.totalPages})`
      );
      // Sequential execution with 250ms sleep prevents TLS client state conflicts.
      // Each child process gets isolated TLS state, avoiding shared state bugs.
      // Tradeoff: stability over speed - could parallelize but risks TLS issues.
      await Bun.sleep(250);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      console.error(`✗ Unexpected error for ${url}: ${message}`);
      const siteDir = join(runRoot, domain);
      writeMetaFile(siteDir, {
        timestamp: new Date().toISOString(),
        pages: 0,
        score: 0,
        passed: 0,
        warnings: 0,
        failed: 0,
        error: message,
        options: { maxPages, refresh, projectName },
      });
      summaries.push({
        domain,
        url,
        pages: 0,
        score: 0,
        passed: 0,
        warnings: 0,
        failed: 0,
        outputDir: "",
        error: message,
      });
    }
  }

  if (!skipCompare) {
    await runCompareScripts();
    copyComparisonOutputs(runRoot);
  }

  if (!isChild) {
    writeSummaryFile(runRoot, runId, summaries);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
