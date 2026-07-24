/**
 * Report formatters for benchmark output
 */

import type { BenchmarkReport, SiteBenchmark } from "./types";

import { LIGHTHOUSE_TO_SQUIRRELSCAN } from "./mapping";

/**
 * Print summary table to console
 */
export function printSummary(sites: SiteBenchmark[]): void {
  console.log("\n" + "=".repeat(80));
  console.log("LIGHTHOUSE (PSI) VS SQUIRRELSCAN BENCHMARK");
  console.log("=".repeat(80) + "\n");

  for (const site of sites) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Site: ${site.domain}`);
    console.log(`Strategy: ${site.strategy}`);
    console.log(`${"─".repeat(60)}`);
    console.log(
      `SquirrelScan: ${site.ssScore}% (${site.ss.score.grade}), ${site.ss.meta.totalPages} pages`
    );
    console.log(
      `Issues: ${site.ss.summary.failed} errors, ${site.ss.summary.warnings} warnings, ${site.ss.summary.passed} passed\n`
    );

    console.log(
      "| Category        | LH Score | SS Score | Coverage | Concordance |"
    );
    console.log(
      "|-----------------|----------|----------|----------|-------------|"
    );

    for (const cat of site.categories) {
      const lhScore =
        cat.lhScore !== null ? `${Math.round(cat.lhScore * 100)}%` : "--";
      const ssScore = `${site.ssScore}%`;
      const coverage = `${cat.covered}/${cat.total - cat.browserRequired}`;
      const concordance = `${Math.round(cat.concordanceRate * 100)}%`;

      console.log(
        `| ${cat.name.padEnd(15)} | ${lhScore.padStart(8)} | ${ssScore.padStart(8)} | ${coverage.padStart(8)} | ${concordance.padStart(11)} |`
      );
    }
  }

  // Overall coverage summary
  printMappingSummary();
}

/**
 * Print mapping coverage summary
 */
function printMappingSummary(): void {
  console.log("\n" + "=".repeat(80));
  console.log("MAPPING COVERAGE");
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

/**
 * Print gap analysis
 */
export function printGapAnalysis(report: BenchmarkReport): void {
  console.log("\n" + "=".repeat(80));
  console.log("GAP ANALYSIS");
  console.log("=".repeat(80) + "\n");

  if (report.gaps.lhOnlyFinds.length > 0) {
    console.log("Lighthouse finds issues, SquirrelScan misses:");
    for (const gap of report.gaps.lhOnlyFinds) {
      console.log(`  - ${gap.auditId}: ${gap.sites.join(", ")}`);
    }
  } else {
    console.log(
      "No gaps where Lighthouse finds issues that SquirrelScan misses."
    );
  }

  console.log();

  if (report.gaps.ssOnlyFinds.length > 0) {
    console.log(
      "SquirrelScan finds issues, Lighthouse misses (deeper crawl advantage):"
    );
    for (const gap of report.gaps.ssOnlyFinds) {
      console.log(`  - ${gap.auditId}: ${gap.sites.join(", ")}`);
    }
  } else {
    console.log(
      "No gaps where SquirrelScan finds issues that Lighthouse misses."
    );
  }
}

/**
 * Print category correlations
 */
export function printCorrelations(report: BenchmarkReport): void {
  console.log("\n" + "=".repeat(80));
  console.log("CATEGORY CORRELATIONS");
  console.log("=".repeat(80) + "\n");

  console.log("| Category        | Pearson r | Concordance | Samples |");
  console.log("|-----------------|-----------|-------------|---------|");

  for (const [name, stats] of Object.entries(report.categoryCorrelations)) {
    const r = stats.pearsonR.toFixed(3);
    const conc = `${Math.round(stats.concordanceRate * 100)}%`;
    console.log(
      `| ${name.padEnd(15)} | ${r.padStart(9)} | ${conc.padStart(11)} | ${String(stats.sampleSize).padStart(7)} |`
    );
  }
}

/**
 * Generate markdown report
 */
export function generateMarkdownReport(report: BenchmarkReport): string {
  let md = "# Lighthouse vs SquirrelScan Benchmark Report\n\n";
  md += `**Generated:** ${report.generated.split("T")[0]}\n`;
  md += `**Strategy:** ${report.strategy}\n\n`;

  // Executive summary
  md += "## Executive Summary\n\n";
  md += `- **Sites tested:** ${report.summary.totalSites}\n`;
  md += `- **Total Lighthouse audits:** ${report.summary.totalAudits}\n`;
  md += `- **Covered by SquirrelScan:** ${report.summary.coveredAudits} (${Math.round((report.summary.coveredAudits / report.summary.totalAudits) * 100)}%)\n`;
  md += `- **Browser-required (skipped):** ${report.summary.browserRequiredAudits}\n`;
  md += `- **Not covered:** ${report.summary.notCoveredAudits}\n\n`;

  // Category correlations
  md += "## Category Correlations\n\n";
  md += "| Category | Pearson r | Concordance | Samples |\n";
  md += "|----------|-----------|-------------|--------|\n";

  for (const [name, stats] of Object.entries(report.categoryCorrelations)) {
    md += `| ${name} | ${stats.pearsonR.toFixed(3)} | ${Math.round(stats.concordanceRate * 100)}% | ${stats.sampleSize} |\n`;
  }
  md += "\n";

  // Gap analysis
  md += "## Gap Analysis\n\n";

  md +=
    "> **Note on mobile-responsive sites:** Lighthouse (PSI) uses mobile strategy by default,\n";
  md +=
    "> which may follow mobile redirects (e.g., example.com → example.com/m/). SquirrelScan\n";
  md +=
    "> uses desktop user-agent for broader compatibility. This can cause false gaps when sites\n";
  md +=
    "> serve different content to mobile vs desktop (e.g., techmeme.com redirects mobile to /m/\n";
  md +=
    "> with different HTML, different viewport settings, and missing doctype).\n\n";

  if (report.gaps.lhOnlyFinds.length > 0) {
    md += "### Lighthouse Only (potential SS improvements)\n\n";
    for (const gap of report.gaps.lhOnlyFinds) {
      md += `- **${gap.auditId}**: ${gap.sites.join(", ")}\n`;
    }
    md += "\n";
  }

  if (report.gaps.ssOnlyFinds.length > 0) {
    md += "### SquirrelScan Only (deeper crawl advantage)\n\n";
    for (const gap of report.gaps.ssOnlyFinds) {
      md += `- **${gap.auditId}**: ${gap.sites.join(", ")}\n`;
    }
    md += "\n";
  }

  // Per-site results
  md += "## Site Results\n\n";

  for (const site of report.sites) {
    md += `### ${site.domain}\n\n`;
    md += `**URL:** ${site.url}\n\n`;
    md += `**SquirrelScan Score:** ${site.ssScore}% (${site.ss.score.grade})\n`;
    md += `**Pages Analyzed:** ${site.ss.meta.totalPages}\n\n`;

    // LH scores
    md += "**Lighthouse Scores:**\n";
    md += `- Performance: ${site.lhScores.performance !== null ? Math.round(site.lhScores.performance * 100) + "%" : "--"}\n`;
    md += `- Accessibility: ${site.lhScores.accessibility !== null ? Math.round(site.lhScores.accessibility * 100) + "%" : "--"}\n`;
    md += `- Best Practices: ${site.lhScores.bestPractices !== null ? Math.round(site.lhScores.bestPractices * 100) + "%" : "--"}\n`;
    md += `- SEO: ${site.lhScores.seo !== null ? Math.round(site.lhScores.seo * 100) + "%" : "--"}\n\n`;

    md += "| Category | LH Score | Coverage | Concordance |\n";
    md += "|----------|----------|----------|-------------|\n";

    for (const cat of site.categories) {
      const lhScore =
        cat.lhScore !== null ? `${Math.round(cat.lhScore * 100)}%` : "--";
      const coverage = `${cat.covered}/${cat.total - cat.browserRequired}`;
      const conc = `${Math.round(cat.concordanceRate * 100)}%`;
      md += `| ${cat.name} | ${lhScore} | ${coverage} | ${conc} |\n`;
    }

    md += "\n";

    // Detailed audit comparison (collapsible)
    md += "<details>\n<summary>Detailed Audit Comparison</summary>\n\n";

    for (const cat of site.categories) {
      md += `#### ${cat.name}\n\n`;
      md +=
        "| Lighthouse Audit | SquirrelScan Rule | LH Issues | SS Issues | Match |\n";
      md +=
        "|------------------|-------------------|-----------|-----------|-------|\n";

      for (const audit of cat.audits) {
        const ssRules = audit.browserRequired
          ? "🔌 Browser required"
          : audit.ssRuleIds?.join(", ") || "❌ Not covered";

        const match =
          audit.concordance === "na"
            ? "⏭️"
            : audit.concordance === "both_pass" ||
                audit.concordance === "both_fail"
              ? "✅"
              : audit.concordance === "lh_only"
                ? "🔴 LH"
                : "🟡 SS";

        md += `| ${audit.lhAuditId} | ${ssRules} | ${audit.lhIssueCount} | ${audit.ssIssueCount} | ${match} |\n`;
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
  md += `*Generated by benchmark-lighthouse.ts on ${report.generated}*\n`;

  return md;
}
