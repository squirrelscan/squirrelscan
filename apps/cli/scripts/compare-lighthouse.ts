#!/usr/bin/env bun

/**
 * Compare Lighthouse audits against SquirrelScan rules
 * Runs both tools on test sites and generates coverage report
 */

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Test sites
const SITES = [
  { domain: "nikcub.me", url: "https://nikcub.me" },
  { domain: "gymshark.com", url: "https://www.gymshark.com" },
  { domain: "smh.com.au", url: "https://www.smh.com.au" },
  { domain: "techmeme.com", url: "https://www.techmeme.com" },
  { domain: "news.ycombinator.com", url: "https://news.ycombinator.com" },
];

const DATA_DIR = "data/lighthouse-comparison";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Lighthouse audit ID -> SquirrelScan rule ID(s) mapping
// null = browser-required (skip), [] = not covered, string[] = mapped rules
const LIGHTHOUSE_TO_SQUIRRELSCAN: Record<string, string[] | null> = {
  // === SEO ===
  "document-title": ["core/meta-title"],
  "meta-description": ["core/meta-description"],
  "link-text": ["a11y/link-text"],
  "is-crawlable": ["crawl/indexability"],
  "robots-txt": ["crawl/robots-txt"],
  hreflang: ["i18n/hreflang"],
  canonical: ["core/canonical"],
  "structured-data-automatic": ["schema/json-ld-valid"],
  "tap-targets": ["a11y/touch-targets"],
  "font-size": ["mobile/font-size"],
  viewport: ["mobile/viewport"],
  plugins: [], // Flash/Java plugins - obsolete

  // === Accessibility (55+ rules) ===
  // Color and visual
  "color-contrast": ["a11y/color-contrast"],

  // Navigation and structure
  "heading-order": ["a11y/heading-order"],
  bypass: ["a11y/skip-link"],
  tabindex: ["a11y/tabindex"],
  accesskeys: ["a11y/accesskeys"],

  // Language
  "html-has-lang": ["i18n/lang-attribute"],
  "html-lang-valid": ["a11y/html-lang-valid"],
  "valid-lang": ["a11y/valid-lang"],
  "html-xml-lang-mismatch": ["a11y/html-xml-lang-mismatch"],

  // Images
  "image-alt": ["images/alt-text"],
  "input-image-alt": ["a11y/input-image-alt"],
  "image-redundant-alt": ["a11y/image-redundant-alt"],
  "object-alt": ["a11y/object-alt"],

  // Buttons and links
  "button-name": ["a11y/button-name"],
  "link-name": ["a11y/link-text"],
  "duplicate-id-active": ["a11y/duplicate-id-active"],
  "duplicate-id-aria": ["a11y/duplicate-id-aria"],
  "identical-links-same-purpose": ["a11y/identical-links-same-purpose"],
  "link-in-text-block": ["a11y/link-in-text-block"],

  // Forms
  "form-field-multiple-labels": ["a11y/form-field-multiple-labels"],
  "input-button-name": ["a11y/button-name"],
  label: ["a11y/form-labels"],
  "select-name": ["a11y/select-name"],

  // ARIA attributes
  "aria-allowed-attr": ["a11y/aria-allowed-attr"],
  "aria-command-name": ["a11y/aria-command-name"],
  "aria-dialog-name": ["a11y/aria-dialog-name"],
  "aria-hidden-body": ["a11y/aria-hidden-body"],
  "aria-hidden-focus": ["a11y/aria-hidden-focus"],
  "aria-input-field-name": ["a11y/aria-input-field-name"],
  "aria-meter-name": ["a11y/aria-meter-name"],
  "aria-progressbar-name": ["a11y/aria-progressbar-name"],
  "aria-required-attr": ["a11y/aria-required-attr"],
  "aria-required-children": ["a11y/aria-required-children"],
  "aria-required-parent": ["a11y/aria-required-parent"],
  "aria-roles": ["a11y/aria-roles"],
  "aria-toggle-field-name": ["a11y/aria-toggle-field-name"],
  "aria-tooltip-name": ["a11y/aria-tooltip-name"],
  "aria-treeitem-name": ["a11y/aria-treeitem-name"],
  "aria-valid-attr-value": ["a11y/aria-valid-attr-value"],
  "aria-text": ["a11y/aria-text"],
  "aria-valid-attr": ["a11y/aria-valid-attr"],
  "aria-conditional-attr": [], // New LH rule - not yet implemented

  // Lists
  "definition-list": ["a11y/definition-list"],
  dlitem: ["a11y/dlitem"],
  list: ["a11y/list-structure"],
  listitem: ["a11y/listitem"],

  // Tables
  "td-headers-attr": ["a11y/td-headers-attr"],
  "th-has-data-cells": ["a11y/th-has-data-cells"],
  "table-duplicate-name": ["a11y/table-duplicate-name"],

  // Frames
  "frame-title": ["a11y/frame-title"],

  // Landmarks
  landmark: ["a11y/landmark-regions"],
  "landmark-one-main": ["a11y/landmark-one-main"],

  // Meta and page-level
  "meta-refresh": ["a11y/meta-refresh"],
  "meta-viewport": ["a11y/zoom-disabled"],

  // Headings
  "empty-heading": ["a11y/empty-heading"],

  // Video/audio
  "video-caption": ["a11y/video-captions"],
  "audio-caption": [], // Not yet implemented

  // Other a11y
  "label-content-name-mismatch": ["a11y/label-content-name-mismatch"],
  "focus-traps": null, // Browser required - needs user interaction
  "focusable-controls": null, // Browser required
  "interactive-element-affordance": null, // Browser required
  "logical-tab-order": null, // Browser required
  "managed-focus": null, // Browser required
  "offscreen-content-hidden": null, // Browser required
  "use-landmarks": ["a11y/landmark-regions"],
  "visual-order-follows-dom": null, // Browser required

  // === Best Practices ===
  "is-on-https": ["security/https"],
  doctype: ["core/doctype"],
  charset: ["core/charset"],
  "csp-xss": ["security/csp"],
  "js-libraries": ["perf/js-libraries"],
  "no-vulnerable-libraries": ["perf/js-libraries"], // Same check, different severity
  "password-inputs-can-be-pasted-into": ["a11y/paste-inputs"],
  "image-aspect-ratio": ["images/dimensions"],
  "image-size-responsive": ["images/responsive-size"],
  deprecations: null, // Browser required - console API
  "errors-in-console": null, // Browser required
  "geolocation-on-start": null, // Browser required
  "notification-on-start": null, // Browser required
  "inspector-issues": null, // Browser required
  "valid-source-maps": ["perf/source-maps"],

  // === Performance (static analysis only) ===
  "dom-size": ["perf/dom-size"],
  "render-blocking-resources": ["perf/render-blocking"],
  "unminified-css": ["perf/unminified-css"],
  "unminified-javascript": ["perf/unminified-js"],
  "uses-text-compression": ["perf/compression"],
  "uses-http2": ["perf/http2"],
  "total-byte-weight": ["perf/total-byte-weight"],
  "uses-long-cache-ttl": ["perf/cache-headers"],
  "uses-optimized-images": ["images/optimized"],
  "uses-webp-images": ["images/modern-format"],
  "uses-responsive-images": ["images/srcset"],
  "offscreen-images": ["images/offscreen-lazy"],
  "unsized-images": ["images/dimensions"],
  "preload-lcp-image": ["perf/lcp-hints"],
  "lcp-lazy-loaded": ["perf/lazy-above-fold"],
  "prioritize-lcp-image": ["perf/lcp-hints"],
  "uses-rel-preconnect": ["perf/preconnect"],
  "font-display": ["perf/font-loading"],
  "duplicated-javascript": ["perf/duplicate-js"],
  "legacy-javascript": ["perf/legacy-js"],
  "third-party-summary": [], // Aggregation - not 1:1 rule
  "third-party-facades": [], // Third party optimization - not covered
  "script-treemap-data": null, // Browser required - runtime bundle analysis
  "efficient-animated-content": ["perf/animated-content"],
  "unused-css-rules": null, // Browser required - runtime CSS coverage
  "unused-javascript": null, // Browser required - runtime JS coverage

  // CWV metrics - all browser required
  "first-contentful-paint": null,
  "largest-contentful-paint": null,
  "cumulative-layout-shift": null,
  "total-blocking-time": null,
  "speed-index": null,
  interactive: null,
  "max-potential-fid": null,
  "server-response-time": ["perf/ttfb"],
  "mainthread-work-breakdown": null,
  "bootup-time": null,
  "network-requests": null,
  "network-rtt": null,
  "network-server-latency": null,
  "critical-request-chains": ["perf/critical-request-chains"],
  redirects: ["crawl/redirect-chain"],
  "user-timings": null,
  "layout-shift-elements": null,
  "long-tasks": null,
  "non-composited-animations": null,

  // PWA - not in scope
  "service-worker": null,
  "installable-manifest": null,
  "themed-omnibox": null,
  "splash-screen": null,
  "maskable-icon": null,
  "content-width": null, // PWA viewport
  "apple-touch-icon": [], // Could add
  pwa: null,
};

// Categories for grouping (only audits that are both in LH output and our mapping)
const LH_CATEGORIES: Record<string, string[]> = {
  SEO: [
    "document-title",
    "meta-description",
    "link-text",
    "is-crawlable",
    "robots-txt",
    "hreflang",
    "canonical",
  ],
  Accessibility: [
    "color-contrast",
    "heading-order",
    "bypass",
    "tabindex",
    "accesskeys",
    "html-has-lang",
    "html-lang-valid",
    "valid-lang",
    "html-xml-lang-mismatch",
    "image-alt",
    "input-image-alt",
    "image-redundant-alt",
    "object-alt",
    "button-name",
    "link-name",
    "duplicate-id-active",
    "duplicate-id-aria",
    "identical-links-same-purpose",
    "link-in-text-block",
    "form-field-multiple-labels",
    "input-button-name",
    "label",
    "select-name",
    "aria-allowed-attr",
    "aria-command-name",
    "aria-dialog-name",
    "aria-hidden-body",
    "aria-hidden-focus",
    "aria-input-field-name",
    "aria-meter-name",
    "aria-progressbar-name",
    "aria-required-attr",
    "aria-required-children",
    "aria-required-parent",
    "aria-roles",
    "aria-toggle-field-name",
    "aria-tooltip-name",
    "aria-treeitem-name",
    "aria-text",
    "aria-valid-attr-value",
    "aria-valid-attr",
    "definition-list",
    "dlitem",
    "list",
    "listitem",
    "td-headers-attr",
    "th-has-data-cells",
    "table-duplicate-name",
    "frame-title",
    "landmark",
    "landmark-one-main",
    "meta-refresh",
    "meta-viewport",
    "empty-heading",
    "video-caption",
    "label-content-name-mismatch",
  ],
  "Best Practices": [
    "is-on-https",
    "doctype",
    "charset",
    "csp-xss",
    "js-libraries",
    "no-vulnerable-libraries",
    "password-inputs-can-be-pasted-into",
    "image-aspect-ratio",
    "image-size-responsive",
    "valid-source-maps",
  ],
  Performance: [
    "dom-size",
    "render-blocking-resources",
    "unminified-css",
    "unminified-javascript",
    "uses-text-compression",
    "uses-http2",
    "total-byte-weight",
    "uses-long-cache-ttl",
    "uses-optimized-images",
    "uses-webp-images",
    "uses-responsive-images",
    "offscreen-images",
    "unsized-images",
    "preload-lcp-image",
    "lcp-lazy-loaded",
    "prioritize-lcp-image",
    "uses-rel-preconnect",
    "font-display",
    "duplicated-javascript",
    "legacy-javascript",
    "efficient-animated-content",
    "server-response-time",
    "critical-request-chains",
    "redirects",
  ],
};

// Types
interface LighthouseAudit {
  id: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string;
  numericValue?: number;
  details?: {
    type: string;
    items?: unknown[];
  };
}

interface LighthouseResult {
  audits: Record<string, LighthouseAudit>;
  categories: Record<
    string,
    {
      id: string;
      title: string;
      score: number | null;
      auditRefs: Array<{ id: string; weight: number }>;
    }
  >;
}

interface SquirrelScanResult {
  meta: { totalPages: number };
  score: { overall: number; grade: string };
  summary: { passed: number; warnings: number; failed: number };
  issues: Array<{
    ruleId: string;
    severity: "error" | "warning" | "info";
    checks: Array<{ status: string; affectedPages: string[] }>;
  }>;
}

interface AuditComparison {
  lhAuditId: string;
  lhTitle: string;
  ssRuleIds: string[] | null;
  lhScore: number | null;
  lhIssueCount: number;
  ssIssueCount: number;
  covered: boolean;
  browserRequired: boolean;
}

interface CategoryComparison {
  name: string;
  lhScore: number | null;
  covered: number;
  total: number;
  browserRequired: number;
  audits: AuditComparison[];
}

interface SiteComparison {
  domain: string;
  url: string;
  lh: LighthouseResult;
  ss: SquirrelScanResult;
  categories: CategoryComparison[];
}

// Utility functions
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

// Run Lighthouse on a URL
async function runLighthouse(
  url: string,
  outputPath: string,
  forceRefresh: boolean
): Promise<void> {
  if (!forceRefresh && isCacheValid(outputPath)) {
    console.log(`   Using cached Lighthouse result`);
    return;
  }

  console.log(`   Running Lighthouse...`);
  ensureDir(dirname(outputPath));

  try {
    await $`npx lighthouse ${url} \
      --output=json \
      --output-path=${outputPath} \
      --chrome-flags="--headless --no-sandbox --disable-gpu" \
      --only-categories=accessibility,best-practices,seo,performance \
      --quiet`.quiet();
  } catch (error) {
    console.error(`   Lighthouse failed: ${error}`);
    throw error;
  }
}

// Run SquirrelScan on a URL
async function runSquirrelScan(
  url: string,
  outputPath: string,
  forceRefresh: boolean
): Promise<void> {
  if (!forceRefresh && isCacheValid(outputPath)) {
    console.log(`   Using cached SquirrelScan result`);
    return;
  }

  console.log(`   Running SquirrelScan...`);
  ensureDir(dirname(outputPath));

  try {
    // Run squirrel binary with max 10 pages, JSON output to file
    const result =
      await $`squirrel audit ${url} --max-pages=10 --format=json -o ${outputPath}`.quiet();

    // Verify file was created
    if (!existsSync(outputPath)) {
      throw new Error(`Output file not created: ${outputPath}`);
    }
  } catch (error) {
    console.error(`   SquirrelScan failed: ${error}`);
    throw error;
  }
}

// Parse Lighthouse JSON result
function parseLighthouseResult(filePath: string): LighthouseResult {
  const raw = readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  return {
    audits: data.audits,
    categories: data.categories,
  };
}

// Parse SquirrelScan JSON result
function parseSquirrelScanResult(filePath: string): SquirrelScanResult {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

// Count issues for a Lighthouse audit
function getLhIssueCount(audit: LighthouseAudit): number {
  if (audit.details?.items) {
    return audit.details.items.length;
  }
  if (audit.score === 0) return 1;
  if (audit.score !== null && audit.score < 1) return 1;
  return 0;
}

// Count issues for SquirrelScan rules
function getSsIssueCount(ss: SquirrelScanResult, ruleIds: string[]): number {
  let count = 0;
  for (const ruleId of ruleIds) {
    const issue = ss.issues.find((i) => i.ruleId === ruleId);
    if (issue) {
      for (const check of issue.checks) {
        count += check.affectedPages?.length ?? 0;
      }
    }
  }
  return count;
}

// Compare audits for a site
function compareSite(
  domain: string,
  url: string,
  lh: LighthouseResult,
  ss: SquirrelScanResult
): SiteComparison {
  const categories: CategoryComparison[] = [];

  for (const [catName, auditIds] of Object.entries(LH_CATEGORIES)) {
    const audits: AuditComparison[] = [];
    let covered = 0;
    let browserRequired = 0;

    for (const auditId of auditIds) {
      const lhAudit = lh.audits[auditId];
      if (!lhAudit) continue;

      const ssRuleIds = LIGHTHOUSE_TO_SQUIRRELSCAN[auditId];
      const isBrowserRequired = ssRuleIds === null;
      const isCovered =
        !isBrowserRequired && ssRuleIds !== undefined && ssRuleIds.length > 0;

      if (isBrowserRequired) browserRequired++;
      if (isCovered) covered++;

      audits.push({
        lhAuditId: auditId,
        lhTitle: lhAudit.title,
        ssRuleIds,
        lhScore: lhAudit.score,
        lhIssueCount: getLhIssueCount(lhAudit),
        ssIssueCount: isCovered ? getSsIssueCount(ss, ssRuleIds!) : 0,
        covered: isCovered,
        browserRequired: isBrowserRequired,
      });
    }

    const lhCategory = Object.values(lh.categories).find((c) =>
      c.id.toLowerCase().includes(catName.toLowerCase().replace(" ", "-"))
    );

    categories.push({
      name: catName,
      lhScore: lhCategory?.score ?? null,
      covered,
      total: audits.length,
      browserRequired,
      audits,
    });
  }

  return { domain, url, lh, ss, categories };
}

// Generate console summary
function printSummary(comparisons: SiteComparison[]): void {
  console.log("\n" + "=".repeat(80));
  console.log("LIGHTHOUSE VS SQUIRRELSCAN COVERAGE COMPARISON");
  console.log("=".repeat(80) + "\n");

  for (const site of comparisons) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Site: ${site.domain}`);
    console.log(`${"─".repeat(60)}`);
    console.log(
      `SquirrelScan: ${site.ss.score.overall}% (${site.ss.score.grade}), ${site.ss.meta.totalPages} pages`
    );
    console.log(
      `Issues: ${site.ss.summary.failed} errors, ${site.ss.summary.warnings} warnings, ${site.ss.summary.passed} passed\n`
    );

    console.log(
      "| Category        | LH Score | SS Score | Coverage | Browser Req |"
    );
    console.log(
      "|-----------------|----------|----------|----------|-------------|"
    );

    for (const cat of site.categories) {
      const lhScore =
        cat.lhScore !== null ? `${Math.round(cat.lhScore * 100)}%` : "--";
      const ssScore = `${site.ss.score.overall}%`; // Use overall for now
      const coverage = `${cat.covered}/${cat.total - cat.browserRequired}`;
      const browserReq =
        cat.browserRequired > 0 ? `${cat.browserRequired}*` : "0";

      console.log(
        `| ${cat.name.padEnd(15)} | ${lhScore.padStart(8)} | ${ssScore.padStart(8)} | ${coverage.padStart(8)} | ${browserReq.padStart(11)} |`
      );
    }

    console.log("\n* Browser-required audits excluded from comparison");
  }

  // Overall coverage summary
  console.log("\n" + "=".repeat(80));
  console.log("OVERALL MAPPING COVERAGE");
  console.log("=".repeat(80) + "\n");

  const allAudits = Object.keys(LIGHTHOUSE_TO_SQUIRRELSCAN);
  const covered = allAudits.filter((a) => {
    const v = LIGHTHOUSE_TO_SQUIRRELSCAN[a];
    return v !== null && v.length > 0;
  });
  const browserRequired = allAudits.filter(
    (a) => LIGHTHOUSE_TO_SQUIRRELSCAN[a] === null
  );
  const notCovered = allAudits.filter((a) => {
    const v = LIGHTHOUSE_TO_SQUIRRELSCAN[a];
    return v !== null && v.length === 0;
  });

  console.log(`Total Lighthouse audits mapped: ${allAudits.length}`);
  console.log(
    `Covered by SquirrelScan: ${covered.length} (${Math.round((covered.length / allAudits.length) * 100)}%)`
  );
  console.log(`Browser-required (skipped): ${browserRequired.length}`);
  console.log(`Not yet covered: ${notCovered.length}`);

  if (notCovered.length > 0) {
    console.log("\nNot covered audits:");
    for (const audit of notCovered) {
      console.log(`  - ${audit}`);
    }
  }
}

// Generate markdown report
function generateMarkdownReport(comparisons: SiteComparison[]): string {
  let md = "# Lighthouse vs SquirrelScan Coverage Report\n\n";
  md += `**Generated:** ${new Date().toISOString().split("T")[0]}\n\n`;

  // Executive summary
  const allAudits = Object.keys(LIGHTHOUSE_TO_SQUIRRELSCAN);
  const covered = allAudits.filter((a) => {
    const v = LIGHTHOUSE_TO_SQUIRRELSCAN[a];
    return v !== null && v.length > 0;
  });
  const browserRequired = allAudits.filter(
    (a) => LIGHTHOUSE_TO_SQUIRRELSCAN[a] === null
  );

  md += "## Executive Summary\n\n";
  md += `- **Total Lighthouse audits:** ${allAudits.length}\n`;
  md += `- **Covered by SquirrelScan:** ${covered.length} (${Math.round((covered.length / allAudits.length) * 100)}%)\n`;
  md += `- **Browser-required (skipped):** ${browserRequired.length}\n`;
  md += `- **Sites tested:** ${comparisons.length}\n\n`;

  // Per-site results
  md += "## Site Results\n\n";

  for (const site of comparisons) {
    md += `### ${site.domain}\n\n`;
    md += `**URL:** ${site.url}\n\n`;
    md += `**SquirrelScan Score:** ${site.ss.score.overall}% (${site.ss.score.grade})\n`;
    md += `**Pages Analyzed:** ${site.ss.meta.totalPages}\n\n`;

    md += "| Category | LH Score | Coverage | Browser Req |\n";
    md += "|----------|----------|----------|-------------|\n";

    for (const cat of site.categories) {
      const lhScore =
        cat.lhScore !== null ? `${Math.round(cat.lhScore * 100)}%` : "--";
      const coverage = `${cat.covered}/${cat.total - cat.browserRequired}`;
      const browserReq = `${cat.browserRequired}`;
      md += `| ${cat.name} | ${lhScore} | ${coverage} | ${browserReq} |\n`;
    }

    md += "\n";

    // Detailed audit comparison
    md += "<details>\n<summary>Detailed Audit Comparison</summary>\n\n";

    for (const cat of site.categories) {
      md += `#### ${cat.name}\n\n`;
      md +=
        "| Lighthouse Audit | SquirrelScan Rule | LH Issues | SS Issues | Status |\n";
      md +=
        "|------------------|-------------------|-----------|-----------|--------|\n";

      for (const audit of cat.audits) {
        const ssRules = audit.browserRequired
          ? "🔌 Browser required"
          : audit.ssRuleIds?.join(", ") || "❌ Not covered";
        const status = audit.browserRequired
          ? "⏭️"
          : audit.covered
            ? "✅"
            : "❌";
        md += `| ${audit.lhAuditId} | ${ssRules} | ${audit.lhIssueCount} | ${audit.ssIssueCount} | ${status} |\n`;
      }
      md += "\n";
    }

    md += "</details>\n\n";
  }

  // Full mapping reference
  md += "## Full Mapping Reference\n\n";
  md += "| Lighthouse Audit | SquirrelScan Rule(s) | Status |\n";
  md += "|------------------|----------------------|--------|\n";

  for (const [lhId, ssIds] of Object.entries(LIGHTHOUSE_TO_SQUIRRELSCAN)) {
    const status =
      ssIds === null
        ? "🔌 Browser"
        : ssIds.length > 0
          ? "✅ Covered"
          : "❌ Missing";
    const rules =
      ssIds === null ? "--" : ssIds.length > 0 ? ssIds.join(", ") : "--";
    md += `| ${lhId} | ${rules} | ${status} |\n`;
  }

  md += "\n---\n\n";
  md += `*Generated by compare-lighthouse.ts on ${new Date().toISOString()}*\n`;

  return md;
}

// Main
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const forceRefresh = args.includes("--refresh");
  const generateMd = args.includes("--markdown");
  const singleSite = args.find((a) => !a.startsWith("--"));

  const sitesToRun = singleSite
    ? SITES.filter(
        (s) => s.domain === singleSite || s.domain.includes(singleSite)
      )
    : SITES;

  if (sitesToRun.length === 0) {
    console.error(`Site not found: ${singleSite}`);
    console.log("Available sites:", SITES.map((s) => s.domain).join(", "));
    process.exit(1);
  }

  console.log("\n" + "=".repeat(60));
  console.log("LIGHTHOUSE VS SQUIRRELSCAN COMPARISON");
  console.log("=".repeat(60));
  console.log(`\nSites: ${sitesToRun.map((s) => s.domain).join(", ")}`);
  console.log(`Force refresh: ${forceRefresh}`);
  console.log(`Generate markdown: ${generateMd}\n`);

  ensureDir(DATA_DIR);

  const comparisons: SiteComparison[] = [];

  for (const site of sitesToRun) {
    console.log(`\n📊 Analyzing ${site.domain}...`);

    const lhPath = join(DATA_DIR, site.domain, "lighthouse.json");
    const ssPath = join(DATA_DIR, site.domain, "squirrelscan.json");

    try {
      // Run audits (parallel where possible)
      await runLighthouse(site.url, lhPath, forceRefresh);
      await runSquirrelScan(site.url, ssPath, forceRefresh);

      // Parse results
      const lh = parseLighthouseResult(lhPath);
      const ss = parseSquirrelScanResult(ssPath);

      // Compare
      const comparison = compareSite(site.domain, site.url, lh, ss);
      comparisons.push(comparison);

      console.log(`   ✅ Analysis complete`);
    } catch (error) {
      console.error(`   ❌ Failed to analyze ${site.domain}: ${error}`);
    }
  }

  // Print summary
  printSummary(comparisons);

  // Generate markdown report
  if (generateMd || comparisons.length > 0) {
    const mdReport = generateMarkdownReport(comparisons);
    const mdPath = join(DATA_DIR, "report.md");
    writeFileSync(mdPath, mdReport);
    console.log(`\n📄 Markdown report: ${mdPath}`);
  }

  console.log("\n✅ Comparison complete!\n");
}

main().catch(console.error);
