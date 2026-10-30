// Markdown report output

import type { ReportBranding } from "@squirrelscan/core-contracts";
import type { AuditReport } from "../types";
import { AUDIT_FAILURE_NEXT_STEP } from "@squirrelscan/core-contracts/failure-reason";
import { cacheReasonsLabel, cacheStatsSummaryLine } from "../cache-stats";
import { refusedFetchLines, reportFailureReasonCode } from "../failure-notice";
import { wafBlockedPagesLines, wafBlockedSeedCopy, wafSuspectLines } from "../waf-blocked";
import { getScoreGrade } from "../scoring";
import { REPORT_SOURCE_PAGES_PREVIEW, REPORT_PAGES_HARD_CAP } from "../constants";
import { fixRollupLine, fixUnits, ruleFixCoverage } from "../component-presentation";
import {
  ruleSiteResourceCoverage,
  siteResourceFixLine,
  withSiteResourceCoverage,
} from "../site-resource-presentation";

import { uncoveredItems } from "../component-presentation";
import { formatSiteWideItem, siteWideContext, siteWideItem } from "../site-wide-items";
import {
  groupIssuesByCategory,
  flattenIssuesBySeverity,
  passedRuleScope,
  reportPassedRules,
} from "../grouping";
import {
  affectedPagesSuffix,
  hasItemSources,
  itemSourceView,
  moreSourcePages,
  sourceRowText,
} from "../item-sources";
import {
  checkPagesScopedAway,
  checkScopeLine,
  itemLabel,
  regionScopeLine,
} from "../region-scope";
import { entityMarkdownSection } from "../entities";
import {
  structureChromeLine,
  structureDegradedLine,
  structurePageTypesLine,
  structureRows,
  structureNumber,
  structureTotalsLine,
} from "../structure";
import { groupTechnologies, techChangeSummary, techIconUrl } from "../technologies";
import { SITE_PROFILE_NOTE, siteProfileFlags, siteProfileRows } from "../site-metadata";
import { EDITOR_SUMMARY_NOTE, editorSummaryView, priorityEffortLabel } from "../editor-summary";
import { getGroupName, getSubcategoryName, severityLabel } from "../categories";
import {
  carriedTag,
  coverageLine,
  fetchFallbacksLine,
  fullScanHint,
  scanScopeLine,
  publishedReportNote,
  auditLevelLine,
  seedRedirectLine,
  startRedirectLine,
  ruleCarriedRollupLine,
  unfetchedNote,
} from "../coverage";
import { ignoredLine, unusedIgnoreEntries } from "../ignored";
import {
  affectedPages,
  ruleAffectedPageCount,
  ruleCarriedPageCount,
  isRedundantPageItem,
  itemsNotListed,
  itemsNotListedLine,
} from "../affected-pages";
import { formatReportDate } from "../utils";
import { getPathname } from "../url";
import { lockedRulesMessage } from "../locked-rules";
import { privateTargetLine } from "../private-target";
import { notCheckedDetailLines } from "../not-checked";
import {
  escapeHtmlText,
  escapeMarkdownCell,
  escapeMarkdownDestination,
  escapeMarkdownText,
  markdownCodeSpan,
  markdownLink,
} from "./markdown-escape";

/** repo#2661: ", N more not listed" when the report left items out of a check. */
function notListedSuffix(check: Parameters<typeof itemsNotListed>[0]): string {
  const left = itemsNotListed(check);
  return left > 0 ? `, ${left.toLocaleString("en-US")} more not listed` : "";
}

export interface MarkdownRenderOptions {
  /** Roll up groups that are one repair (default true). */
  componentRollup?: boolean;
  /** Collapse site-wide items into one line (default true). */
  siteWideCollapse?: boolean;
  version?: string;
  /** White-label branding (#810) — Team orgs drop the squirrelscan header/footer. */
  branding?: ReportBranding;
  /** List the rules that passed after the issues (`--include-passed`). */
  includePassed?: boolean;
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
/** Collapse a value to one line so a blank line in it cannot end a list item early. */
function oneMdLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * A line-leading block marker (heading, list, numbered list, quote) rendered
 * as text, for a value that starts a line of its own. Twin of
 * `escapeBlockStart` in the cloud's report-markdown template.
 */
function escapeBlockStart(value: string): string {
  return value.replace(/^([#+>-])/, "\\$1").replace(/^(\d+)([.)])/, "$1\\$2");
}

/**
 * The white-label footer line: the org's footer text, escaped, then its
 * website as an autolink. Only an https URL with nothing in it that could
 * close the autolink is shown. Null when neither is set. Twin of the cloud's
 * report-markdown template.
 */
function whiteLabelFooterLine(branding: ReportBranding | undefined): string | null {
  const parts: string[] = [];
  if (branding?.footerText) parts.push(escapeMarkdownInline(oneMdLine(branding.footerText)));
  const website = branding?.websiteUrl;
  if (website && /^https:\/\//i.test(website) && !/[\s<>]/.test(website)) {
    parts.push(`<${website}>`);
  }
  return parts.length > 0 ? escapeBlockStart(parts.join(" · ")) : null;
}

function escapeMarkdownInline(value: string): string {
  const output: string[] = [];
  for (const char of value) {
    if ("\\`*_[]()<>|~&".includes(char)) output.push(`\\${char}`);
    else output.push(char);
  }
  return output.join("");
}

function siteProfileMarkdownValue(value: string, rawUrl?: string): string {
  const label = escapeMarkdownCell(value);
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

/**
 * A not-checked notice as list-item content. It opens with a rule name, which a stored report can
 * set to anything, so a name like `1` or `# x` would open a nested list or a heading. The
 * block-opening character is escaped; the rest goes through the inline escaper.
 */
function escapeListItem(value: string): string {
  const text = escapeMarkdownInline(value);
  return text.replace(/^(\d+)([.)])/, "$1\\$2").replace(/^([#>+-])/, "\\$1");
}

/**
 * The scope and coverage notes that qualify the score, one plain list item each. They used to run
 * under the title; they are run metadata, so they close the report instead.
 */
function scanDetailLines(report: AuditReport): string[] {
  const out: string[] = [];
  // #1829: coverage lost to throttling.
  if (report.rateLimited && report.rateLimited.pages > 0) {
    out.push(
      `Rate limited: ${report.rateLimited.pages} page(s) not verified (${formatRateLimitedHosts(report.rateLimited.hosts)})${unfetchedNote(report.rateLimited.unfetched)}`,
    );
  }
  // #1418: the seed redirected off its own site and the crawler refused to follow it, so the URL at
  // the top is not where the redirect pointed. Escaped: the redirect target is a string the audited
  // site chose.
  const seedRedirect = seedRedirectLine(report);
  if (seedRedirect) out.push(escapeMarkdownInline(seedRedirect));
  // #1281: the start URL redirected and the redirect was followed.
  const startRedirect = startRedirectLine(report);
  if (startRedirect) out.push(escapeMarkdownInline(startRedirect));
  // #1262: findings the config's [[ignore]] entries waived, and entries that matched nothing.
  const ignored = ignoredLine(report);
  if (ignored) out.push(escapeMarkdownInline(ignored));
  for (const entry of unusedIgnoreEntries(report)) {
    out.push(escapeMarkdownInline(`Ignore entry ${entry.index + 1} (${entry.rule}) matched nothing.`));
  }
  const scope = scanScopeLine(report);
  if (scope) out.push(scope);
  // repo#2661: a capped published report lists samples; say so, and where the rest is. Not
  // escaped: the note is our own text and its backticks are meant as code.
  const capped = publishedReportNote(report);
  if (capped) out.push(capped);
  const level = auditLevelLine(report);
  if (level) out.push(level);
  const cov = coverageLine(report);
  if (cov) out.push(cov);
  // pub#629: the score's other basis line, the rules a private host skipped.
  const privateTarget = privateTargetLine(report);
  if (privateTarget) out.push(privateTarget);
  const hint = fullScanHint(report);
  if (hint) out.push(hint);
  const fallbacks = fetchFallbacksLine(report);
  if (fallbacks) out.push(fallbacks);
  return out;
}

/** The Page structure block (#2307), as lines under a "###" heading. Empty without a block. */
function structureLines(report: AuditReport): string[] {
  const structure = report.structure;
  if (!structure) return [];
  const lines: string[] = ["### Page structure", ""];
  const typesLine = structurePageTypesLine(structure);
  if (typesLine) {
    lines.push(typesLine);
    lines.push("");
  }
  const rows = structureRows(structure);
  if (rows.length > 0) {
    lines.push("| Section | Pages | Links |");
    lines.push("|---------|------:|------:|");
    for (const row of rows) {
      lines.push(
        `| ${row.section} | ${structureNumber(row.pages)} | ${structureNumber(row.links)} |`,
      );
    }
    lines.push("");
  }
  const totals = structureTotalsLine(structure);
  if (totals) {
    lines.push(totals);
    lines.push("");
  }
  const chromeLine = structureChromeLine(structure);
  if (chromeLine) {
    lines.push(chromeLine);
    lines.push("");
  }
  const degradedLine = structureDegradedLine(structure);
  if (degradedLine) {
    lines.push(degradedLine);
    lines.push("");
  }
  return lines;
}

/**
 * Report detail: the last section of the report. What this audit did not check (so a skipped check
 * never reads as clean), the page structure, then the scope and coverage notes. Empty when there is
 * nothing to say, so a report with none of these ends where it always did.
 */
function reportDetailLines(report: AuditReport): string[] {
  const notChecked = notCheckedDetailLines(report);
  const structure = structureLines(report);
  const scan = scanDetailLines(report);
  if (notChecked.length === 0 && structure.length === 0 && scan.length === 0) return [];

  const lines: string[] = ["## Report detail", ""];
  if (notChecked.length > 0) {
    lines.push("### Not checked", "");
    // Escaped: a published report's messages come from whoever published it.
    for (const line of notChecked) lines.push(`- ${escapeListItem(line)}`);
    lines.push("");
  }
  lines.push(...structure);
  if (scan.length > 0) {
    lines.push("### Scan details", "");
    for (const line of scan) lines.push(`- ${line}`);
    lines.push("");
  }
  return lines;
}

export function renderMarkdown(report: AuditReport, options?: MarkdownRenderOptions): string {
  const lines: string[] = [];
  const siteWide = siteWideContext(report, options?.siteWideCollapse !== false);
  const version = options?.version ?? "";
  const whiteLabel = options?.branding?.whiteLabel ?? false;

  // White-label drops the "squirrelscan" prefix; the org name (when set) titles
  // the report instead.
  lines.push(
    whiteLabel
      ? `# ${options?.branding?.orgName ? `${escapeMarkdownInline(options.branding.orgName)} ` : ""}Audit Report`
      : "# squirrelscan Audit Report",
  );
  lines.push("");
  // #3522: escaped, like every value below that a site or a stored report chose.
  lines.push(`**URL:** ${escapeMarkdownText(report.baseUrl)}  `);
  lines.push(`**Date:** ${formatReportDate(report.timestamp)}  `);
  lines.push(`**Pages:** ${report.totalPages}  `);
  if (version) lines.push(`**Version:** ${version}`);
  lines.push("");

  // Editor's summary — report-only (Pro exec-email narrative), surfaced first.
  const es = editorSummaryView(report.editorSummary, report);
  if (es) {
    lines.push("## Editor's Summary");
    lines.push("");
    lines.push(`_${EDITOR_SUMMARY_NOTE}_`);
    lines.push("");
    // Model-authored and site-influenced: escaped like every other value here.
    for (const para of es.paragraphs) {
      lines.push(escapeMarkdownInline(para));
      lines.push("");
    }
    if (es.priorities.length === 0 && es.bigTicket.length > 0) {
      lines.push("**Big-ticket items:**");
      lines.push("");
      for (const item of es.bigTicket) lines.push(`- ${escapeMarkdownInline(oneMdLine(item))}`);
      lines.push("");
    }
    if (es.verdict) {
      lines.push(`**Verdict:** ${escapeMarkdownInline(oneMdLine(es.verdict))}`);
      lines.push("");
    }
  }

  // Ranked priorities from the editor's summary, as their own section.
  if (es && es.priorities.length > 0) {
    lines.push("## Priorities");
    lines.push("");
    for (const [i, p] of es.priorities.entries()) {
      lines.push(
        `${i + 1}. **${escapeMarkdownInline(p.title)}** (${priorityEffortLabel(p.effort)})`,
      );
      // Trailing two spaces: a hard break, so why and action stay separate lines.
      if (p.why) lines.push(`   ${escapeMarkdownInline(oneMdLine(p.why))}  `);
      lines.push(`   ${escapeMarkdownInline(oneMdLine(p.action))}`);
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
    const wafSeed = wafBlockedSeedCopy(report);
    if (wafSeed) {
      // #1253: a WAF or bot manager served a challenge or block page instead of
      // the site. Fields are sanitised in wafBlockedSeedCopy and escaped here.
      lines.push(escapeMarkdownInline(wafSeed.headline));
      lines.push("");
      lines.push(`${escapeMarkdownInline(wafSeed.saw)} Code: \`${wafSeed.code}\`.`);
      lines.push("");
      lines.push("To get a full audit:");
      lines.push("");
      for (const remedy of wafSeed.remedies) lines.push(`- ${remedy}`);
    } else if (blocked && throttled) {
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
      // #1822: reason line, then the next step for that failure class.
      const code = reportFailureReasonCode(report);
      if (report.statusReason) {
        // ESCAPED, not trusted. The reason embeds a fragment the audited origin
        // influenced (a certificate error, a redirect target), and this renders
        // STORED reports of every vintage, including ones published before the
        // sanitizer in core-contracts existed. A bare `>` here would turn the
        // rest of the section into a blockquote.
        lines.push(escapeMarkdownInline(report.statusReason));
        lines.push("");
      }
      lines.push(AUDIT_FAILURE_NEXT_STEP[code]);
    }
    // Name what was refused, so a missing robots.txt or sitemap reads as
    // "the site would not say" and never as "the site has none".
    const refused = refusedFetchLines(report);
    if (refused.length > 0) {
      lines.push("");
      lines.push("Refused by the site (not checked, so not reported as missing):");
      lines.push("");
      for (const line of refused) lines.push(`- ${escapeMarkdownInline(line)}`);
    }
    lines.push("");
  } else if (report.healthScore) {
    // #1829: a partial run keeps its grade; flag the coverage gap above it.
    if (report.status === "partial" && report.statusReason) {
      // Escaped like the Failed branch's reason above, for the same reason (#3522).
      lines.push(`> **Partial audit:** ${escapeMarkdownText(report.statusReason)}`);
      lines.push("");
    }
    // #1253: pages a WAF or bot manager blocked. Never audited, never scored.
    const blockedPageLines = wafBlockedPagesLines(report);
    if (blockedPageLines.length > 0) {
      const [summary, ...listed] = blockedPageLines;
      lines.push(`> **Blocked pages:** ${escapeMarkdownText(summary!)}`);
      lines.push("");
      for (const line of listed) lines.push(`- ${escapeMarkdownInline(line)}`);
      if (listed.length > 0) lines.push("");
    }
    // #1258: pages that look like a provider's refusal. Audited, but flagged.
    const suspectLines = wafSuspectLines(report);
    if (suspectLines.length > 0) {
      const [summary, ...listed] = suspectLines;
      lines.push(`> **Suspect pages:** ${escapeMarkdownText(summary!)}`);
      lines.push("");
      for (const line of listed) lines.push(`- ${escapeMarkdownInline(line)}`);
      if (listed.length > 0) lines.push("");
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
    if (flags) lines.push(`| Flags | ${escapeMarkdownCell(flags)} |`);
    lines.push("");
  }

  // Technologies — report-only section, never part of the score. Logos embed
  // via inline <img> (GFM-supported); they degrade to alt text in plain terminals.
  if (report.technologies && (report.technologies.items.length > 0 || report.technologies.truncated)) {
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
        const logo = url
          ? `<img src="${url}" alt="${escapeHtmlText(t.name)}" width="14" height="14" /> `
          : "";
        // The version is read off the audited site (#3522): fenced so it cannot close the span.
        const ver = t.version ? ` ${markdownCodeSpan(t.version)}` : "";
        return `${logo}${escapeMarkdownText(t.name)}${ver}`;
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

  const categoryIssues = groupIssuesByCategory(report.ruleResults, report.checkTallies);

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

      // #2341: the same composition every surface makes — resource units first,
      // then component units, over one shared coverage.
      const siteResources = ruleSiteResourceCoverage(rule);
      const coverage = withSiteResourceCoverage(ruleFixCoverage(rule), siteResources, rule);
      for (const group of siteResources.groups) {
        lines.push(
          `**${escapeMarkdownText(siteResourceFixLine(group, REPORT_SOURCE_PAGES_PREVIEW, (page) => getPathname(page) || "/"))}**`,
        );
        lines.push("");
      }
      for (const rollup of fixUnits(coverage.groups, options?.componentRollup !== false)) {
        // One actionable line per REPAIR, not per faulty element in a block.
        lines.push(
          `**${escapeMarkdownText(fixRollupLine(rollup, REPORT_SOURCE_PAGES_PREVIEW, (page) => getPathname(page) || "/"))}**`,
        );
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
        // #3522: a message and a check name can embed what the page said (an ad
        // URL, a misspelled word), so both cells are escaped, brackets included.
        // pub#837: a check whose items are links says how many pages carry them.
        const pagesNote = hasItemSources(check)
          ? affectedPagesSuffix(check, affectedPages(check).count)
          : "";
        const escapedMessage = escapeMarkdownCell(check.message + pagesNote + carriedTag(check));
        lines.push(
          `| ${escapeMarkdownCell(check.name)} | ${statusIcon} ${check.status} | ${escapedMessage} |`,
        );
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
        // Fully covered: the fix-once lines above already name every page, once
        // per repair target. Repeating them per check is the noise this replaces.
        const uncovered =
          coverage.mode === "full"
            ? []
            : coverage.mode === "partial"
              ? ap.sample.filter((page) => coverage.uncoveredPages.includes(page))
              : ap.sample;
        // pub#846: a check that sits in one shared region names it instead of listing its
        // pages, and so does a check whose findings are scoped to regions.
        // pub#857: and so does a check on every page of one page type.
        const checkScope = checkScopeLine(check, ap.count, report.structure);
        if (checkScope) {
          lines.push(`**${check.name}:** ${checkScope}`);
          lines.push("");
        } else if (
          uncovered.length > 0 &&
          !checkPagesScopedAway(check, ap.count, report.structure)
        ) {
          const materialized =
            uncovered.length > REPORT_PAGES_HARD_CAP
              ? uncovered.slice(0, REPORT_PAGES_HARD_CAP)
              : uncovered;
          const summary =
            coverage.mode === "partial"
              ? `${uncovered.length} page(s) not attributed to a shared component`
              : `${ap.count} page(s) affected`;
          lines.push(
            `<details><summary><strong>${escapeHtmlText(check.name)}:</strong> ${summary}</summary>`,
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
            // #3522: a page URL's path is the site's; label and destination are escaped.
            lines.push(`- ${markdownLink(getPathname(page) || "/", page)}${carried}`);
          }
          lines.push("");
          lines.push("</details>");
          lines.push("");
        }

        // Items already covered by the unified page list above (a pure
        // page-URL id with no sourcePages) are dropped here so the same
        // URL isn't listed twice; items with sourcePages or a non-URL id
        // (a resource's own identity) keep their row.
        const visibleItems = uncoveredItems(check.items, coverage).filter(
          (item) => !isRedundantPageItem(item),
        );
        if (visibleItems && visibleItems.length > 0) {
          lines.push(
            `<details><summary><strong>${escapeHtmlText(check.name)}:</strong> ${visibleItems.length} item(s)${notListedSuffix(check)}</summary>`,
          );
          lines.push("");
          for (const item of visibleItems) {
            const view = itemSourceView(item, report.structure, check);
            // pub#846: a scoped item's label drops the section phrase its region line says.
            const label = itemLabel(item, view.scope) ?? item.id;
            const isUrl =
              item.id.startsWith("http://") ||
              item.id.startsWith("https://") ||
              item.id.startsWith("/");
            const display = isUrl ? markdownLink(label, item.id) : escapeMarkdownText(label);
            const siteWideInfo = siteWideItem(item, siteWide.total, siteWide.pageUrls);
            if (siteWideInfo) {
              lines.push(
                `- ${formatSiteWideItem(display, siteWideInfo, (page) => escapeMarkdownText(getPathname(page) || "/"))}`,
              );
              continue;
            }
            lines.push(`- ${display}`);
            // pub#837: each page once, with its links and where they sit. A long list says
            // how many pages it leaves out; the page block above lists the check's pages,
            // not this item's, so it is not pointed at. pub#846: an item scoped to a region
            // names it, and lists only the pages it is on outside it.
            if (view.scope) lines.push(`  - ${regionScopeLine(view.scope)}`);
            // Markdown lists every source: the item sits in a collapsed block, so
            // the full list costs no room (#837). Text, console and llm keep a preview.
            for (const row of view.rows) {
              lines.push(
                `  - from: ${sourceRowText(
                  markdownLink(getPathname(row.page) || "/", row.page),
                  row.detail,
                )}`,
              );
            }
            const hidden = Math.max(0, view.total - view.rows.length);
            if (hidden > 0) lines.push(`  - ${moreSourcePages(hidden)}`);
          }
          lines.push("");
          lines.push("</details>");
          lines.push("");
        } else if (coverage.mode !== "full" && itemsNotListed(check) > 0) {
          // A fully covered rule's groups already account for every item.
          lines.push(`**${escapeMarkdownText(check.name)}:** ${itemsNotListedLine(itemsNotListed(check))}`);
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

  const passedRules = reportPassedRules(report, options?.includePassed);
  if (passedRules.length > 0) {
    lines.push("## Passed");
    lines.push("");
    lines.push(`*${passedRules.length} rule${passedRules.length === 1 ? "" : "s"} with no issues*`);
    lines.push("");
    lines.push("| Rule | Category | Checked |");
    lines.push("|------|----------|---------|");
    for (const rule of passedRules) {
      lines.push(
        `| ${escapeMarkdownCell(rule.name)} \`${rule.id}\` | ${rule.categoryName} | ${passedRuleScope(rule)} |`,
      );
    }
    lines.push("");
  }

  // Entities (#2091) — report-only, never part of the score. Same section
  // builder the standalone entity-map document uses.
  if (report.entityMap) {
    lines.push(...entityMarkdownSection(report.entityMap, "##"));
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

  // Report detail: the last section, after every finding. What this audit did not check, the
  // page structure, and the scope and coverage notes that qualify the score.
  lines.push(...reportDetailLines(report));

  // White-label drops the squirrelscan "Generated by" credit line entirely,
  // and shows the org's own footer text and website in its place.
  if (!whiteLabel) {
    lines.push("---");
    lines.push("");
    const versionStr = version ? ` v${version}` : "";
    lines.push(`*Generated by [squirrelscan](https://squirrelscan.com)${versionStr}*`);
  } else {
    const footer = whiteLabelFooterLine(options?.branding);
    if (footer) {
      lines.push("---");
      lines.push("");
      lines.push(footer);
    }
  }

  return lines.join("\n");
}
