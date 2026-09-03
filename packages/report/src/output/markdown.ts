// Markdown report output

import type { ReportBranding } from "@squirrelscan/core-contracts";
import type { AuditReport } from "../types";
import { cacheReasonsLabel, cacheStatsSummaryLine } from "../cache-stats";
import { getScoreGrade } from "../scoring";
import { REPORT_SOURCE_PAGES_PREVIEW, REPORT_PAGES_HARD_CAP } from "../constants";
import { groupIssuesByCategory, flattenIssuesBySeverity } from "../grouping";
import { groupTechnologies, techChangeSummary, techIconUrl } from "../technologies";
import { SITE_PROFILE_NOTE, siteProfileFlags, siteProfileRows } from "../site-metadata";
import { EDITOR_SUMMARY_NOTE, editorSummaryView } from "../editor-summary";
import { getGroupName, getSubcategoryName, severityLabel } from "../categories";
import {
  carriedTag,
  coverageLine,
  fetchFallbacksLine,
  fullScanHint,
  scanScopeLine,
  seedRedirectLine,
  ruleCarriedRollupLine,
} from "../coverage";
import {
  affectedPages,
  ruleAffectedPageCount,
  ruleCarriedPageCount,
  isRedundantPageItem,
} from "../affected-pages";
import { formatReportDate } from "../utils";
import { getPathname } from "../url";
import { lockedRulesMessage } from "../locked-rules";

export interface MarkdownRenderOptions {
  version?: string;
  /** White-label branding (#810) — Team orgs drop the squirrelscan header/footer. */
  branding?: ReportBranding;
}

function escapeMarkdownTableCell(value: string, escapeBrackets = false): string {
  const output: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\") output.push("\\\\");
    else if (char === "|") output.push("\\|");
    else if (escapeBrackets && (char === "[" || char === "]")) output.push(`\\${char}`);
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && value[i + 1] === "\n") i++;
      output.push("<br>");
    } else output.push(char);
  }
  return output.join("");
}

function escapeMarkdownDestination(value: string): string {
  const output: string[] = [];
  for (const char of value) {
    if (char === "\\") output.push("%5C");
    else if (char === "(") output.push("%28");
    else if (char === ")") output.push("%29");
    else output.push(char);
  }
  return output.join("");
}

/**
 * Neutralize inline markdown syntax so a site-controlled string renders as
 * literal text instead of a link, image, code span, raw HTML tag or emphasis.
 * Every character here is ASCII punctuation, so every one is a valid CommonMark
 * backslash escape and renders as itself.
 *
 * `&` is escaped so a value containing `&#x202E;` cannot be decoded back into
 * the bidi override the URL canonicalization just percent-encoded away.
 *
 * NOT escaped: the scheme colon. GFM autolinks a bare `https://…` and a
 * backslash there does not stop it (verified against remark-gfm), so the cost
 * would be an uglier raw document for no gain. An autolink is limited to
 * http/https/www/mailto, so it cannot produce a `javascript:` link, and the URL
 * is displayed in full either way.
 */
function escapeMarkdownInline(value: string): string {
  const output: string[] = [];
  for (const char of value) {
    if ("\\`*_[]()<>|~&".includes(char)) output.push(`\\${char}`);
    else output.push(char);
  }
  return output.join("");
}

function siteProfileMarkdownValue(value: string, rawUrl?: string): string {
  const label = escapeMarkdownTableCell(value, true);
  if (!rawUrl) return label;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return label;
    const destination = escapeMarkdownDestination(url.toString());
    return `[${label}](${destination})`;
  } catch {
    return label;
  }
}


/**
 * Host list for a rate-limit line: names up to two, then counts the rest.
 * Mirrors the phrasing used in the audit status reason.
 */
function formatRateLimitedHosts(hosts: string[]): string {
  if (hosts.length === 0) return "the host";
  if (hosts.length <= 2) return hosts.join(" and ");
  return `${hosts.slice(0, 2).join(", ")} and ${hosts.length - 2} other host(s)`;
}

export function renderMarkdown(report: AuditReport, options?: MarkdownRenderOptions): string {
  const lines: string[] = [];
  const version = options?.version ?? "";
  const whiteLabel = options?.branding?.whiteLabel ?? false;

  // White-label drops the "squirrelscan" prefix; the org name (when set) titles
  // the report instead.
  lines.push(
    whiteLabel
      ? `# ${options?.branding?.orgName ? `${options.branding.orgName} ` : ""}Audit Report`
      : "# squirrelscan Audit Report",
  );
  lines.push("");
  lines.push(`**URL:** ${report.baseUrl}  `);
  lines.push(`**Date:** ${formatReportDate(report.timestamp)}  `);
  lines.push(`**Pages:** ${report.totalPages}  `);
  // #1829: the caveat on the page count above — coverage lost to throttling.
  if (report.rateLimited && report.rateLimited.pages > 0) {
    lines.push(
      `**Rate limited:** ${report.rateLimited.pages} page(s) not verified (${formatRateLimitedHosts(report.rateLimited.hosts)})  `,
    );
  }
  // #1418: the seed redirected off its own site and the crawler refused to
  // follow it, so the URL above is not where the redirect pointed. Escaped:
  // the redirect target is a string the audited site chose. Deliberately a
  // plain line and not a `>` blockquote — CommonMark lazy continuation would
  // pull every metadata line below it inside the quote.
  const seedRedirect = seedRedirectLine(report);
  if (seedRedirect) lines.push(`${escapeMarkdownInline(seedRedirect)}  `);
  const scope = scanScopeLine(report);
  if (scope) lines.push(`${scope}  `);
  const cov = coverageLine(report);
  if (cov) lines.push(`**${cov}**  `);
  // #190: a plain line for the same reason the seed-redirect disclosure above
  // is one. This used to be `> ${hint}`, and a blockquote CAN interrupt an open
  // paragraph, so the quote opened mid-metadata and CommonMark lazy
  // continuation swallowed every line under it — a partial scan rendered its
  // recovery note and its generator version as part of the warning. Text and
  // HTML both render this hint as a plain line; markdown was the odd one out.
  const hint = fullScanHint(report);
  if (hint) lines.push(`${hint}  `);
  const fallbacks = fetchFallbacksLine(report);
  if (fallbacks) lines.push(`${fallbacks}  `);
  if (version) lines.push(`**Version:** ${version}`);
  lines.push("");

  // Editor's summary — report-only (Pro exec-email narrative), surfaced first.
  const es = editorSummaryView(report.editorSummary);
  if (es) {
    lines.push("## Editor's Summary");
    lines.push("");
    lines.push(`_${EDITOR_SUMMARY_NOTE}_`);
    lines.push("");
    for (const para of es.paragraphs) {
      lines.push(para);
      lines.push("");
    }
    if (es.bigTicket.length > 0) {
      lines.push("**Big-ticket items:**");
      lines.push("");
      for (const item of es.bigTicket) lines.push(`- ${item}`);
      lines.push("");
    }
    if (es.verdict) {
      lines.push(`**Verdict:** ${es.verdict}`);
      lines.push("");
    }
  }

  // Failed/blocked audit (#489): show the state, never a "0/100 (F)" grade.
  // #792: a block is the SITE refusing our crawler, not our infra; say so and
  // give the owner actionable next steps instead of a bare reason line.
  if (report.status === "failed" || report.status === "blocked") {
    const blocked = report.status === "blocked";
    const throttled = !!report.rateLimited && report.rateLimited.pages > 0;
    lines.push(`## ${blocked ? "Audit blocked" : "Audit failed"}`);
    lines.push("");
    if (blocked && throttled) {
      // #1829: throttling and a bot wall both land here with nothing audited,
      // but the fixes are opposite — say which one this was.
      lines.push(
        `${formatRateLimitedHosts(report.rateLimited!.hosts)} rate limited the crawler (429/430) before any pages could be read, so nothing was audited.`,
      );
      lines.push("");
      lines.push("To get a full audit:");
      lines.push("");
      lines.push("- Set `[crawler] per_host_concurrency = 1` and `per_host_delay_ms = 500` in `squirrel.toml`.");
      lines.push("- Raise `[crawler] max_backoff_ms` so the crawl waits longer for the host to recover.");
      lines.push("- Retry when the host is less busy.");
    } else if (blocked) {
      lines.push(
        "Your site refused the crawler before any pages could be read (a 403 or 429 from bot protection, a firewall, an auth wall, or rate limiting). This is a block on your side, not a squirrelscan outage.",
      );
      lines.push("");
      lines.push("To get a full audit:");
      lines.push("");
      lines.push("- Allowlist the squirrelscan crawler in your WAF or bot protection.");
      lines.push("- Turn off bot fight mode (or the blocking rule) for the audit.");
      lines.push("- Run the audit from a trusted network.");
    } else {
      lines.push(
        report.statusReason ??
          "No pages could be fetched from this site, so there was nothing to audit. Check that the site is reachable and try again.",
      );
    }
    lines.push("");
  } else if (report.healthScore) {
    // #1829: a partial run keeps its grade; flag the coverage gap above it.
    if (report.status === "partial" && report.statusReason) {
      lines.push(`> **Partial audit:** ${report.statusReason}`);
      lines.push("");
    }
    lines.push("## Health Score");
    lines.push("");
    lines.push("| Category | Score |");
    lines.push("|----------|-------|");
    const score = report.healthScore.overall;
    lines.push(
      score === null
        ? `| **Overall** | **N/A** |`
        : `| **Overall** | **${score}/100 (${getScoreGrade(score)})** |`,
    );
    // Group scores (#626) — bolded, above the finer categories. Name derives
    // from the group CODE so renames apply to already-stored reports.
    for (const g of report.healthScore.groups ?? []) {
      lines.push(`| **${getGroupName(g.group)}** | **${g.score}/100** |`);
    }
    for (const cat of report.healthScore.categories) {
      lines.push(`| ${cat.name} | ${cat.score}/100 |`);
    }
    lines.push("");
  }

  // Site profile — report-only section (Stage-0 context), never part of the score.
  if (report.siteMetadata) {
    lines.push("## Site Profile");
    lines.push("");
    lines.push(`_${SITE_PROFILE_NOTE}_`);
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("|-------|-------|");
    for (const row of siteProfileRows(report.siteMetadata)) {
      const value = siteProfileMarkdownValue(row.value, row.url);
      lines.push(`| ${row.label} | ${value} |`);
    }
    const flags = siteProfileFlags(report.siteMetadata);
    if (flags) lines.push(`| Flags | ${escapeMarkdownTableCell(flags)} |`);
    lines.push("");
  }

  // Technologies — report-only section, never part of the score. Logos embed
  // via inline <img> (GFM-supported); they degrade to alt text in plain terminals.
  if (report.technologies && report.technologies.items.length > 0) {
    const tech = report.technologies;
    lines.push("## Technologies");
    lines.push("");
    const summary = techChangeSummary(tech);
    lines.push(
      `_Detected tech stack — informational, not part of the score.${summary ? ` ${summary}.` : ""}_`,
    );
    lines.push("");
    for (const group of groupTechnologies(tech.items)) {
      const cells = group.items.map((t) => {
        const url = techIconUrl(t.icon);
        const logo = url ? `<img src="${url}" alt="${t.name}" width="14" height="14" /> ` : "";
        const ver = t.version ? ` \`${t.version}\`` : "";
        return `${logo}${t.name}${ver}`;
      });
      lines.push(`**${group.emoji} ${group.label}**  `);
      lines.push(cells.join(" · "));
      lines.push("");
    }
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Passed:** ${report.passed}`);
  lines.push(`- **Warnings:** ${report.warnings}`);
  lines.push(`- **Failed:** ${report.failed}`);
  // Per-group scores (#626) so agent-experience standing (and the other 3
  // groups) is visible right in the summary, not just down in category detail.
  for (const g of report.healthScore?.groups ?? []) {
    lines.push(`- **${getGroupName(g.group)}:** ${g.score}/100`);
  }
  lines.push("");
  // Subtle cache metadata note — kept out of the summary counts so it doesn't
  // read as a scored figure (informational, not part of the score).
  if (report.cacheStats) {
    const cs = report.cacheStats;
    const byReason = cacheReasonsLabel(cs);
    lines.push(`_${cacheStatsSummaryLine(cs)}${byReason ? ` (${byReason})` : ""}_`);
    lines.push("");
  }
  lines.push("---");
  lines.push("");

  const categoryIssues = groupIssuesByCategory(report.ruleResults);

  if (categoryIssues.length > 0) {
    lines.push("## Issues");
    lines.push("");

    // Severity → category → weight (#1536): one global order under severity
    // headings, so the whole "fix these first" block is contiguous. A category
    // can appear under more than one severity, which is the point.
    const flatIssues = flattenIssuesBySeverity(categoryIssues);
    const subBase = 5;
    let lastSeverity: string | undefined;
    let lastCategory: string | undefined;
    let lastSub: string | undefined;
    for (const rule of flatIssues) {
      if (rule.severity !== lastSeverity) {
        lastSeverity = rule.severity;
        lastCategory = undefined;
        const bucket = flatIssues.filter((r) => r.severity === rule.severity);
        lines.push(`### ${severityLabel(rule.severity, { titleCase: true, plural: true })}`);
        lines.push("");
        lines.push(`*${bucket.length} rule(s)*`);
        lines.push("");
      }
      if (rule.categoryCode !== lastCategory) {
        lastCategory = rule.categoryCode;
        lastSub = undefined;
        lines.push(`#### ${rule.categoryName}`);
        lines.push("");
      }
      const hasSub = Boolean(rule.subcategory);
      if (rule.subcategory && rule.subcategory !== lastSub) {
        lastSub = rule.subcategory;
        lines.push(`${"#".repeat(subBase)} ${getSubcategoryName(rule.subcategory)}`);
        lines.push("");
      }
      const severityBadge =
        rule.severity === "error"
          ? "**[ERROR]**"
          : rule.severity === "warning"
            ? "**[WARN]**"
            : `*[${severityLabel(rule.severity, { titleCase: true })}]*`;
      // Demote one level under a sub-header so the hierarchy stays valid.
      const ruleHeading = "#".repeat(hasSub ? subBase + 1 : subBase);
      lines.push(`${ruleHeading} ${rule.name} ${severityBadge}`);
      lines.push("");
      lines.push(`\`${rule.id}\``);
      lines.push("");

      if (rule.description) {
        lines.push(`> ${rule.description}`);
        lines.push("");
      }

      if (rule.solution) {
        lines.push("**Solution:**");
        lines.push("");
        lines.push(rule.solution);
        lines.push("");
      }

      // #1135: carried-forward rollup + the "clean on every page checked
      // this run, only carried pages still red" note.
      const carriedRollup = ruleCarriedRollupLine(
        ruleCarriedPageCount(rule.checks),
        ruleAffectedPageCount(rule.checks),
      );
      if (carriedRollup) {
        lines.push(`_${carriedRollup}_`);
        lines.push("");
      }
      if (rule.mixedProvenanceNote) {
        lines.push(`_${rule.mixedProvenanceNote}_`);
        lines.push("");
      }

      lines.push("| Check | Status | Message |");
      lines.push("|-------|--------|---------|");
      for (const check of rule.checks) {
        const statusIcon = check.status === "fail" ? "X" : "!";
        const escapedMessage = escapeMarkdownTableCell(check.message + carriedTag(check));
        lines.push(`| ${check.name} | ${statusIcon} ${check.status} | ${escapedMessage} |`);
      }
      lines.push("");

      for (const check of rule.checks) {
        // #1136 review round 3: a site-scope check (blocked-links,
        // duplicate-title, sitemap-*) stores its affected pages ONLY on
        // check.items[].sourcePages, not check.pages — reading check.pages
        // alone left the per-rule rollup above (which DOES use the union)
        // and this per-check list disagreeing: the rollup would say "N of
        // M pages carried" while this block listed zero pages. Uses the
        // SAME checkAffectedPages union html.tsx's PagesList uses.
        // #1023 R-F: count is the AUTHORITATIVE affected-page total (from the
        // shared accessor), the listed pages are a labeled example subset.
        const ap = affectedPages(check);
        if (ap.sample.length > 0) {
          const materialized =
            ap.sample.length > REPORT_PAGES_HARD_CAP
              ? ap.sample.slice(0, REPORT_PAGES_HARD_CAP)
              : ap.sample;
          lines.push(
            `<details><summary><strong>${check.name}:</strong> ${ap.count} page(s) affected</summary>`,
          );
          lines.push("");
          if (ap.count > materialized.length) {
            lines.push(
              `_Showing ${materialized.length} examples of ${ap.count} affected pages._`,
            );
            lines.push("");
          }
          // #1135: per-URL provenance — carriedPages is the exact subset
          // (stamped per check before merging), not inferred from a ratio.
          const carriedPageSet =
            check.carriedPages && check.carriedPages.length > 0
              ? new Set(check.carriedPages)
              : undefined;
          for (const page of materialized) {
            const carried = carriedPageSet?.has(page) ? " (carried)" : "";
            lines.push(`- [${getPathname(page) || "/"}](${page})${carried}`);
          }
          lines.push("");
          lines.push("</details>");
          lines.push("");
        }

        // Items already covered by the unified page list above (a pure
        // page-URL id with no sourcePages) are dropped here so the same
        // URL isn't listed twice; items with sourcePages or a non-URL id
        // (a resource's own identity) keep their row.
        const visibleItems = check.items?.filter((item) => !isRedundantPageItem(item));
        if (visibleItems && visibleItems.length > 0) {
          lines.push(
            `<details><summary><strong>${check.name}:</strong> ${visibleItems.length} item(s)</summary>`,
          );
          lines.push("");
          for (const item of visibleItems) {
            const label = item.label ?? item.id;
            const isUrl =
              item.id.startsWith("http://") ||
              item.id.startsWith("https://") ||
              item.id.startsWith("/");
            const display = isUrl ? `[${label}](${item.id})` : label;
            lines.push(`- ${display}`);
            if (item.sourcePages && item.sourcePages.length > 0) {
              for (const src of item.sourcePages.slice(0, REPORT_SOURCE_PAGES_PREVIEW)) {
                lines.push(`  - from: [${getPathname(src) || "/"}](${src})`);
              }
              if (item.sourcePages.length > REPORT_SOURCE_PAGES_PREVIEW) {
                // The capped preview here is just for per-item context —
                // the full, interactive list is the unified page block
                // above, which already covers this item's sourcePages.
                lines.push(
                  `  - +${item.sourcePages.length - REPORT_SOURCE_PAGES_PREVIEW} more (see full list above)`,
                );
              }
            }
          }
          lines.push("");
          lines.push("</details>");
          lines.push("");
        }
      }

      lines.push("---");
      lines.push("");
    }
  } else if (report.status !== "failed" && report.status !== "blocked") {
    // #792: only claim "No issues found" for a real completed audit. A 0-page
    // failed/blocked run has no issues because nothing was audited (state shown
    // above), not because the site is clean.
    lines.push("## Issues");
    lines.push("");
    lines.push("No issues found.");
    lines.push("");
  }

  // Cloud-/Pro-gated rules that didn't run this audit (#780) — audience logic
  // shared with the HTML report's LockedRulesSection (#368/#747/#792). Omitted
  // for white-label reports, same as the HTML section (the CTA references
  // squirrelscan signup/credits/dashboard).
  if (!whiteLabel) {
    const locked = lockedRulesMessage(report);
    if (locked) {
      lines.push("## Checks not run");
      lines.push("");
      lines.push(
        locked.cta ? `${locked.action} [${locked.cta.label}](${locked.cta.url}).` : locked.action,
      );
      lines.push("");
      for (const rule of locked.rules) {
        lines.push(`- \`${rule.id}\` — ${rule.name}`);
      }
      lines.push("");
    }
  }

  // White-label drops the squirrelscan "Generated by" credit line entirely.
  if (!whiteLabel) {
    lines.push("---");
    lines.push("");
    const versionStr = version ? ` v${version}` : "";
    lines.push(`*Generated by [squirrelscan](https://squirrelscan.com)${versionStr}*`);
  }

  return lines.join("\n");
}
