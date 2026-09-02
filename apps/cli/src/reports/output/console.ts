// Console report output

import type { EditorSummaryView } from "@squirrelscan/report";

import { stripControlCharsPreservingSgr } from "@squirrelscan/core-contracts/control-chars";
import {
  carriedTag,
  coverageLine,
  scanScopeLine,
  seedRedirectLine,
  getGroupName,
  getSubcategoryName,
  groupTechnologies,
  techChangeSummary,
  DOMAIN_STATS_NOTE,
  domainStatRows,
  positionBands,
  EDITOR_SUMMARY_NOTE,
  editorSummaryView,
  SITE_PROFILE_NOTE,
  siteProfileFlags,
  siteProfileRows,
} from "@squirrelscan/report";

import type {
  AuditReport,
  DomainStats,
  GroupScore,
  HealthScore,
  ReportTechnologies,
  SiteMetadata,
} from "@/types";

import { getScoreGrade } from "@/audit/scoring";
import {
  fmt,
  scoreColor,
  progressBar,
  icon,
  pathOnly,
  divider,
  box,
} from "@/cli/format";
import { groupIssuesByCategory } from "@/reports/grouping";
import { RULE_CATEGORY_VALUES } from "@/rules/categories";

/**
 * Every console line in this renderer goes through here.
 *
 * Report text is page-derived: rule messages, snippets, titles and meta values
 * all originate from the audited site. A raw ESC in any of them is executed by
 * the terminal rather than shown, and `ESC[2J ESC[1;1H` is enough to blank the
 * real findings and repaint forged ones. Sanitising at this single boundary
 * (rather than per interpolation) is what keeps it from going stale as fields
 * are added. Our own colour codes survive; see stripControlCharsPreservingSgr.
 */
function log(...args: unknown[]): void {
  console.log(
    ...args.map((a) =>
      typeof a === "string" ? stripControlCharsPreservingSgr(a) : a
    )
  );
}

/** Rule filter applied this run (#1066), CLI-parsed patterns — resolved
 * enable/disable actually passed to the runner, not the raw category tokens.
 * Presence (either array non-empty) means the audit is partial. */
export interface ConsoleRuleFilter {
  enable: string[];
  disable: string[];
}

export interface ConsoleReportOptions {
  /** #1067: print header/score/breakdown/counts/footer only — no per-rule
   * issue detail or affected-page lists. */
  summaryOnly?: boolean;
  /** #1066: when set, the run excluded some rule categories — print a
   * partial-audit notice under the header. */
  ruleFilter?: ConsoleRuleFilter;
}

export function generateConsoleReport(
  report: AuditReport,
  opts: ConsoleReportOptions = {}
): void {
  // Failed/blocked audit (#489): no real audit happened — show the state, not
  // a (meaningless) grade. Skip the score line and category breakdown entirely.
  // (`partial`/`completed`/absent fall through to the normal score below.)
  if (report.status === "failed" || report.status === "blocked") {
    const label =
      report.status === "blocked" ? "AUDIT BLOCKED" : "AUDIT FAILED";
    log("");
    log(divider());
    log(fmt.bold(fmt.red(label)));
    log(
      `${fmt.dim(report.baseUrl)} • ${report.statusReason ?? "No auditable pages"}`
    );
    // A seed that redirects off-site and is refused is a common way to end up
    // here with nothing to audit, so this branch needs the disclosure too.
    const redirect = seedRedirectLine(report);
    if (redirect) log(fmt.yellow(redirect));
    log(divider());
    return;
  }

  const score = report.healthScore?.overall ?? 0;
  const grade = getScoreGrade(score);
  const colorFn = scoreColor(score);

  // Header
  log("");
  log(divider());
  log(fmt.bold("SQUIRRELSCAN REPORT"));
  log(
    `${fmt.dim(report.baseUrl)} • ${report.totalPages} page${report.totalPages === 1 ? "" : "s"} • ${colorFn(`${score}/100`)} ${fmt.dim(`(${grade})`)}`
  );
  // Refused off-site seed redirect (#1418): the URL on the line above is what
  // was graded, NOT where the seed pointed. Yellow rather than dim like the
  // lines below it — it changes what the whole report is about.
  const seedRedirect = seedRedirectLine(report);
  if (seedRedirect) log(fmt.yellow(seedRedirect));
  // Scan scope (#1180) + smart-audits coverage (#110): the score reads with
  // its basis. The capped-crawl hint stays with pageLimitHint (commands layer).
  const scope = scanScopeLine(report);
  if (scope) log(fmt.dim(scope));
  const cov = coverageLine(report);
  if (cov) log(fmt.dim(cov));
  const partial = partialAuditLine(opts.ruleFilter, report.healthScore);
  if (partial) log(fmt.dim(partial));
  log(divider());

  // Editor's summary — report-only Pro exec narrative, surfaced at the top.
  const editorSummary = editorSummaryView(report.editorSummary);
  if (editorSummary) {
    log("");
    printEditorSummary(editorSummary);
  }

  // Category breakdown
  if (report.healthScore) {
    log("");
    printCategoryBreakdown(report.healthScore);
  }

  // Site profile — report-only Stage-0 context, separate from issues, not scored.
  if (report.siteMetadata) {
    log("");
    printSiteProfile(report.siteMetadata);
  }

  // Domain stats — report-only section (backlinks/traffic/keywords), not scored.
  if (report.domainStats) {
    log("");
    printDomainStats(report.domainStats);
  }

  // Technologies — report-only section, separate from issues, not scored.
  if (report.technologies && report.technologies.items.length > 0) {
    log("");
    printTechnologies(report.technologies);
  }

  // Group all rule results by category (includes both page-scope and site-scope rules)
  const categoryIssues = groupIssuesByCategory(report.ruleResults);

  if (categoryIssues.length > 0) {
    log("");
    log(fmt.bold("ISSUES"));

    for (const category of categoryIssues) {
      log("");
      const counts: string[] = [];
      if (category.failCount > 0) {
        counts.push(
          fmt.red(
            `${category.failCount} error${category.failCount > 1 ? "s" : ""}`
          )
        );
      }
      if (category.warnCount > 0) {
        counts.push(
          fmt.yellow(
            `${category.warnCount} warning${category.warnCount > 1 ? "s" : ""}`
          )
        );
      }
      log(
        box.header(
          `${fmt.bold(category.name)} ${fmt.dim(`(${counts.join(", ")})`)}`
        )
      );
      // #1067: --summary stops after the per-category counts — no per-rule
      // detail or affected-page lists. Close the box immediately rather than
      // falling into the per-rule loop below.
      if (opts.summaryOnly) {
        log(box.footer());
        continue;
      }
      log(box.v);

      const hasSub = category.rules.some((r) => r.subcategory);
      let lastSub: string | undefined;
      for (let ri = 0; ri < category.rules.length; ri++) {
        const rule = category.rules[ri];
        if (hasSub && rule.subcategory !== lastSub) {
          lastSub = rule.subcategory;
          if (rule.subcategory) {
            log(box.line(` ${fmt.bold(getSubcategoryName(rule.subcategory))}`));
          }
        }
        const severityLabel =
          rule.severity === "error"
            ? fmt.red("error")
            : rule.severity === "warning"
              ? fmt.yellow("warning")
              : fmt.cyan("info");
        log(
          box.line(
            ` ${fmt.dim(rule.id)} ${rule.name} ${fmt.dim(`(${severityLabel})`)}`
          )
        );

        for (const check of rule.checks) {
          const statusIcon = icon(check.status as "fail" | "warn");
          const pageCount = check.pages.length;
          const countStr = pageCount > 1 ? ` (${pageCount} pages)` : "";
          const carried = fmt.dim(carriedTag(check));
          log(
            box.line(
              `   ${statusIcon} ${check.name}: ${check.message}${countStr}${carried}`
            )
          );
          // Show affected pages (for page-scope rules)
          if (pageCount > 0) {
            const maxPages = 5;
            const pagesToShow = check.pages.slice(0, maxPages);
            for (const page of pagesToShow) {
              log(box.line(`     ${fmt.dim(`→ ${pathOnly(page)}`)}`));
            }
            if (pageCount > maxPages) {
              log(
                box.line(`     ${fmt.dim(`... +${pageCount - maxPages} more`)}`)
              );
            }
          }
          // Show structured items (preferred)
          if (check.items && check.items.length > 0) {
            const maxItems = 5;
            const itemsToShow = check.items.slice(0, maxItems);
            for (const item of itemsToShow) {
              const label = item.label ?? item.id;
              log(box.line(`     ${fmt.dim(`→ ${label}`)}`));
              // Show HTML snippet if present
              if (item.snippet) {
                log(box.line(`       ${fmt.dim(item.snippet)}`));
              }
              // Show source pages if present (for site-scope items)
              if (item.sourcePages && item.sourcePages.length > 0) {
                for (const src of item.sourcePages.slice(0, 2)) {
                  log(box.line(`       ${fmt.dim(`from ${pathOnly(src)}`)}`));
                }
                if (item.sourcePages.length > 2) {
                  log(
                    box.line(
                      `       ${fmt.dim(`... +${item.sourcePages.length - 2} more pages`)}`
                    )
                  );
                }
              }
            }
            if (check.items.length > maxItems) {
              log(
                box.line(
                  `     ${fmt.dim(`... +${check.items.length - maxItems} more`)}`
                )
              );
            }
          }
          // Legacy check.value omitted - message already contains relevant info
        }

        // Blank line between rules (but not after last)
        if (ri < category.rules.length - 1) {
          log(box.v);
        }
      }

      log(box.v);
      log(box.footer());
    }
  } else {
    log("");
    log(fmt.green("✓ No issues found"));
  }

  // Footer
  log("");
  log(divider());
  log(
    `${fmt.green(`${report.passed} passed`)} • ${fmt.yellow(`${report.warnings} warnings`)} • ${fmt.red(`${report.failed} failed`)}`
  );
  log(divider());
  log("");
}

/** #1066: "partial audit: ax, perf (scored on N of M categories)" line shown
 * under the header when --rule-include/--rule-exclude filtered rules out.
 * Category names are derived from the resolved enable patterns when present
 * (--rule-include), otherwise from disable (--rule-exclude); falls back to
 * the raw pattern string for exact rule/glob filters that aren't a bare
 * `category/*`. Returns null when no filter was applied.
 *
 * The "N of M" count is only shown for --rule-include: `healthScore.categories`
 * already omits categories with no applicable rules on this site (not just
 * ones the filter excluded, see calculateHealthScore), so for --rule-exclude
 * the same count would conflate "you filtered it out" with "it didn't apply
 * here" and undercount how much of the site was actually scored. */
function partialAuditLine(
  filter: ConsoleRuleFilter | undefined,
  healthScore: HealthScore | undefined
): string | null {
  if (!filter || (filter.enable.length === 0 && filter.disable.length === 0)) {
    return null;
  }
  const included = filter.enable.length > 0;
  const shorten = (p: string) => (p.endsWith("/*") ? p.slice(0, -2) : p);
  const parts: string[] = [];
  if (included) parts.push(`included ${filter.enable.map(shorten).join(", ")}`);
  if (filter.disable.length > 0) {
    parts.push(`excluded ${filter.disable.map(shorten).join(", ")}`);
  }
  const scored =
    included && healthScore && healthScore.overall !== null
      ? ` (scored on ${healthScore.categories.length} of ${RULE_CATEGORY_VALUES.length} categories)`
      : "";
  return `partial audit: ${parts.join("; ")}${scored}`;
}

function printEditorSummary(es: EditorSummaryView): void {
  log(fmt.bold("EDITOR'S SUMMARY"));
  log(fmt.dim(EDITOR_SUMMARY_NOTE));
  log("");
  for (const para of es.paragraphs) {
    log(para);
    log("");
  }
  if (es.bigTicket.length > 0) {
    log(fmt.bold("Big-ticket items:"));
    for (const item of es.bigTicket) log(`  ${fmt.dim("•")} ${item}`);
    log("");
  }
  if (es.verdict) log(`${fmt.bold("Verdict:")} ${es.verdict}`);
}

function printSiteProfile(meta: SiteMetadata): void {
  log(fmt.bold("SITE PROFILE"));
  log(fmt.dim(SITE_PROFILE_NOTE));
  log("");
  for (const row of siteProfileRows(meta)) {
    const label = fmt.bold(row.label.padEnd(12));
    const value = row.url ? `${row.value} ${fmt.dim(row.url)}` : row.value;
    log(`  ${label} ${value}`);
  }
  const flags = siteProfileFlags(meta);
  if (flags) log(fmt.dim(`Flags: ${flags}`));
}

function printDomainStats(stats: DomainStats): void {
  const rows = domainStatRows(stats.metrics);
  if (rows.length === 0) return;
  log(fmt.bold("DOMAIN STATS"));
  log(fmt.dim(DOMAIN_STATS_NOTE));
  log("");
  for (const row of rows) {
    log(`  ${fmt.bold(row.label.padEnd(18))} ${row.value}`);
  }
  const bands = positionBands(stats.metrics.positions);
  if (bands.length > 0) {
    const dist = bands.map((b) => `${b.label} ${b.count}`).join(fmt.dim(" · "));
    log(fmt.dim(`  Organic positions: `) + dist);
  }
}

function printTechnologies(tech: ReportTechnologies): void {
  log(fmt.bold("TECHNOLOGIES"));
  const summary = techChangeSummary(tech);
  const added = tech.added.length > 0 ? fmt.green(`+${tech.added.length}`) : "";
  const removed =
    tech.removed.length > 0 ? fmt.red(`-${tech.removed.length}`) : "";
  const delta = [added, removed].filter(Boolean).join(" ");
  log(
    fmt.dim(
      `Detected stack — not part of the score.${summary ? ` ${summary}.` : ""}`
    ) + (delta ? ` ${delta}` : "")
  );
  log("");
  for (const group of groupTechnologies(tech.items)) {
    const names = group.items
      .map((t) => `${t.name}${t.version ? fmt.dim(` ${t.version}`) : ""}`)
      .join(fmt.dim(" · "));
    log(`${group.emoji} ${fmt.bold(group.label.padEnd(22))} ${names}`);
  }
}

function printGroupBreakdown(groups: GroupScore[]): void {
  if (groups.length === 0) return;

  log(fmt.bold("Group Breakdown:"));
  log(divider());

  const maxP = Math.max(...groups.map((g) => g.passed)).toString().length;
  const maxW = Math.max(...groups.map((g) => g.warnings)).toString().length;
  const maxF = Math.max(...groups.map((g) => g.failed)).toString().length;

  for (const g of groups) {
    // Name derives from the group CODE (not the stored name) so renames
    // apply to already-stored reports (matches text.ts/markdown.ts).
    const name = fmt.bold(getGroupName(g.group).padEnd(22));
    const bar = progressBar(g.score);
    const pct = scoreColor(g.score)(`${String(g.score).padStart(3)}%`);

    const p = fmt.green(`✓${String(g.passed).padStart(maxP)}`);
    const w =
      g.warnings > 0
        ? fmt.yellow(`⚠${String(g.warnings).padStart(maxW)}`)
        : fmt.dim(`⚠${String(g.warnings).padStart(maxW)}`);
    const f =
      g.failed > 0
        ? fmt.red(`✗${String(g.failed).padStart(maxF)}`)
        : fmt.dim(`✗${String(g.failed).padStart(maxF)}`);

    log(`${name} ${bar}  ${pct}   ${p}  ${w}  ${f}`);
  }

  log("");
}

function printCategoryBreakdown(score: HealthScore): void {
  if (score.overall === null) {
    log(`Health Score: ${fmt.dim("N/A")} ${fmt.dim("(no auditable pages)")}`);
    log("");
    return;
  }
  const colorFn = scoreColor(score.overall);
  log(
    `Health Score: ${colorFn(`${score.overall}/100`)} ${fmt.dim(`(${getScoreGrade(score.overall)})`)}`
  );
  log("");

  // The 4 top-level group scores (#1017), above the finer categories — mirrors
  // text.ts's/markdown.ts's "Group Breakdown" so the console default matches
  // the other report formats and cloud's group-score summary.
  printGroupBreakdown(score.groups ?? []);

  if (score.categories.length === 0) return;

  log(fmt.bold("Category Breakdown:"));
  log(divider());

  const maxP = Math.max(...score.categories.map((c) => c.passed)).toString()
    .length;
  const maxW = Math.max(...score.categories.map((c) => c.warnings)).toString()
    .length;
  const maxF = Math.max(...score.categories.map((c) => c.failed)).toString()
    .length;

  for (const cat of score.categories) {
    const name = fmt.bold(cat.name.padEnd(22));
    const bar = progressBar(cat.score);
    const pct = scoreColor(cat.score)(`${String(cat.score).padStart(3)}%`);

    const p = fmt.green(`✓${String(cat.passed).padStart(maxP)}`);
    const w =
      cat.warnings > 0
        ? fmt.yellow(`⚠${String(cat.warnings).padStart(maxW)}`)
        : fmt.dim(`⚠${String(cat.warnings).padStart(maxW)}`);
    const f =
      cat.failed > 0
        ? fmt.red(`✗${String(cat.failed).padStart(maxF)}`)
        : fmt.dim(`✗${String(cat.failed).padStart(maxF)}`);

    log(`${name} ${bar}  ${pct}   ${p}  ${w}  ${f}`);
  }

  log("");
  log(
    `Total: ${fmt.green(`${score.passedCount} passed`)}, ${fmt.yellow(`${score.warningCount} warnings`)}, ${fmt.red(`${score.errorCount} errors`)}`
  );
}
