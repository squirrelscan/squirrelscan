// Plain text report output

import type { ReportBranding } from "@squirrelscan/core-contracts";
import type { AuditReport } from "../types";
import { cacheReasonsLabel, cacheStatsSummaryLine } from "../cache-stats";
import { getScoreGrade } from "../scoring";
import { REPORT_TEXT_WRAP_WIDTH } from "../constants";
import { groupIssuesByCategory, groupCategoriesByGroup } from "../grouping";
import { affectedPages } from "../affected-pages";
import { groupTechnologies, techChangeSummary } from "../technologies";
import { SITE_PROFILE_NOTE, siteProfileFlags, siteProfileRows } from "../site-metadata";
import { EDITOR_SUMMARY_NOTE } from "../editor-summary";
import { getGroupName, getSubcategoryName, severityLabel } from "../categories";
import {
  carriedTag,
  coverageLine,
  fetchFallbacksLine,
  fullScanHint,
  scanScopeLine,
} from "../coverage";
import { wrapText } from "../utils";
import { lockedRulesMessage } from "../locked-rules";

export interface TextRenderOptions {
  version?: string;
  /** White-label branding (#810) — Team orgs drop the squirrelscan header/footer. */
  branding?: ReportBranding;
}

function pathOnly(url: string): string {
  try {
    const u = new URL(url);
    return u.search ? `${u.pathname}${u.search}` : u.pathname;
  } catch {
    return url;
  }
}

function formatHealthScoreText(score: AuditReport["healthScore"]): string {
  if (!score) return "";
  const lines: string[] = [];
  lines.push(
    score.overall === null
      ? "Health Score: N/A (no auditable pages)"
      : `Health Score: ${score.overall}/100 (${getScoreGrade(score.overall)})`,
  );
  lines.push("");
  // Group Breakdown (#626): the 4 top-level groups, above the finer categories.
  const groups = score.groups ?? [];
  if (groups.length > 0) {
    lines.push("Group Breakdown:");
    lines.push("-".repeat(50));
    for (const g of groups) {
      const bar = "█".repeat(Math.floor(g.score / 10)) + "░".repeat(10 - Math.floor(g.score / 10));
      // Name derives from the group CODE (not the stored name) so renames
      // apply to already-stored reports.
      lines.push(`${getGroupName(g.group).padEnd(20)} ${bar} ${g.score}%`);
      lines.push(`  Passed: ${g.passed} | Warnings: ${g.warnings} | Failed: ${g.failed}`);
    }
    lines.push("");
  }
  if (score.categories.length > 0) {
    lines.push("Category Breakdown:");
    lines.push("-".repeat(50));
    for (const cat of score.categories) {
      const bar =
        "█".repeat(Math.floor(cat.score / 10)) + "░".repeat(10 - Math.floor(cat.score / 10));
      lines.push(`${cat.name.padEnd(20)} ${bar} ${cat.score}%`);
      lines.push(`  Passed: ${cat.passed} | Warnings: ${cat.warnings} | Failed: ${cat.failed}`);
    }
    lines.push("");
  }
  lines.push(
    `Total: ${score.passedCount} passed, ${score.warningCount} warnings, ${score.errorCount} errors`,
  );
  return lines.join("\n");
}

export function renderText(report: AuditReport, options?: TextRenderOptions): string {
  const lines: string[] = [];
  const version = options?.version ?? "";
  const whiteLabel = options?.branding?.whiteLabel ?? false;
  const write = (line = "") => {
    lines.push(line);
  };

  // White-label drops the "SquirrelScan" title in favour of the org name (or a
  // neutral "Audit Report") so the text export carries no squirrelscan branding.
  const titleBase = whiteLabel ? (options?.branding?.orgName ?? "Audit Report") : "SquirrelScan";
  write(`${titleBase}${version ? ` v${version}` : ""}`);
  write("=".repeat(60));
  write(`Auditing: ${report.baseUrl}`);
  write(`Crawled ${report.totalPages} pages`);
  const scope = scanScopeLine(report);
  if (scope) write(scope);
  const cov = coverageLine(report);
  if (cov) write(cov);
  const hint = fullScanHint(report);
  if (hint) write(hint);
  const fallbacks = fetchFallbacksLine(report);
  if (fallbacks) write(fallbacks);
  write("");

  // Editor's summary — report-only (Pro exec-email narrative; not part of the score).
  // Surfaced at the very top of the report, before the health score.
  if (report.editorSummary) {
    const es = report.editorSummary;
    write("EDITOR'S SUMMARY");
    write("-".repeat(40));
    write(EDITOR_SUMMARY_NOTE);
    write("");
    for (const para of es.prose.split(/\n{2,}/)) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      for (const line of wrapText(trimmed, REPORT_TEXT_WRAP_WIDTH)) write(line);
      write("");
    }
    if (es.bigTicket.length > 0) {
      write("Big-ticket items:");
      for (const item of es.bigTicket) write(`  - ${item}`);
      write("");
    }
    if (es.verdict) {
      write(`Verdict: ${es.verdict}`);
      write("");
    }
  }

  // Failed/blocked audit (#489): show the state, never a "0/100 (F)" grade.
  // #792: a block is the SITE refusing our crawler, not our infra; say so and
  // give actionable next steps.
  if (report.status === "failed" || report.status === "blocked") {
    const blocked = report.status === "blocked";
    write(blocked ? "AUDIT BLOCKED" : "AUDIT FAILED");
    if (blocked) {
      write(
        "Your site refused the crawler before any pages could be read (403/429 from bot protection, a firewall, an auth wall, or rate limiting). This is a block on your side, not a squirrelscan outage.",
      );
      write(
        "To get a full audit: allowlist the squirrelscan crawler, turn off bot fight mode for the audit, or run it from a trusted network.",
      );
    } else {
      write(
        report.statusReason ??
          "No pages could be fetched from this site, so there was nothing to audit. Check that the site is reachable and try again.",
      );
    }
    write("");
  } else if (report.healthScore) {
    write(formatHealthScoreText(report.healthScore));
    write("");
  }

  // Site profile — report-only (Stage-0 context; never part of the score).
  if (report.siteMetadata) {
    write("SITE PROFILE");
    write("-".repeat(40));
    write(SITE_PROFILE_NOTE);
    write("");
    for (const row of siteProfileRows(report.siteMetadata)) {
      const value = row.url ? `${row.value} (${row.url})` : row.value;
      write(`${row.label.padEnd(12)} ${value}`);
    }
    const flags = siteProfileFlags(report.siteMetadata);
    if (flags) write(`Flags: ${flags}`);
    write("");
  }

  // Technologies — report-only (no logos possible in plain text; emoji + name).
  if (report.technologies && report.technologies.items.length > 0) {
    const tech = report.technologies;
    write("TECHNOLOGIES");
    write("-".repeat(40));
    const summary = techChangeSummary(tech);
    if (summary) write(summary);
    write("(informational — not part of the score)");
    write("");
    for (const group of groupTechnologies(tech.items)) {
      const names = group.items
        .map((t) => `${t.name}${t.version ? ` v${t.version}` : ""}`)
        .join(", ");
      write(`${group.emoji} ${group.label}: ${names}`);
    }
    write("");
  }

  write("SUMMARY");
  write("-".repeat(40));
  write(`Passed: ${report.passed}`);
  write(`Warnings: ${report.warnings}`);
  write(`Failed: ${report.failed}`);
  // Per-group scores (#626) so agent-experience standing (and the other 3
  // groups) is visible right in the summary, not just down in category detail.
  for (const g of report.healthScore?.groups ?? []) {
    write(`${getGroupName(g.group)}: ${g.score}/100`);
  }
  write("");
  // Subtle cache metadata line — not given equal weight to the summary counts;
  // only present on incremental re-audits with reuse (informational, not scored).
  if (report.cacheStats) {
    const cs = report.cacheStats;
    const byReason = cacheReasonsLabel(cs);
    write(`${cacheStatsSummaryLine(cs)}${byReason ? ` — ${byReason}` : ""}`);
    write("");
  }

  const categoryIssues = groupIssuesByCategory(report.ruleResults);
  // Group → category → rules (#626): issues nest under their top-level group.
  const groupedIssues = groupCategoriesByGroup(categoryIssues);

  if (categoryIssues.length > 0) {
    write("ISSUES");
    write("-".repeat(40));
    write("");

    for (const group of groupedIssues) {
      write(`=== ${group.name.toUpperCase()} ===`);
      write("");

      // Skip the category header when the group has a single category (#626):
      // the group heading above already names it (avoids "=== PERF ===" / "[PERF]").
      const showCatHeader = group.categories.length > 1;
      for (const category of group.categories) {
        if (showCatHeader) {
          write(`[${category.name.toUpperCase()}]`);
          write("");
        }

        const hasSub = category.rules.some((r) => r.subcategory);
        let lastSub: string | undefined;
        for (const rule of category.rules) {
          if (hasSub && rule.subcategory !== lastSub) {
            lastSub = rule.subcategory;
            if (rule.subcategory) {
              write(`  ${getSubcategoryName(rule.subcategory)}`);
              write("");
            }
          }
          write(`  [${severityLabel(rule.severity)}] ${rule.id} - ${rule.name}`);
          if (rule.description) write(`  Description: ${rule.description}`);
          if (rule.solution) {
            const wrapped = wrapText(rule.solution, REPORT_TEXT_WRAP_WIDTH);
            write(`  Solution: ${wrapped[0]}`);
            for (const line of wrapped.slice(1)) write(`            ${line}`);
          }
          write("");

          for (const check of rule.checks) {
            // #1023 R-F: authoritative page count (true pre-sample total) + the
            // union sample (pages + item page-refs), labeled examples when clipped.
            const { sample, count, hasMore } = affectedPages(check);
            const countStr = count > 1 ? ` (${count} pages)` : "";
            const icon = check.status === "fail" ? "X" : "!";
            write(`    [${icon}] ${check.name}: ${check.message}${countStr}${carriedTag(check)}`);

            if (sample.length > 0) {
              for (const page of sample) write(`        -> ${pathOnly(page)}`);
              if (hasMore) write(`        ... and ${count - sample.length} more`);
            }

            if (check.items && check.items.length > 0) {
              for (const item of check.items) {
                const label = item.label ?? item.id;
                write(`        -> ${label}`);
                if (item.snippet) write(`           ${item.snippet}`);
                if (item.sourcePages && item.sourcePages.length > 0) {
                  for (const src of item.sourcePages) write(`            from: ${pathOnly(src)}`);
                }
              }
            }
          }
          write("");
        }
      }
    }
  } else if (report.status !== "failed" && report.status !== "blocked") {
    // #792: don't claim "No issues found" for a 0-page failed/blocked run —
    // nothing was audited (state shown above), the site isn't necessarily clean.
    write("No issues found");
    write("");
  }

  // Cloud-/Pro-gated rules that didn't run this audit (#780) — audience logic
  // shared with the HTML report's LockedRulesSection (#368/#747/#792). Omitted
  // for white-label reports, same as the HTML section (the CTA references
  // squirrelscan signup/credits/dashboard).
  if (!whiteLabel) {
    const locked = lockedRulesMessage(report);
    if (locked) {
      write("CHECKS NOT RUN");
      write("-".repeat(40));
      for (const line of wrapText(locked.action, REPORT_TEXT_WRAP_WIDTH)) write(line);
      if (locked.cta) write(`${locked.cta.label}: ${locked.cta.url}`);
      write("");
      for (const rule of locked.rules) write(`  ${rule.id} — ${rule.name}`);
      write("");
    }
  }

  write("=".repeat(60));
  write(`${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed`);
  // White-label drops the squirrelscan "Generated by" credit line.
  if (!whiteLabel) write("Generated by squirrelscan.com");

  return `${lines.join("\n")}\n`;
}
