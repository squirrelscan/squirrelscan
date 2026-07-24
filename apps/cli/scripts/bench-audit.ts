#!/usr/bin/env bun
// Benchmark harness for audit phase timings.
//
// Times each audit phase (crawl / external-links / cloud / rules+report) by
// watching onProgress phase transitions from runAudit(). Use a FRESH project
// name per run (incremental crawl caching otherwise skews crawl timings).
//
// Usage:
//   bun scripts/bench-audit.ts <url> --name <project> [--offline] [--render] [--max-pages N]
//
// For --render against prod, prefix:
//   SQUIRREL_API_SERVER=https://api.squirrelscan.com bun scripts/bench-audit.ts ...
//   (spends real credits: 2cr/page)

import { runAudit, type AuditProgress } from "../src/controllers/audit";
import { configureLogger, logger } from "../src/utils/logger";

// Trace spans (fetchResourceAssets / runPageRules:all / runSiteRules /
// generateReportFromStorage etc.) land in ~/.squirrel logs trace.log.
configureLogger({ trace: true });

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = process.argv[2];
const projectName = arg("--name");
const offline = process.argv.includes("--offline");
const render = process.argv.includes("--render");
const maxPages = arg("--max-pages");

if (!url || !projectName) {
  console.error(
    "usage: bun scripts/bench-audit.ts <url> --name <project> [--offline] [--render] [--max-pages N]"
  );
  process.exit(1);
}

const phaseStart = new Map<string, number>();
const phaseEnd = new Map<string, number>();
let lastPhase: AuditProgress["phase"] | null = null;
let pagesCrawled = 0;
const t0 = Date.now();

function onProgress(p: AuditProgress): void {
  const now = Date.now();
  if (p.phase !== lastPhase) {
    if (lastPhase) phaseEnd.set(lastPhase, now);
    if (!phaseStart.has(p.phase)) phaseStart.set(p.phase, now);
    console.error(
      `[bench] ${((now - t0) / 1000).toFixed(1)}s → phase: ${p.phase}`
    );
    lastPhase = p.phase;
  }
  if (p.phase === "crawling" && p.current) pagesCrawled = p.current;
}

const result = await runAudit({
  url,
  projectName,
  offline,
  refresh: true, // always fresh fetch — never reuse incremental cache
  ...(render ? { cloudRendering: "browser" as const } : {}),
  ...(maxPages ? { maxPages: Number.parseInt(maxPages, 10) } : {}),
  // Decline any cloud-prefetch spend above [cloud].confirm_threshold so the
  // benchmark's cloud cost stays ~= render credits only.
  confirmCloudSpend: async () => false,
  onProgress,
});

const tEnd = Date.now();
if (lastPhase && !phaseEnd.has(lastPhase)) phaseEnd.set(lastPhase, tEnd);

if (!result.ok) {
  console.error(`[bench] AUDIT FAILED: ${result.error.message}`);
  process.exit(1);
}

const report = result.data;
console.log("\n=== bench results ===");
console.log(`url:        ${url}`);
console.log(`project:    ${projectName}`);
console.log(
  `mode:       ${offline ? "offline" : render ? "render" : "online"}`
);
console.log(`pages:      ${report.pages.length} (crawl saw ${pagesCrawled})`);
console.log(`total:      ${((tEnd - t0) / 1000).toFixed(1)}s`);
for (const phase of ["crawling", "external-links", "cloud", "rules"]) {
  const start = phaseStart.get(phase);
  if (start == null) continue;
  // "rules" phase covers asset prefetch + rules + report (next transition is "complete")
  const end = phaseEnd.get(phase) ?? tEnd;
  console.log(`${phase.padEnd(16)} ${((end - start) / 1000).toFixed(1)}s`);
}
// #857: the controller's own finer-grained breakdown (crawl/rules/report/... —
// same wall-clock window as "rules" above, split out). Absent on very old
// binaries only; runAudit always sets it now.
if (report.phaseTimingsMs) {
  console.log("\n=== phase timings (#857) ===");
  for (const [name, ms] of Object.entries(report.phaseTimingsMs)) {
    console.log(`${name.padEnd(16)} ${(ms / 1000).toFixed(1)}s`);
  }
}
await logger.flush();
if (report.cloudSpend) {
  console.log(
    `cloud spend: ${report.cloudSpend.totalSpent}cr (${report.cloudSpend.lines
      .map((l) => `${l.service}=${l.credits}`)
      .join(", ")})`
  );
}
