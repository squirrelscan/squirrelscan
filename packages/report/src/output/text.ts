// Plain text report output

import type { ReportBranding } from "@squirrelscan/core-contracts";
import type { AuditReport, CheckResult } from "../types";
import { AUDIT_FAILURE_NEXT_STEP } from "@squirrelscan/core-contracts/failure-reason";
import { cacheReasonsLabel, cacheStatsSummaryLine } from "../cache-stats";
import { refusedFetchLines, reportFailureReasonCode } from "../failure-notice";
import { getScoreGrade } from "../scoring";
import { REPORT_SOURCE_PAGES_PREVIEW, REPORT_TEXT_WRAP_WIDTH } from "../constants";
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
import { affectedPages, itemsNotListed, itemsNotListedLine } from "../affected-pages";
import {
  affectedPagesSuffix,
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
import {
  ENTITY_CONSOLE_LIMIT,
  ENTITY_EMPTY_MESSAGE,
  entityLabel,
  entityPageTotal,
  entitySummaryLine,
  primaryEntities,
} from "../entities";
import {
  structureChromeLine,
  structureDegradedLine,
  structureNumber,
  structurePageTypesLine,
  structureRows,
  structureTotalsLine,
} from "../structure";
import { groupTechnologies, techChangeSummary } from "../technologies";
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
} from "../coverage";
import { wrapText } from "../utils";
import { unfetchedNote } from "../coverage";
import { lockedRulesMessage } from "../locked-rules";
import { privateTargetLine } from "../private-target";
import { notCheckedDetailLines } from "../not-checked";
import { stripControlChars } from "@squirrelscan/core-contracts/control-chars";

export interface TextRenderOptions {
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


/**
 * Host list for a rate-limit line: names up to two, then counts the rest.
 * Mirrors the phrasing used in the audit status reason.
 */
function formatRateLimitedHosts(hosts: string[]): string {
  if (hosts.length === 0) return "the host";
  if (hosts.length <= 2) return hosts.join(" and ");
  return `${hosts.slice(0, 2).join(", ")} and ${hosts.length - 2} other host(s)`;
}

/** Plain-language cause for an `omitted` component-evidence marker. */
function componentEvidenceReason(
  reason: NonNullable<CheckResult["componentEvidence"]>["reason"],
): string {
  if (reason === "payload-limit") return "they exceeded the stored finding payload limit.";
  if (reason === "page-sample-limit") {
    return "their pages fall outside this rule's recorded page sample.";
  }
  return "the stored row that carried them was not available.";
}

/** The scope and coverage notes that qualify the score, one line each. */
function scanDetailLines(report: AuditReport): string[] {
  const out: string[] = [];
  // #1829: coverage the crawl lost to throttling.
  if (report.rateLimited && report.rateLimited.pages > 0) {
    out.push(
      `Rate limited: ${report.rateLimited.pages} page(s) not verified (${formatRateLimitedHosts(report.rateLimited.hosts)})${unfetchedNote(report.rateLimited.unfetched)}`,
    );
  }
  // #1418: the seed redirected off its own site and was not followed, so the URL at the top is not
  // where the redirect pointed. stripControlChars because the redirect target is a string the
  // audited site chose and this output reaches a terminal.
  const seedRedirect = seedRedirectLine(report);
  if (seedRedirect) out.push(stripControlChars(seedRedirect));
  const scope = scanScopeLine(report);
  if (scope) out.push(scope);
  // repo#2661: a capped published report lists samples; say so, and where the rest is.
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

/**
 * REPORT DETAIL: what this audit did not check (so a skipped check never reads as clean), the page
 * structure, then the scope and coverage notes. Writes nothing when there is none of it.
 */
function writeReportDetail(report: AuditReport, write: (line?: string) => void): void {
  const notChecked = notCheckedDetailLines(report);
  const scan = scanDetailLines(report);
  const structure = report.structure;
  if (notChecked.length === 0 && scan.length === 0 && !structure) return;

  write("REPORT DETAIL");
  write("-".repeat(40));
  if (notChecked.length > 0) {
    write("Not checked");
    for (const line of notChecked) write(`  - ${line}`);
    write("");
  }
  if (structure) {
    write("Page structure");
    const typesLine = structurePageTypesLine(structure);
    if (typesLine) {
      write(typesLine);
      write("");
    }
    const rows = structureRows(structure);
    if (rows.length > 0) {
      const width = Math.max("Section".length, ...rows.map((r) => r.section.length));
      write(`${"Section".padEnd(width)}  ${"Pages".padStart(7)}  ${"Links".padStart(8)}`);
      for (const row of rows) {
        write(
          `${row.section.padEnd(width)}  ${structureNumber(row.pages).padStart(7)}  ${structureNumber(row.links).padStart(8)}`,
        );
      }
      write("");
    }
    const totals = structureTotalsLine(structure);
    if (totals) write(totals);
    const chromeLine = structureChromeLine(structure);
    if (chromeLine) write(chromeLine);
    const degradedLine = structureDegradedLine(structure);
    if (degradedLine) write(degradedLine);
    write("");
  }
  if (scan.length > 0) {
    write("Scan details");
    for (const line of scan) write(`  - ${line}`);
    write("");
  }
}

export function renderText(report: AuditReport, options?: TextRenderOptions): string {
  const lines: string[] = [];
  const siteWide = siteWideContext(report, options?.siteWideCollapse !== false);
  const version = options?.version ?? "";
  const whiteLabel = options?.branding?.whiteLabel ?? false;
  const write = (line = "") => {
    lines.push(line);
  };

  // White-label drops the "squirrelscan" title in favour of the org name (or a
  // neutral "Audit Report") so the text export carries no squirrelscan branding.
  const titleBase = whiteLabel ? (options?.branding?.orgName ?? "Audit Report") : "squirrelscan";
  write(`${titleBase}${version ? ` v${version}` : ""}`);
  write("=".repeat(60));
  write(`Auditing: ${report.baseUrl}`);
  write(`Crawled ${report.totalPages} pages`);
  write("");

  // Editor's summary — report-only (Pro exec-email narrative; not part of the score).
  // Surfaced at the very top of the report, before the health score.
  const es = editorSummaryView(report.editorSummary, report);
  if (es) {
    write("EDITOR'S SUMMARY");
    write("-".repeat(40));
    write(EDITOR_SUMMARY_NOTE);
    write("");
    for (const para of es.paragraphs) {
      for (const line of wrapText(para, REPORT_TEXT_WRAP_WIDTH)) write(line);
      write("");
    }
    if (es.priorities.length === 0 && es.bigTicket.length > 0) {
      write("Big-ticket items:");
      for (const item of es.bigTicket) write(`  - ${item}`);
      write("");
    }
    if (es.verdict) {
      write(`Verdict: ${es.verdict}`);
      write("");
    }
  }

  // Ranked priorities from the editor's summary, as their own section.
  if (es && es.priorities.length > 0) {
    write("PRIORITIES");
    write("-".repeat(40));
    for (const [i, p] of es.priorities.entries()) {
      write(`${i + 1}. ${p.title} [${priorityEffortLabel(p.effort)}]`);
      for (const text of [p.why, p.action].filter(Boolean)) {
        for (const line of wrapText(text, REPORT_TEXT_WRAP_WIDTH - 3)) write(`   ${line}`);
      }
      write("");
    }
  }

  // Failed/blocked audit (#489): show the state, never a "0/100 (F)" grade.
  // #792: a block is the SITE refusing our crawler, not our infra; say so and
  // give actionable next steps.
  if (report.status === "failed" || report.status === "blocked") {
    const blocked = report.status === "blocked";
    const throttled = !!report.rateLimited && report.rateLimited.pages > 0;
    write(blocked ? "AUDIT BLOCKED" : "AUDIT FAILED");
    if (blocked && throttled) {
      // #1829: rate limiting and a bot wall both end up here with nothing
      // audited, but they point at OPPOSITE fixes — allowlisting a crawler does
      // nothing for a throttle, and slowing down does nothing for a WAF. The
      // copy has to match the cause or it sends the reader to the wrong place.
      write(
        `${formatRateLimitedHosts(report.rateLimited!.hosts)} rate limited the crawler (429/430) before any pages could be read, so nothing was audited.`,
      );
      write(
        "To get a full audit: crawl the site more slowly with `[crawler] per_host_concurrency = 1` and `per_host_delay_ms = 500` in squirrel.toml, raise `max_backoff_ms` to wait longer, or retry when the host is less busy.",
      );
    } else if (blocked) {
      write(
        "Your site refused the crawler before any pages could be read (403/429 from bot protection, a firewall, an auth wall, or rate limiting). This is a block on your side, not a squirrelscan outage.",
      );
      write(
        "To get a full audit: allowlist the squirrelscan crawler, turn off bot fight mode for the audit, or run it from a trusted network.",
      );
    } else {
      // #1822: the reason names the class (DNS, TLS, connection, timeout, a
      // status, a redirect, robots) and the line under it says what to do about
      // that class. `unknown` keeps the pre-#1822 paragraph.
      const code = reportFailureReasonCode(report);
      if (report.statusReason) write(report.statusReason);
      write(AUDIT_FAILURE_NEXT_STEP[code]);
    }
    // Name what was refused, so a missing robots.txt or sitemap reads as
    // "the site would not say" and never as "the site has none".
    const refused = refusedFetchLines(report);
    if (refused.length > 0) {
      write("");
      write("Refused by the site (not checked, so not reported as missing):");
      for (const line of refused) write(`  ${line}`);
    }
    write("");
  } else if (report.healthScore) {
    // #1829: a partial run scored what it fetched, so the grade still prints —
    // but say plainly that the coverage is short of what was asked for.
    if (report.status === "partial" && report.statusReason) {
      write(`PARTIAL AUDIT: ${report.statusReason}`);
      write("");
    }
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

  const categoryIssues = groupIssuesByCategory(report.ruleResults, report.checkTallies);
  // Severity → category → weight (#1536): one global order, so everything you
  // must fix sits above everything you might. Categories are labeled per rule
  // rather than used as headings, since a category now spans severity sections.
  const flatIssues = flattenIssuesBySeverity(categoryIssues);

  if (categoryIssues.length > 0) {
    write("ISSUES");
    write("-".repeat(40));
    write("");

    let lastSeverity: string | undefined;
    let lastCategory: string | undefined;
    let lastSub: string | undefined;
    for (const rule of flatIssues) {
      if (rule.severity !== lastSeverity) {
        lastSeverity = rule.severity;
        lastCategory = undefined;
        write(`=== ${severityLabel(rule.severity, { plural: true }).toUpperCase()} ===`);
        write("");
      }
      if (rule.categoryCode !== lastCategory) {
        lastCategory = rule.categoryCode;
        lastSub = undefined;
        write(`[${rule.categoryName.toUpperCase()}]`);
        write("");
      }
      if (rule.subcategory && rule.subcategory !== lastSub) {
        lastSub = rule.subcategory;
        write(`  ${getSubcategoryName(rule.subcategory)}`);
        write("");
      }
      write(`  [${severityLabel(rule.severity)}] ${rule.id} - ${rule.name}`);
      if (rule.description) write(`  Description: ${rule.description}`);
      if (rule.solution) {
        const wrapped = wrapText(rule.solution, REPORT_TEXT_WRAP_WIDTH);
        write(`  Solution: ${wrapped[0]}`);
        for (const line of wrapped.slice(1)) write(`            ${line}`);
      }
      // #2341: resource units first, then component units, over one coverage.
      const siteResources = ruleSiteResourceCoverage(rule);
      const coverage = withSiteResourceCoverage(ruleFixCoverage(rule), siteResources, rule);
      for (const group of siteResources.groups) {
        write(`    ${siteResourceFixLine(group, 5, pathOnly)}`);
      }
      for (const rollup of fixUnits(coverage.groups, options?.componentRollup !== false)) {
        // One actionable line per REPAIR, not per faulty element in a block.
        write(`    ${fixRollupLine(rollup, 5, pathOnly)}`);
      }
      write("");

      for (const check of rule.checks) {
        // #1023 R-F: authoritative page count (true pre-sample total) + the
        // union sample (pages + item page-refs), labeled examples when clipped.
        const { sample, count, hasMore } = affectedPages(check);
        const countStr = affectedPagesSuffix(check, count);
        const icon = check.status === "fail" ? "X" : "!";
        write(`    [${icon}] ${check.name}: ${check.message}${countStr}${carriedTag(check)}`);
        if (check.componentEvidence?.state === "omitted") {
          write(
            `        Component fix evidence unavailable for ${check.componentEvidence.occurrenceCount} occurrence(s): ${componentEvidenceReason(check.componentEvidence.reason)}`,
          );
        }

        // Fully covered: the fix-once lines above already list every page.
        const uncovered =
          coverage.mode === "full"
            ? []
            : coverage.mode === "partial"
              ? sample.filter((page) => coverage.uncoveredPages.includes(page))
              : sample;

        // pub#846: a check that sits in one shared region names it instead of listing its pages,
        // and so does a check whose findings are scoped to regions: they carry their own pages.
        // pub#857: and so does a check on every page of one page type.
        const checkScope = checkScopeLine(check, count, report.structure);
        if (checkScope) {
          write(`        ${checkScope}`);
        } else if (uncovered.length > 0 && !checkPagesScopedAway(check, count, report.structure)) {
          if (coverage.mode === "partial") {
            write(`        Not attributed to a shared component (${uncovered.length}):`);
          }
          for (const page of uncovered) write(`        -> ${pathOnly(page)}`);
          if (coverage.mode === "none" && hasMore) {
            write(`        ... and ${count - sample.length} more`);
          }
        }

        // repo#2661: a capped report keeps a sample of items, or none for a
        // counts-only class; say how many it left out. A fully covered rule's groups already
        // account for every item, so it leaves none out.
        const left = coverage.mode === "full" ? 0 : itemsNotListed(check);
        const listedItems = uncoveredItems(check.items, coverage);
        if (listedItems.length > 0) {
          for (const item of listedItems) {
            // pub#837: each page once, with its links and where they sit; a long list says how
            // many pages it leaves out. pub#846: an item scoped to a region names it, lists only
            // the pages it is on outside it, and its label drops the section phrase.
            const view = itemSourceView(item, report.structure);
            const label = itemLabel(item, view.scope) ?? item.id;
            // One line, no page list: the list IS the noise for an item that is
            // the same resource on effectively every page.
            const info = siteWideItem(item, siteWide.total, siteWide.pageUrls);
            if (info) {
              write(`        -> ${formatSiteWideItem(label, info, pathOnly)}`);
              if (item.snippet) write(`           ${item.snippet}`);
              continue;
            }
            write(`        -> ${label}`);
            if (item.snippet) write(`           ${item.snippet}`);
            if (view.scope) write(`            ${regionScopeLine(view.scope)}`);
            const shown = view.rows.slice(0, REPORT_SOURCE_PAGES_PREVIEW);
            for (const row of shown) {
              write(`            from: ${sourceRowText(pathOnly(row.page), row.detail)}`);
            }
            const hidden = Math.max(0, view.total - shown.length);
            if (hidden > 0) write(`            ${moreSourcePages(hidden)}`);
          }
          if (left > 0) write(`        ... and ${left.toLocaleString("en-US")} more items not listed`);
        } else if (left > 0) {
          write(`        ${itemsNotListedLine(left)}`);
        }
      }
      write("");
    }
  } else if (report.status !== "failed" && report.status !== "blocked") {
    // #792: don't claim "No issues found" for a 0-page failed/blocked run —
    // nothing was audited (state shown above), the site isn't necessarily clean.
    write("No issues found");
    write("");
  }

  const passedRules = reportPassedRules(report, options?.includePassed);
  if (passedRules.length > 0) {
    write(`PASSED (${passedRules.length} rule${passedRules.length === 1 ? "" : "s"})`);
    write("-".repeat(40));
    let lastCategory: string | undefined;
    for (const rule of passedRules) {
      if (rule.categoryCode !== lastCategory) {
        lastCategory = rule.categoryCode;
        write("");
        write(`[${rule.categoryName.toUpperCase()}]`);
      }
      write(`  ${rule.id} - ${rule.name} (${passedRuleScope(rule)})`);
    }
    write("");
  }

  // Entities (#2091) — the site's own JSON-LD collapsed into one graph.
  // Report-only: it never contributes to the score.
  if (report.entityMap) {
    const map = report.entityMap;
    write("ENTITIES");
    write("-".repeat(40));
    if (map.summary.nodeCount === 0) {
      write(ENTITY_EMPTY_MESSAGE);
    } else {
      write(entitySummaryLine(map));
      write("(informational — not part of the score)");
      write("");
      for (const node of primaryEntities(map).slice(0, ENTITY_CONSOLE_LIMIT)) {
        const id = node.id ?? "no @id";
        write(
          `${entityLabel(node)} (${node.types.join(", ")}) — ${node.occurrences}x on ${entityPageTotal(node)} page(s), ${id}`
        );
      }
      if (map.summary.nodesWithoutIdCount > 0) {
        write("");
        write(
          `${map.summary.nodesWithoutIdCount} entity(ies) declared on several pages carry no @id — search engines cannot tell they are one thing.`
        );
      }
    }
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

  // Report detail: the last section, after every finding (see the markdown renderer).
  writeReportDetail(report, write);

  write("=".repeat(60));
  write(`${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed`);
  // White-label drops the squirrelscan "Generated by" credit line, and shows
  // the org's own footer text and website in its place.
  if (!whiteLabel) write("Generated by squirrelscan.com");
  else {
    if (options?.branding?.footerText) {
      for (const line of wrapText(options.branding.footerText, REPORT_TEXT_WRAP_WIDTH)) write(line);
    }
    const website = options?.branding?.websiteUrl;
    if (website && /^https:\/\//i.test(website)) write(website);
  }

  // Sanitise once, at the boundary. Page-derived strings reach this output
  // through many fields (messages, snippets, titles, meta values), so stripping
  // per field would be a list that silently goes stale as fields are added.
  // This renderer emits no ANSI of its own, so a blanket strip is safe here.
  return stripControlChars(`${lines.join("\n")}\n`);
}
