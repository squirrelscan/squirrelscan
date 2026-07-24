#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface AhrefsIssueDetail {
  filename: string;
  category: "Error" | "Warning" | "Notice";
  issueType: string;
  urls: string[];
}

interface SquirrelScanRuleDetail {
  ruleId: string;
  severity: "error" | "warning" | "info";
  urls: string[];
}

interface DetailedComparison {
  ahrefsType: string;
  ahrefsUrls: string[];
  squirrelscanRules: string[] | null;
  squirrelscanUrls: string[];
  missingUrls: string[];
  extraUrls: string[];
  delta: number;
  analysis: string;
}

interface SiteReport {
  site: string;
  totalPages: number;
  score: string;
  ahrefsTotal: number;
  squirrelscanTotal: number;
  comparisons: DetailedComparison[];
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

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return `${u.origin}${path}${u.search}${u.hash}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, "");
  }
}

function parseAhrefsCSVUrls(filepath: string): string[] {
  try {
    const buffer = readFileSync(filepath);
    const text = buffer.toString("utf16le");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);

    if (lines.length <= 1) return [];

    const urls: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const columns = lines[i].split("\t");
      if (columns.length >= 2) {
        let url = columns[1].trim();
        url = url.replace(/^"/, "").replace(/"$/, "");
        if (url && url.startsWith("http")) {
          urls.push(normalizeUrl(url));
        }
      }
    }

    return urls;
  } catch (error) {
    console.error(`Error parsing ${filepath}:`, error);
    return [];
  }
}

function extractAhrefsIssuesDetailed(dataDir: string): AhrefsIssueDetail[] {
  const files = readdirSync(dataDir).filter(
    (f) => f.endsWith(".csv") && f !== "index.csv"
  );

  const issues: AhrefsIssueDetail[] = [];

  for (const file of files) {
    const match = file.match(
      /^(Error|Warning|Notice)-(.+?)(\.csv|-links\.csv)$/
    );
    if (!match) continue;

    const category = match[1] as "Error" | "Warning" | "Notice";
    const issueType = match[2];
    const isLinkFile = file.endsWith("-links.csv");

    if (isLinkFile) continue;

    const urls = parseAhrefsCSVUrls(join(dataDir, file));

    issues.push({
      filename: file,
      category,
      issueType,
      urls,
    });
  }

  return issues;
}

function parseSquirrelJsonReport(reportPath: string): {
  baseUrl: string;
  totalPages: number;
  score: string;
  rules: Map<string, SquirrelScanRuleDetail>;
} {
  const raw = readFileSync(reportPath, "utf8");
  const data = JSON.parse(raw) as {
    meta: { baseUrl: string; totalPages: number; timestamp: string };
    score: { overall: number; grade: string };
    issues: Array<{
      ruleId: string;
      severity: "error" | "warning" | "info";
      checks: Array<{
        status: "fail" | "warn" | "info" | "pass";
        affectedPages: string[];
        items?: Array<{ id: string }>;
      }>;
    }>;
  };

  const rules = new Map<string, SquirrelScanRuleDetail>();

  for (const issue of data.issues) {
    const urlSet = new Set<string>();

    for (const check of issue.checks) {
      if (check.status !== "fail" && check.status !== "warn") continue;

      for (const page of check.affectedPages ?? []) {
        urlSet.add(normalizeUrl(page));
      }

      for (const item of check.items ?? []) {
        if (typeof item.id === "string") {
          urlSet.add(normalizeUrl(item.id));
        }
      }
    }

    if (urlSet.size > 0) {
      rules.set(issue.ruleId, {
        ruleId: issue.ruleId,
        severity: issue.severity,
        urls: [...urlSet],
      });
    }
  }

  return {
    baseUrl: data.meta.baseUrl,
    totalPages: data.meta.totalPages,
    score: `${data.score.overall}%`,
    rules,
  };
}

function compareIssues(
  ahrefsIssues: AhrefsIssueDetail[],
  squirrelscanRules: Map<string, SquirrelScanRuleDetail>
): DetailedComparison[] {
  const comparisons: DetailedComparison[] = [];

  for (const ahrefsIssue of ahrefsIssues) {
    const mappedRules = ISSUE_MAPPING[ahrefsIssue.issueType] ?? null;

    let squirrelscanUrls: string[] = [];
    if (mappedRules && mappedRules.length > 0) {
      const urlSet = new Set<string>();
      for (const ruleId of mappedRules) {
        const rule = squirrelscanRules.get(ruleId);
        if (!rule) continue;
        for (const url of rule.urls) {
          urlSet.add(normalizeUrl(url));
        }
      }
      squirrelscanUrls = [...urlSet];
    }

    const ahrefsSet = new Set(ahrefsIssue.urls.map(normalizeUrl));
    const squirrelscanSet = new Set(squirrelscanUrls.map(normalizeUrl));

    const missingUrls = [...ahrefsSet].filter(
      (url) => !squirrelscanSet.has(url)
    );
    const extraUrls = [...squirrelscanSet].filter((url) => !ahrefsSet.has(url));

    const delta = ahrefsIssue.urls.length - squirrelscanUrls.length;

    let analysis = "";
    if (!mappedRules) {
      analysis = "No SquirrelScan mapping for this issue";
    } else if (mappedRules.length === 0) {
      analysis = "Mapping exists but no rules assigned";
    } else if (squirrelscanUrls.length === 0) {
      analysis = "Mapped rule(s) returned no URLs (output or detection gap)";
    } else if (delta > 0) {
      analysis = `SquirrelScan missed ${delta} URL(s)`;
    } else if (delta < 0) {
      analysis = `SquirrelScan detected ${Math.abs(delta)} extra URL(s)`;
    } else if (missingUrls.length > 0 || extraUrls.length > 0) {
      analysis = `Different URLs detected - ${missingUrls.length} missed, ${extraUrls.length} extra`;
    } else {
      analysis = "Perfect match";
    }

    comparisons.push({
      ahrefsType: ahrefsIssue.issueType,
      ahrefsUrls: ahrefsIssue.urls,
      squirrelscanRules: mappedRules,
      squirrelscanUrls,
      missingUrls,
      extraUrls,
      delta,
      analysis,
    });
  }

  return comparisons;
}

function generateDetailedReport(siteReports: SiteReport[]): string {
  let report = "";

  report += "# Detailed Ahrefs vs SquirrelScan Multi-Site Comparison\n\n";
  report += `**Generated:** ${new Date().toISOString().split("T")[0]}\n\n`;

  report += "## Executive Summary\n\n";
  const totalSites = siteReports.length;
  const totalPages = siteReports.reduce((sum, r) => sum + r.totalPages, 0);
  const totalAhrefsIssues = siteReports.reduce(
    (sum, r) => sum + r.ahrefsTotal,
    0
  );
  const totalSSIssues = siteReports.reduce(
    (sum, r) => sum + r.squirrelscanTotal,
    0
  );

  const coverageStats = siteReports.flatMap((site) => site.comparisons);
  const mapped = coverageStats.filter((c) => c.squirrelscanRules);
  const unmapped = coverageStats.filter((c) => !c.squirrelscanRules);

  report += `- **Sites Analyzed:** ${totalSites}\n`;
  report += `- **Total Pages Crawled:** ${totalPages}\n`;
  report += `- **Ahrefs Total Issues:** ${totalAhrefsIssues}\n`;
  report += `- **SquirrelScan Total Issues:** ${totalSSIssues}\n`;
  report += `- **Issue Types Mapped:** ${mapped.length}/${coverageStats.length}\n`;
  report += `- **Issue Types Unmapped:** ${unmapped.length}\n\n`;

  report += "## Per-Site Detailed Analysis\n\n";

  for (const siteReport of siteReports) {
    report += `### ${siteReport.site}\n\n`;
    report += `**Pages Crawled:** ${siteReport.totalPages} | **Pass Rate:** ${siteReport.score}\n\n`;

    const missing = siteReport.comparisons.filter(
      (c) =>
        !c.squirrelscanRules || c.squirrelscanUrls.length === 0 || c.delta > 0
    );

    const underDetected = siteReport.comparisons.filter(
      (c) => c.squirrelscanRules && c.delta > 0
    );

    if (missing.length > 0) {
      report += "#### Missing or Under-Detected Issues\n\n";
      for (const comp of missing.sort(
        (a, b) => b.ahrefsUrls.length - a.ahrefsUrls.length
      )) {
        report += `**${comp.ahrefsType.replace(/_/g, " ")}**\n`;
        report += `- **Ahrefs:** ${comp.ahrefsUrls.length} URL(s)\n`;
        report += `- **SquirrelScan:** ${comp.squirrelscanUrls.length} URL(s)\n`;
        report += `- **Mapping:** ${comp.squirrelscanRules?.join(", ") ?? "None"}\n`;
        report += `- **Analysis:** ${comp.analysis}\n`;
        if (comp.missingUrls.length > 0) {
          const showCount = Math.min(comp.missingUrls.length, 5);
          report += `- **Missing URLs (sample):**\n`;
          for (let i = 0; i < showCount; i++) {
            report += `  - ${comp.missingUrls[i]}\n`;
          }
          if (comp.missingUrls.length > 5) {
            report += `  - ... and ${comp.missingUrls.length - 5} more\n`;
          }
        }
        report += "\n";
      }
    }

    if (underDetected.length === 0 && missing.length === 0) {
      report += "No missing or under-detected issues found.\n\n";
    }

    report += "---\n\n";
  }

  report += "## Cross-Site Patterns\n\n";

  const gapCounts = new Map<string, number>();
  for (const site of siteReports) {
    for (const comp of site.comparisons) {
      if (!comp.squirrelscanRules || comp.delta > 0) {
        gapCounts.set(
          comp.ahrefsType,
          (gapCounts.get(comp.ahrefsType) || 0) + 1
        );
      }
    }
  }

  const commonGaps = [...gapCounts.entries()]
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  if (commonGaps.length > 0) {
    report += "### Common Missing Detections (affecting 2+ sites)\n\n";
    for (const [issueType, count] of commonGaps) {
      report += `- **${issueType.replace(/_/g, " ")}** - Missing on ${count}/${totalSites} sites\n`;
    }
    report += "\n";
  }

  report += "## Recommendations\n\n";
  report += "### High-Impact Gaps (No Mapping)\n\n";
  const unmappedIssues = [...gapCounts.entries()]
    .filter(([issueType, _]) => ISSUE_MAPPING[issueType] === null)
    .sort((a, b) => b[1] - a[1]);

  if (unmappedIssues.length > 0) {
    for (const [issueType, count] of unmappedIssues) {
      report += `- **${issueType.replace(/_/g, " ")}** - Missing on ${count} site(s)\n`;
    }
  } else {
    report += "No unmapped issues detected.\n";
  }
  report += "\n";

  report += "### Coverage Gaps (Mapped but Under-Detected)\n\n";
  const underDetectedIssues = [...gapCounts.entries()]
    .filter(([issueType, _]) => ISSUE_MAPPING[issueType])
    .sort((a, b) => b[1] - a[1]);

  if (underDetectedIssues.length > 0) {
    for (const [issueType, count] of underDetectedIssues) {
      report += `- **${issueType.replace(/_/g, " ")}** - Under-detected on ${count} site(s)\n`;
    }
  } else {
    report += "No under-detected issues identified.\n";
  }

  report += "\n---\n\n";
  report += `*Report generated by SquirrelScan comparison tool on ${new Date().toISOString()}*\n`;

  return report;
}

function listSites(): Array<{ domain: string; url: string }> {
  const sites = readdirSync(AHREFS_ROOT).filter(
    (entry) => !entry.startsWith(".")
  );
  return sites.map((domain) => ({ domain, url: `https://${domain}` }));
}

async function main() {
  const sites = listSites();
  const siteReports: SiteReport[] = [];

  console.log(`\n${"=".repeat(70)}`);
  console.log("DETAILED AHREFS VS SQUIRRELSCAN MULTI-SITE COMPARISON");
  console.log(`${"=".repeat(70)}\n`);

  for (const site of sites) {
    console.log(`📊 Analyzing ${site.domain}...`);

    const dataDir = join(AHREFS_ROOT, site.domain);
    const reportPath = join(REPORT_ROOT, site.domain, "squirrelscan.json");

    const ahrefsIssues = extractAhrefsIssuesDetailed(dataDir);
    console.log(`   Ahrefs: ${ahrefsIssues.length} issue types`);

    const squirrelData = parseSquirrelJsonReport(reportPath);
    console.log(`   SquirrelScan: ${squirrelData.rules.size} rule categories`);

    const comparisons = compareIssues(ahrefsIssues, squirrelData.rules);

    const ahrefsTotal = ahrefsIssues.reduce(
      (sum, issue) => sum + issue.urls.length,
      0
    );
    const squirrelscanTotal = [...squirrelData.rules.values()].reduce(
      (sum, rule) => sum + rule.urls.length,
      0
    );

    siteReports.push({
      site: site.domain,
      totalPages: squirrelData.totalPages,
      score: squirrelData.score,
      ahrefsTotal,
      squirrelscanTotal,
      comparisons,
    });

    console.log(
      `   ✓ Compared ${comparisons.length} issue types, ${squirrelData.totalPages} pages\n`
    );
  }

  console.log("📝 Generating detailed report...");
  const report = generateDetailedReport(siteReports);

  const outputPath = join(REPORT_ROOT, "ahrefs-comparison-detailed.md");
  writeFileSync(outputPath, report, "utf8");
  console.log(`   ✓ Report written to ${outputPath}\n`);

  console.log(`${"=".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(70)}\n`);

  const totalPages = siteReports.reduce((sum, r) => sum + r.totalPages, 0);
  const totalAhrefs = siteReports.reduce((sum, r) => sum + r.ahrefsTotal, 0);
  const totalSS = siteReports.reduce((sum, r) => sum + r.squirrelscanTotal, 0);

  console.log(`Sites: ${siteReports.length}`);
  console.log(`Total pages: ${totalPages}`);
  console.log(`Ahrefs issues: ${totalAhrefs}`);
  console.log(`SquirrelScan issues: ${totalSS}`);
  console.log(`\n✓ Detailed comparison complete!\n`);
  console.log(`Read full report: ${outputPath}\n`);
}

main();
