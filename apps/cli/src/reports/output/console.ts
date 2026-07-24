// Console report output

import {
  carriedTag,
  coverageLine,
  scanScopeLine,
  getGroupName,
  getSubcategoryName,
  groupTechnologies,
  techChangeSummary,
  DOMAIN_STATS_NOTE,
  domainStatRows,
  positionBands,
  EDITOR_SUMMARY_NOTE,
  SITE_PROFILE_NOTE,
  siteProfileFlags,
  siteProfileRows,
} from "@squirrelscan/report";

import type {
  AuditReport,
  DomainStats,
  EditorSummary,
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
    console.log("");
    console.log(divider());
    console.log(fmt.bold(fmt.red(label)));
    console.log(
      `${fmt.dim(report.baseUrl)} • ${report.statusReason ?? "No auditable pages"}`
    );
    console.log(divider());
    return;
  }

  const score = report.healthScore?.overall ?? 0;
  const grade = getScoreGrade(score);
  const colorFn = scoreColor(score);

  // Header
  console.log("");
  console.log(divider());
  console.log(fmt.bold("SQUIRRELSCAN REPORT"));
  console.log(
    `${fmt.dim(report.baseUrl)} • ${report.totalPages} page${report.totalPages === 1 ? "" : "s"} • ${colorFn(`${score}/100`)} ${fmt.dim(`(${grade})`)}`
  );
  // Scan scope (#1180) + smart-audits coverage (#110): the score reads with
  // its basis. The capped-crawl hint stays with pageLimitHint (commands layer).
  const scope = scanScopeLine(report);
  if (scope) console.log(fmt.dim(scope));
  const cov = coverageLine(report);
  if (cov) console.log(fmt.dim(cov));
  const partial = partialAuditLine(opts.ruleFilter, report.healthScore);
  if (partial) console.log(fmt.dim(partial));
  console.log(divider());

  // Editor's summary — report-only Pro exec narrative, surfaced at the top.
  if (report.editorSummary) {
    console.log("");
    printEditorSummary(report.editorSummary);
  }

  // Category breakdown
  if (report.healthScore) {
    console.log("");
    printCategoryBreakdown(report.healthScore);
  }

  // Site profile — report-only Stage-0 context, separate from issues, not scored.
  if (report.siteMetadata) {
    console.log("");
    printSiteProfile(report.siteMetadata);
  }

  // Domain stats — report-only section (backlinks/traffic/keywords), not scored.
  if (report.domainStats) {
    console.log("");
    printDomainStats(report.domainStats);
  }

  // Technologies — report-only section, separate from issues, not scored.
  if (report.technologies && report.technologies.items.length > 0) {
    console.log("");
    printTechnologies(report.technologies);
  }

  // Group all rule results by category (includes both page-scope and site-scope rules)
  const categoryIssues = groupIssuesByCategory(report.ruleResults);

  if (categoryIssues.length > 0) {
    console.log("");
    console.log(fmt.bold("ISSUES"));

    for (const category of categoryIssues) {
      console.log("");
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
      console.log(
        box.header(
          `${fmt.bold(category.name)} ${fmt.dim(`(${counts.join(", ")})`)}`
        )
      );
      // #1067: --summary stops after the per-category counts — no per-rule
      // detail or affected-page lists. Close the box immediately rather than
      // falling into the per-rule loop below.
      if (opts.summaryOnly) {
        console.log(box.footer());
        continue;
      }
      console.log(box.v);

      const hasSub = category.rules.some((r) => r.subcategory);
      let lastSub: string | undefined;
      for (let ri = 0; ri < category.rules.length; ri++) {
        const rule = category.rules[ri];
        if (hasSub && rule.subcategory !== lastSub) {
          lastSub = rule.subcategory;
          if (rule.subcategory) {
            console.log(
              box.line(` ${fmt.bold(getSubcategoryName(rule.subcategory))}`)
            );
          }
        }
        const severityLabel =
          rule.severity === "error"
            ? fmt.red("error")
            : rule.severity === "warning"
              ? fmt.yellow("warning")
              : fmt.cyan("info");
        console.log(
          box.line(
            ` ${fmt.dim(rule.id)} ${rule.name} ${fmt.dim(`(${severityLabel})`)}`
          )
        );

        for (const check of rule.checks) {
          const statusIcon = icon(check.status as "fail" | "warn");
          const pageCount = check.pages.length;
          const countStr = pageCount > 1 ? ` (${pageCount} pages)` : "";
          const carried = fmt.dim(carriedTag(check));
          console.log(
            box.line(
              `   ${statusIcon} ${check.name}: ${check.message}${countStr}${carried}`
            )
          );
          // Show affected pages (for page-scope rules)
          if (pageCount > 0) {
            const maxPages = 5;
            const pagesToShow = check.pages.slice(0, maxPages);
            for (const page of pagesToShow) {
              console.log(box.line(`     ${fmt.dim(`→ ${pathOnly(page)}`)}`));
            }
            if (pageCount > maxPages) {
              console.log(
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
              console.log(box.line(`     ${fmt.dim(`→ ${label}`)}`));
              // Show HTML snippet if present
              if (item.snippet) {
                console.log(box.line(`       ${fmt.dim(item.snippet)}`));
              }
              // Show source pages if present (for site-scope items)
              if (item.sourcePages && item.sourcePages.length > 0) {
                for (const src of item.sourcePages.slice(0, 2)) {
                  console.log(
                    box.line(`       ${fmt.dim(`from ${pathOnly(src)}`)}`)
                  );
                }
                if (item.sourcePages.length > 2) {
                  console.log(
                    box.line(
                      `       ${fmt.dim(`... +${item.sourcePages.length - 2} more pages`)}`
                    )
                  );
                }
              }
            }
            if (check.items.length > maxItems) {
              console.log(
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
          console.log(box.v);
        }
      }

      console.log(box.v);
      console.log(box.footer());
    }
  } else {
    console.log("");
    console.log(fmt.green("✓ No issues found"));
  }

  // Footer
  console.log("");
  console.log(divider());
  console.log(
    `${fmt.green(`${report.passed} passed`)} • ${fmt.yellow(`${report.warnings} warnings`)} • ${fmt.red(`${report.failed} failed`)}`
  );
  console.log(divider());
  console.log("");
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

function printEditorSummary(es: EditorSummary): void {
  console.log(fmt.bold("EDITOR'S SUMMARY"));
  console.log(fmt.dim(EDITOR_SUMMARY_NOTE));
  console.log("");
  for (const para of es.prose.split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    console.log(trimmed);
    console.log("");
  }
  if (es.bigTicket.length > 0) {
    console.log(fmt.bold("Big-ticket items:"));
    for (const item of es.bigTicket) console.log(`  ${fmt.dim("•")} ${item}`);
    console.log("");
  }
  if (es.verdict) console.log(`${fmt.bold("Verdict:")} ${es.verdict}`);
}

function printSiteProfile(meta: SiteMetadata): void {
  console.log(fmt.bold("SITE PROFILE"));
  console.log(fmt.dim(SITE_PROFILE_NOTE));
  console.log("");
  for (const row of siteProfileRows(meta)) {
    const label = fmt.bold(row.label.padEnd(12));
    const value = row.url ? `${row.value} ${fmt.dim(row.url)}` : row.value;
    console.log(`  ${label} ${value}`);
  }
  const flags = siteProfileFlags(meta);
  if (flags) console.log(fmt.dim(`Flags: ${flags}`));
}

function printDomainStats(stats: DomainStats): void {
  const rows = domainStatRows(stats.metrics);
  if (rows.length === 0) return;
  console.log(fmt.bold("DOMAIN STATS"));
  console.log(fmt.dim(DOMAIN_STATS_NOTE));
  console.log("");
  for (const row of rows) {
    console.log(`  ${fmt.bold(row.label.padEnd(18))} ${row.value}`);
  }
  const bands = positionBands(stats.metrics.positions);
  if (bands.length > 0) {
    const dist = bands.map((b) => `${b.label} ${b.count}`).join(fmt.dim(" · "));
    console.log(fmt.dim(`  Organic positions: `) + dist);
  }
}

function printTechnologies(tech: ReportTechnologies): void {
  console.log(fmt.bold("TECHNOLOGIES"));
  const summary = techChangeSummary(tech);
  const added = tech.added.length > 0 ? fmt.green(`+${tech.added.length}`) : "";
  const removed =
    tech.removed.length > 0 ? fmt.red(`-${tech.removed.length}`) : "";
  const delta = [added, removed].filter(Boolean).join(" ");
  console.log(
    fmt.dim(
      `Detected stack — not part of the score.${summary ? ` ${summary}.` : ""}`
    ) + (delta ? ` ${delta}` : "")
  );
  console.log("");
  for (const group of groupTechnologies(tech.items)) {
    const names = group.items
      .map((t) => `${t.name}${t.version ? fmt.dim(` ${t.version}`) : ""}`)
      .join(fmt.dim(" · "));
    console.log(`${group.emoji} ${fmt.bold(group.label.padEnd(22))} ${names}`);
  }
}

function printGroupBreakdown(groups: GroupScore[]): void {
  if (groups.length === 0) return;

  console.log(fmt.bold("Group Breakdown:"));
  console.log(divider());

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

    console.log(`${name} ${bar}  ${pct}   ${p}  ${w}  ${f}`);
  }

  console.log("");
}

function printCategoryBreakdown(score: HealthScore): void {
  if (score.overall === null) {
    console.log(
      `Health Score: ${fmt.dim("N/A")} ${fmt.dim("(no auditable pages)")}`
    );
    console.log("");
    return;
  }
  const colorFn = scoreColor(score.overall);
  console.log(
    `Health Score: ${colorFn(`${score.overall}/100`)} ${fmt.dim(`(${getScoreGrade(score.overall)})`)}`
  );
  console.log("");

  // The 4 top-level group scores (#1017), above the finer categories — mirrors
  // text.ts's/markdown.ts's "Group Breakdown" so the console default matches
  // the other report formats and cloud's group-score summary.
  printGroupBreakdown(score.groups ?? []);

  if (score.categories.length === 0) return;

  console.log(fmt.bold("Category Breakdown:"));
  console.log(divider());

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

    console.log(`${name} ${bar}  ${pct}   ${p}  ${w}  ${f}`);
  }

  console.log("");
  console.log(
    `Total: ${fmt.green(`${score.passedCount} passed`)}, ${fmt.yellow(`${score.warningCount} warnings`)}, ${fmt.red(`${score.errorCount} errors`)}`
  );
}
