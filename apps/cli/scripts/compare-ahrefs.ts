#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface AhrefsIssue {
  filename: string;
  category: "Error" | "Warning" | "Notice";
  issueType: string;
  count: number;
  isLinkFile: boolean;
}

interface SquirrelScanRule {
  ruleId: string;
  severity: "error" | "warning" | "info";
  count: number;
}

interface ComparisonResult {
  site: string;
  ahrefs: {
    totalIssues: number;
    totalIssueTypes: number;
    byCategory: Record<string, number>;
    issues: AhrefsIssue[];
  };
  squirrelscan: {
    totalIssues: number;
    totalRules: number;
    byDomain: Record<string, number>;
    rules: SquirrelScanRule[];
    score: string;
    totalPages: number;
  };
  coverage: {
    detected: string[];
    missing: string[];
    unique: string[];
  };
}

const AHREFS_ROOT = "data/ahrefs";
const REPORT_ROOT = "data/reports/ahrefs-comparison";

const ISSUE_MAPPING: Record<string, string[] | null> = {
  "404_page": ["links/broken-links"],
  "4XX_page": ["links/broken-links"],
  "4XX_page_in_sitemap": ["crawl/sitemap-4xx"],
  Broken_redirect: ["links/broken-links"],
  "3XX_redirect": ["links/redirect-chains"],
  Redirect_chain: ["links/redirect-chains"],
  Canonical_points_to_redirect: ["crawl/canonical-chain"],
  HTTP_to_HTTPS_redirect: ["security/http-to-https"],
  HTTPS_HTTP_mixed_content: ["security/mixed-content"],
  HTTPS_page_links_to_HTTP_image: ["security/mixed-content"],
  Meta_description_tag_missing_or_empty: ["core/meta-description"],
  Meta_description_too_short: ["core/meta-description"],
  Meta_description_too_long: ["core/meta-description"],
  "indexable-Meta_description_tag_missing_or_empty": ["core/meta-description"],
  "indexable-Meta_description_too_short": ["core/meta-description"],
  "indexable-Meta_description_too_long": ["core/meta-description"],
  "indexable-Multiple_meta_description_tags": null,
  Title_too_long: ["core/meta-title"],
  "indexable-Title_too_long": ["core/meta-title"],
  "indexable-Title_too_short": ["core/meta-title"],
  H1_tag_missing_or_empty: ["core/h1"],
  "indexable-H1_tag_missing_or_empty": ["core/h1"],
  Multiple_H1_tags: ["core/h1"],
  "indexable-Multiple_H1_tags": ["core/h1"],
  Open_Graph_tags_missing: ["core/og-tags"],
  Open_Graph_tags_incomplete: ["core/og-tags"],
  "X_(Twitter)_card_missing": ["core/twitter-cards"],
  Page_has_links_to_redirect: ["links/redirect-chains"],
  Page_has_links_to_broken_page: ["links/broken-links"],
  "indexable-Page_has_links_to_redirect": ["links/redirect-chains"],
  "indexable-Page_has_links_to_broken_page": ["links/broken-links"],
  Page_has_no_outgoing_links: ["links/dead-end-pages"],
  "indexable-Page_has_no_outgoing_links": ["links/dead-end-pages"],
  "Orphan_page_(has_no_incoming_internal_links)": ["links/orphan-pages"],
  "indexable-Orphan_page_(has_no_incoming_internal_links)": [
    "links/orphan-pages",
  ],
  Page_has_only_one_dofollow_incoming_internal_link: ["links/orphan-pages"],
  "indexable-Page_has_only_one_dofollow_incoming_internal_link": [
    "links/orphan-pages",
  ],
  Redirected_page_has_no_incoming_internal_links: ["links/orphan-pages"],
  "indexable-Redirected_page_has_no_incoming_internal_links": [
    "links/orphan-pages",
  ],
  Page_has_nofollow_outgoing_internal_links: ["links/nofollow-internal"],
  "indexable-Page_has_nofollow_outgoing_internal_links": [
    "links/nofollow-internal",
  ],
  Page_has_nofollow_incoming_internal_links_only: null,
  "indexable-Page_has_nofollow_incoming_internal_links_only": null,
  Page_has_nofollow_and_dofollow_incoming_internal_links: null,
  "indexable-Page_has_nofollow_and_dofollow_incoming_internal_links": null,
  Indexable_page_not_in_sitemap: ["crawl/sitemap-coverage"],
  Noindex_page_in_sitemap: ["crawl/noindex-in-sitemap"],
  Noindex_page: ["core/robots-meta", "crawl/indexability"],
  Nofollow_page: ["core/robots-meta"],
  Noindex_and_nofollow_page: ["core/robots-meta"],
  "indexable-Canonical_URL_has_no_incoming_internal_links": null,
  "Structured_data_has_schema.org_validation_error": ["schema/json-ld-valid"],
  Low_word_count: ["content/word-count"],
  Slow_page: ["perf/ttfb"],
  Missing_alt_text: ["images/alt-text"],
  Image_file_size_too_large: ["images/image-file-size"],
  CSS_file_size_too_large: ["perf/css-file-size"],
  Pages_to_submit_to_IndexNow: null,
  Organic_traffic_dropped: null,
  Pages_dropped_from_Top_10: null,
  "No._of_referring_domains_dropped": null,
  "indexable-Page_and_SERP_titles_do_not_match": null,
  "indexable-SERP_title_changed": null,
};

function parseAhrefsCSV(filepath: string): number {
  try {
    const buffer = readFileSync(filepath);
    const text = buffer.toString("utf16le");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);

    return Math.max(0, lines.length - 1);
  } catch (error) {
    console.error(`Error parsing ${filepath}:`, error);
    return 0;
  }
}

function extractAhrefsIssues(dataDir: string): AhrefsIssue[] {
  const files = readdirSync(dataDir).filter(
    (f) => f.endsWith(".csv") && f !== "index.csv"
  );

  const issues: AhrefsIssue[] = [];

  for (const file of files) {
    const match = file.match(
      /^(Error|Warning|Notice)-(.+?)(\.csv|-links\.csv)$/
    );
    if (!match) continue;

    const category = match[1] as "Error" | "Warning" | "Notice";
    const issueType = match[2];
    const isLinkFile = file.endsWith("-links.csv");

    const count = parseAhrefsCSV(join(dataDir, file));

    issues.push({
      filename: file,
      category,
      issueType,
      count,
      isLinkFile,
    });
  }

  return issues;
}

function parseSquirrelScanJson(reportPath: string): {
  rules: SquirrelScanRule[];
  score: string;
  totalPages: number;
} {
  const raw = readFileSync(reportPath, "utf8");
  const data = JSON.parse(raw) as {
    meta: { totalPages: number };
    score: { overall: number };
    summary: { passed: number; warnings: number; failed: number };
    issues: Array<{
      ruleId: string;
      severity: "error" | "warning" | "info";
      checks: Array<{ status: "fail" | "warn"; affectedPages: string[] }>;
    }>;
  };

  const rules: SquirrelScanRule[] = [];
  for (const issue of data.issues) {
    const count = issue.checks.reduce(
      (sum, check) => sum + (check.affectedPages?.length ?? 0),
      0
    );
    rules.push({
      ruleId: issue.ruleId,
      severity: issue.severity,
      count,
    });
  }

  return {
    rules,
    score: `${data.score.overall}% pass rate`,
    totalPages: data.meta.totalPages,
  };
}

function mapIssues(ahrefsIssues: AhrefsIssue[]): {
  detected: string[];
  missing: string[];
} {
  const detected: string[] = [];
  const missing: string[] = [];

  const uniqueIssues = new Map<string, AhrefsIssue>();
  for (const issue of ahrefsIssues) {
    if (!issue.isLinkFile) {
      uniqueIssues.set(issue.issueType, issue);
    }
  }

  for (const [issueType, issue] of uniqueIssues) {
    const mapped = ISSUE_MAPPING[issueType];
    if (mapped && mapped.length > 0) {
      detected.push(`${issue.category}: ${issueType}`);
    } else {
      missing.push(`${issue.category}: ${issueType}`);
    }
  }

  return { detected, missing };
}

function identifyUniqueRules(): string[] {
  return [
    "Accessibility: ARIA labels, color contrast, focus indicators, form labels",
    "E-E-A-T: Author byline, expertise signals, citations, about/contact pages",
    "Security: HTTPS, HSTS, CSP, X-Frame-Options, mixed content",
    "AI Analysis: LLM content quality assessment, AI parsability",
    "Legal Compliance: Privacy policy, cookie consent, terms of service",
    "Mobile UX: Tap targets, viewport config, horizontal scroll",
  ];
}

function generateReport(result: ComparisonResult): string {
  let report = "";

  report += "# Ahrefs vs SquirrelScan Comparison Report\n\n";
  report += `## Site: ${result.site}\n\n`;
  report += `**Analysis Date:** ${new Date().toISOString().split("T")[0]}\n\n`;

  report += "## Executive Summary\n\n";
  report += `- **Ahrefs Issues:** ${result.ahrefs.totalIssues} issues across ${result.ahrefs.totalIssueTypes} types\n`;
  report += `- **SquirrelScan Issues:** ${result.squirrelscan.totalIssues} issues across ${result.squirrelscan.totalRules} rule domains\n`;
  report += `- **Pages Analyzed:** ${result.squirrelscan.totalPages}\n`;
  report += `- **Health Score:** ${result.squirrelscan.score}\n`;
  report += `- **Coverage:** ${result.coverage.detected.length}/${result.ahrefs.totalIssueTypes} Ahrefs issue types detected (${Math.round((result.coverage.detected.length / result.ahrefs.totalIssueTypes) * 100)}%)\n`;
  report += `- **Missing:** ${result.coverage.missing.length} Ahrefs issue types not detected\n`;
  report += `- **Unique Advantages:** ${result.coverage.unique.length} SquirrelScan-exclusive capabilities\n\n`;

  report += "## Ahrefs Issue Breakdown\n\n";
  report += "| Category | Count | Issue Types |\n";
  report += "|----------|-------|-------------|\n";
  for (const [category, count] of Object.entries(result.ahrefs.byCategory)) {
    const categoryIssues = result.ahrefs.issues.filter(
      (i) => i.category === category && !i.isLinkFile
    );
    report += `| ${category} | ${count} | ${categoryIssues.length} |\n`;
  }
  report += "\n";

  report += "## SquirrelScan Rule Breakdown\n\n";
  report += "| Rule | Severity | Count |\n";
  report += "|------|----------|-------|\n";
  for (const rule of result.squirrelscan.rules) {
    report += `| ${rule.ruleId} | ${rule.severity} | ${rule.count} |\n`;
  }
  report += "\n";

  report += "## Issue Coverage Matrix\n\n";
  report += "### ✓ Detected by SquirrelScan\n\n";
  for (const issue of result.coverage.detected.sort()) {
    report += `- ${issue}\n`;
  }
  report += "\n";

  report += "### ✗ Missing from SquirrelScan\n\n";
  report +=
    "The following Ahrefs issues are **not currently detected** by SquirrelScan:\n\n";
  for (const issue of result.coverage.missing.sort()) {
    report += `- ${issue}\n`;
  }
  report += "\n";

  report += "## SquirrelScan Unique Advantages\n\n";
  report +=
    "These capabilities are available in SquirrelScan but **not typically covered** by Ahrefs:\n\n";
  for (const advantage of result.coverage.unique) {
    report += `- ${advantage}\n`;
  }
  report += "\n";

  report += "---\n\n";
  report += `*Generated by SquirrelScan comparison tool on ${new Date().toISOString()}*\n`;

  return report;
}

function main() {
  const site = process.argv[2] ?? "nikcub.me";
  const dataDir = join(AHREFS_ROOT, site);
  const reportPath = join(REPORT_ROOT, site, "squirrelscan.json");

  console.log(`\n${"=".repeat(60)}`);
  console.log("AHREFS VS SQUIRRELSCAN COMPARISON");
  console.log(`${"=".repeat(60)}\n`);

  console.log(`Analyzing: ${site}\n`);

  console.log("📊 Parsing Ahrefs CSV files...");
  const ahrefsIssues = extractAhrefsIssues(dataDir);
  const ahrefsByCategory = ahrefsIssues.reduce(
    (acc, issue) => {
      if (!issue.isLinkFile) {
        acc[issue.category] = (acc[issue.category] || 0) + issue.count;
      }
      return acc;
    },
    {} as Record<string, number>
  );
  const totalAhrefsIssues = Object.values(ahrefsByCategory).reduce(
    (sum, count) => sum + count,
    0
  );
  const uniqueAhrefsIssues = ahrefsIssues.filter((i) => !i.isLinkFile).length;

  console.log(`   Found ${ahrefsIssues.length} CSV files`);
  console.log(`   ${uniqueAhrefsIssues} unique issue types`);
  console.log(`   ${totalAhrefsIssues} total issues\n`);

  console.log("🔍 Parsing SquirrelScan report...");
  const { rules, score, totalPages } = parseSquirrelScanJson(reportPath);
  const totalSSIssues = rules.reduce((sum, rule) => sum + rule.count, 0);
  const ssByDomain = rules.reduce(
    (acc, rule) => {
      const domain = rule.ruleId.split("/")[0] ?? "unknown";
      acc[domain] = (acc[domain] || 0) + rule.count;
      return acc;
    },
    {} as Record<string, number>
  );

  console.log(`   ${rules.length} rule categories`);
  console.log(`   ${totalSSIssues} total issues`);
  console.log(`   Score: ${score}\n`);

  console.log("🔗 Mapping issue coverage...");
  const { detected, missing } = mapIssues(ahrefsIssues);
  const unique = identifyUniqueRules();

  console.log(
    `   ✓ Detected: ${detected.length}/${uniqueAhrefsIssues} (${Math.round((detected.length / uniqueAhrefsIssues) * 100)}%)`
  );
  console.log(`   ✗ Missing: ${missing.length}`);
  console.log(`   ★ Unique: ${unique.length}\n`);

  const result: ComparisonResult = {
    site,
    ahrefs: {
      totalIssues: totalAhrefsIssues,
      totalIssueTypes: uniqueAhrefsIssues,
      byCategory: ahrefsByCategory,
      issues: ahrefsIssues,
    },
    squirrelscan: {
      totalIssues: totalSSIssues,
      totalRules: rules.length,
      byDomain: ssByDomain,
      rules,
      score,
      totalPages,
    },
    coverage: {
      detected,
      missing,
      unique,
    },
  };

  console.log("📝 Generating comparison report...");
  const report = generateReport(result);

  const outputPath = join(REPORT_ROOT, `comparison_report_${site}.md`);
  writeFileSync(outputPath, report, "utf8");
  console.log(`   ✓ Report written to ${outputPath}\n`);

  console.log(`${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(60)}\n`);

  console.log(
    `Ahrefs: ${totalAhrefsIssues} issues, ${uniqueAhrefsIssues} types`
  );
  console.log(`SquirrelScan: ${totalSSIssues} issues, ${rules.length} domains`);
  console.log(
    `\nCoverage: ${detected.length}/${uniqueAhrefsIssues} (${Math.round((detected.length / uniqueAhrefsIssues) * 100)}%)`
  );
  console.log(`Missing: ${missing.length} types`);
  console.log(`Unique advantages: ${unique.length} capabilities`);

  console.log("\n✓ Comparison complete!\n");
  console.log(`Read full report: ${outputPath}\n`);
}

main();
