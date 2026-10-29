// Console report output

import type { EditorSummaryView } from "@squirrelscan/report";

import { stripControlCharsPreservingSgr } from "@squirrelscan/core-contracts/control-chars";
import { AUDIT_FAILURE_NEXT_STEP } from "@squirrelscan/core-contracts/failure-reason";
import {
  reportFailureReasonCode,
  wafBlockedPagesLines,
  wafBlockedSeedCopy,
} from "@squirrelscan/report";
import {
  affectedPages,
  affectedPagesSuffix,
  hasItemSources,
  checkPagesScopedAway,
  checkScopeLine,
  itemLabel,
  itemSourceView,
  moreSourcePages,
  regionScopeLine,
  REPORT_SOURCE_PAGES_PREVIEW,
  sourceRowText,
  componentFixRollups,
  fixRollupLine,
  ruleFixCoverage,
  ruleSiteResourceCoverage,
  siteResourceFixLine,
  uncoveredItems,
  withSiteResourceCoverage,
  carriedTag,
  coverageLine,
  scanScopeLine,
  seedRedirectFollowUp,
  seedRedirectLine,
  startRedirectLine,
  getGroupName,
  getSubcategoryName,
  groupTechnologies,
  itemsNotListed,
  itemsNotListedLine,
  passedRuleScope,
  reportPassedRules,
  techChangeSummary,
  structureChromeLine,
  structureDegradedLine,
  structureRowDetail,
  structurePageTypesLine,
  structureRows,
  structureTotalsLine,
  ENTITY_CONSOLE_LIMIT,
  ENTITY_EMPTY_MESSAGE,
  entityLabel,
  entityPageTotal,
  primaryEntities,
  privateTargetLine,
  notCheckedDetailLines,
  stableIdPercent,
  DOMAIN_STATS_NOTE,
  domainStatRows,
  positionBands,
  EDITOR_SUMMARY_NOTE,
  editorSummaryView,
  priorityEffortLabel,
  SITE_PROFILE_NOTE,
  siteProfileFlags,
  siteProfileRows,
} from "@squirrelscan/report";

import type {
  AuditReport,
  DomainStats,
  EntityMap,
  GroupScore,
  HealthScore,
  ReportStructure,
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
  /** List the rules that passed after the issues (`--include-passed`). */
  includePassed?: boolean;
}

export function generateConsoleReport(
  report: AuditReport,
  opts: ConsoleReportOptions = {}
): void {
  // Failed/blocked audit (#489): no real audit happened — show the state, not
  // a (meaningless) grade. Skip the score line and category breakdown entirely.
  // (`partial`/`completed`/absent fall through to the normal score below.)
  if (report.status === "failed" || report.status === "blocked") {
    const throttled = !!report.rateLimited && report.rateLimited.pages > 0;
    const label =
      report.status === "blocked"
        ? // #1829: a throttled block is not a bot wall, and the two need
          // opposite fixes. Naming it here is the difference between the reader
          // editing WAF rules and the reader slowing the crawl down.
          throttled
          ? "AUDIT RATE LIMITED"
          : "AUDIT BLOCKED"
        : "AUDIT FAILED";
    log("");
    log(divider());
    log(fmt.bold(fmt.red(label)));
    log(
      `${fmt.dim(report.baseUrl)} • ${report.statusReason ?? "No auditable pages"}`
    );
    // #1822: the reason above names the failure class; this says what to do
    // about that class, so the terminal is not the one surface without it.
    if (report.status === "failed") {
      log(fmt.dim(AUDIT_FAILURE_NEXT_STEP[reportFailureReasonCode(report)]));
    }
    // #1253: a WAF or bot manager served a challenge or block page instead of
    // the site. Say who, what matched, the code, and what to do about it.
    const wafSeed = wafBlockedSeedCopy(report);
    if (wafSeed) {
      log(fmt.dim(`Code: ${wafSeed.code}`));
      log(fmt.bold("To get a full audit:"));
      for (const remedy of wafSeed.remedies) log(`  - ${remedy}`);
    }
    // A seed that redirects off-site and is refused is a common way to end up
    // here with nothing to audit, so this branch needs the disclosure too.
    const redirect = seedRedirectLine(report);
    if (redirect) log(fmt.yellow(redirect));
    // squirrelscan/repo#3480: the step that fits a site that moved is the
    // exact command for where it went; a sign-in page needs authentication,
    // and auditing the sign-in host would grade the wrong site.
    const followUp = seedRedirectFollowUp(report);
    if (followUp?.kind === "audit") {
      log(`Audit the destination instead: ${fmt.bold(followUp.command)}`);
    } else if (followUp?.kind === "sign_in") {
      log(
        `${followUp.origin} is a sign-in page, so the site needs authentication before it can be audited: ${followUp.docsUrl}`
      );
    }
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
  log(divider());

  // #1253: pages a WAF or bot manager blocked. Never audited, never scored.
  const blockedPageLines = wafBlockedPagesLines(report);
  if (blockedPageLines.length > 0) {
    const [summary, ...listed] = blockedPageLines;
    log("");
    log(fmt.yellow(summary!));
    for (const line of listed) log(`  ${fmt.dim(line)}`);
  }

  // Editor's summary — report-only Pro exec narrative, surfaced at the top.
  const editorSummary = editorSummaryView(report.editorSummary, report);
  if (editorSummary) {
    log("");
    printEditorSummary(editorSummary);
    if (editorSummary.priorities.length > 0) {
      log("");
      printPriorities(editorSummary);
    }
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

  if (report.entityMap) {
    log("");
    printEntities(report.entityMap);
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

        // #2341: resource units first, then component units, over one coverage.
        const siteResources = ruleSiteResourceCoverage(rule);
        const coverage = withSiteResourceCoverage(
          ruleFixCoverage(rule),
          siteResources,
          rule
        );
        for (const group of siteResources.groups) {
          log(
            box.line(`   ${fmt.bold(siteResourceFixLine(group, 5, pathOnly))}`)
          );
        }
        for (const rollup of componentFixRollups(coverage.groups)) {
          // One actionable line per REPAIR, not per faulty element in a block.
          log(box.line(`   ${fmt.bold(fixRollupLine(rollup, 5, pathOnly))}`));
        }

        for (const check of rule.checks) {
          const statusIcon = icon(check.status as "fail" | "warn");
          const pageCount = check.pages.length;
          // pub#837: a check whose items are links counts the pages that carry them.
          const countStr = hasItemSources(check)
            ? affectedPagesSuffix(check, affectedPages(check).count)
            : pageCount > 1
              ? ` (${pageCount} pages)`
              : "";
          const carried = fmt.dim(carriedTag(check));
          log(
            box.line(
              `   ${statusIcon} ${check.name}: ${check.message}${countStr}${carried}`
            )
          );
          // A fully covered rule already listed its pages once per repair target above.
          const uncovered =
            coverage.mode === "full"
              ? []
              : coverage.mode === "partial"
                ? check.pages.filter((page) =>
                    coverage.uncoveredPages.includes(page)
                  )
                : check.pages;
          // pub#846: a check that only reads one shared region names it, and a
          // check whose findings name their regions leaves its page list out.
          const affected = affectedPages(check).count;
          // pub#857: and so does a check on every page of one page type.
          const checkScope = checkScopeLine(check, affected, report.structure);
          if (checkScope) {
            log(box.line(`     ${fmt.dim(checkScope)}`));
          } else if (
            uncovered.length > 0 &&
            !checkPagesScopedAway(check, affected, report.structure)
          ) {
            // Show affected pages (for page-scope rules)
            const maxPages = 5;
            if (coverage.mode === "partial") {
              log(
                box.line(
                  `     ${fmt.dim(`not attributed to a shared component (${uncovered.length}):`)}`
                )
              );
            }
            const pagesToShow = uncovered.slice(0, maxPages);
            for (const page of pagesToShow) {
              log(box.line(`     ${fmt.dim(`→ ${pathOnly(page)}`)}`));
            }
            if (uncovered.length > maxPages) {
              log(
                box.line(
                  `     ${fmt.dim(`... +${uncovered.length - maxPages} more`)}`
                )
              );
            }
          }
          // Show structured items (preferred), narrowed to what the printed
          // groups did not already account for. pub#866: the "more" count adds
          // the items the audit left out of the list to those past the preview;
          // a fully covered rule's groups account for every item.
          const listedItems = uncoveredItems(check.items, coverage);
          const notListed =
            coverage.mode === "full" ? 0 : itemsNotListed(check);
          if (listedItems.length > 0) {
            const maxItems = 5;
            const itemsToShow = listedItems.slice(0, maxItems);
            for (const item of itemsToShow) {
              // Source pages (site-scope items): each page once, with its
              // links and where they sit (pub#837). An item scoped to a
              // region names it, then its pages outside it, and its label
              // drops the section phrase the region says (pub#846).
              const view = itemSourceView(item, report.structure);
              const label = itemLabel(item, view.scope) ?? item.id;
              log(box.line(`     ${fmt.dim(`→ ${label}`)}`));
              // Show HTML snippet if present
              if (item.snippet) {
                log(box.line(`       ${fmt.dim(item.snippet)}`));
              }
              if (view.scope) {
                log(box.line(`       ${fmt.dim(regionScopeLine(view.scope))}`));
              }
              const shown = view.rows.slice(0, REPORT_SOURCE_PAGES_PREVIEW);
              for (const row of shown) {
                log(
                  box.line(
                    `       ${fmt.dim(`from ${sourceRowText(pathOnly(row.page), row.detail)}`)}`
                  )
                );
              }
              const hidden = Math.max(0, view.total - shown.length);
              if (hidden > 0) {
                log(
                  box.line(
                    `       ${fmt.dim(`... ${moreSourcePages(hidden)}`)}`
                  )
                );
              }
            }
            const more = Math.max(0, listedItems.length - maxItems) + notListed;
            if (more > 0) {
              log(
                box.line(
                  `     ${fmt.dim(`... +${more.toLocaleString("en-US")} more`)}`
                )
              );
            }
          } else if (notListed > 0) {
            log(box.line(`     ${fmt.dim(itemsNotListedLine(notListed))}`));
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

  const passedRules = reportPassedRules(report, opts.includePassed);
  if (passedRules.length > 0) {
    log("");
    const ruleCount = `${passedRules.length} rule${passedRules.length === 1 ? "" : "s"}`;
    log(fmt.bold(`PASSED ${fmt.dim(`(${ruleCount})`)}`));
    let lastCategory: string | undefined;
    for (const rule of passedRules) {
      if (rule.categoryCode !== lastCategory) {
        lastCategory = rule.categoryCode;
        log("");
        log(` ${fmt.bold(rule.categoryName)}`);
      }
      log(
        `   ${icon("pass")} ${fmt.dim(rule.id)} ${rule.name} ${fmt.dim(`(${passedRuleScope(rule)})`)}`
      );
    }
  }

  // Report detail: the last section, after every finding and the passed rules.
  printReportDetail(report, opts);

  // Footer
  log("");
  log(divider());
  // The score's warning count (advisory info-rule warnings left out), so the
  // footer agrees with the "Total:" line below it (repo#2395).
  const warningTotal = report.healthScore?.warningCount ?? report.warnings;
  log(
    `${fmt.green(`${report.passed} passed`)} • ${fmt.yellow(`${warningTotal} warnings`)} • ${fmt.red(`${report.failed} failed`)}`
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
  if (es.priorities.length === 0 && es.bigTicket.length > 0) {
    log(fmt.bold("Big-ticket items:"));
    for (const item of es.bigTicket) log(`  ${fmt.dim("•")} ${item}`);
    log("");
  }
  if (es.verdict) log(`${fmt.bold("Verdict:")} ${es.verdict}`);
}

function printPriorities(es: EditorSummaryView): void {
  // One line each: model text with an embedded newline would break the indent.
  const line = (value: string) => value.replace(/\s+/g, " ").trim();
  log(fmt.bold("PRIORITIES"));
  for (const [i, p] of es.priorities.entries()) {
    log(
      `  ${fmt.bold(`${i + 1}.`)} ${fmt.bold(line(p.title))} ${fmt.dim(`(${priorityEffortLabel(p.effort)})`)}`
    );
    if (p.why) log(`     ${fmt.dim(line(p.why))}`);
    log(`     ${line(p.action)}`);
  }
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

/**
 * REPORT DETAIL: the last section of the report, after every finding. What this audit did not
 * check (yellow, so a skipped check never reads as a clean one), the page structure, then the
 * scope and coverage notes that qualify the score. Nothing is printed when there is none of it.
 */
function printReportDetail(
  report: AuditReport,
  opts: ConsoleReportOptions
): void {
  const notChecked = notCheckedDetailLines(report);
  const scan: string[] = [];
  // #1829: coverage lost to throttling. Yellow, because it changes how much of the report to trust.
  const rateLimited =
    report.rateLimited && report.rateLimited.pages > 0
      ? report.rateLimited
      : null;
  if (rateLimited) {
    const hosts =
      rateLimited.hosts.length > 0 ? rateLimited.hosts.join(", ") : "the host";
    scan.push(
      fmt.yellow(
        `Rate limited by ${hosts}: ${rateLimited.pages} page${rateLimited.pages === 1 ? "" : "s"} not verified. Set [crawler] per_host_concurrency = 1 and per_host_delay_ms = 500 to crawl it politely.`
      )
    );
  }
  // Refused off-site seed redirect (#1418): the URL at the top is what was graded, NOT where the
  // seed pointed.
  const seedRedirect = seedRedirectLine(report);
  if (seedRedirect) scan.push(fmt.yellow(seedRedirect));
  // #1281: the start URL redirected and the redirect was followed.
  const startRedirect = startRedirectLine(report);
  if (startRedirect) scan.push(fmt.dim(startRedirect));
  // Scan scope (#1180) + smart-audits coverage (#110): the score reads with its basis. The
  // capped-crawl hint stays with pageLimitHint (commands layer).
  const scope = scanScopeLine(report);
  if (scope) scan.push(fmt.dim(scope));
  const cov = coverageLine(report);
  if (cov) scan.push(fmt.dim(cov));
  // pub#629: once, here, rather than a skipped line per rule and page.
  const privateTarget = privateTargetLine(report);
  if (privateTarget) scan.push(fmt.dim(privateTarget));
  const partial = partialAuditLine(opts.ruleFilter, report.healthScore);
  if (partial) scan.push(fmt.dim(partial));
  if (notChecked.length === 0 && !report.structure && scan.length === 0) return;

  log("");
  log(fmt.bold("REPORT DETAIL"));
  if (notChecked.length > 0) {
    log("");
    log(fmt.bold("Not checked"));
    for (const line of notChecked) log(fmt.yellow(`  - ${line}`));
  }
  if (report.structure) {
    log("");
    printStructure(report.structure);
  }
  if (scan.length > 0) {
    log("");
    log(fmt.bold("Scan details"));
    for (const line of scan) log(`  ${line}`);
  }
}

/**
 * The Page structure block (#2307): which part of the page the links sit in, and the page types.
 * Report-only and non-scoring, like Technologies. Printed inside Report detail.
 */
function printStructure(structure: ReportStructure): void {
  log(fmt.bold("Page structure"));
  log(fmt.dim("Where the links on your pages sit. Not part of the score."));
  const typesLine = structurePageTypesLine(structure);
  if (typesLine) {
    log("");
    log(typesLine);
  }
  const rows = structureRows(structure);
  if (rows.length > 0) {
    log("");
    const width = Math.max(...rows.map((r) => r.section.length));
    for (const row of rows) {
      log(`${row.section.padEnd(width)}  ${fmt.dim(structureRowDetail(row))}`);
    }
  }
  const totals = structureTotalsLine(structure);
  if (totals) log(fmt.dim(totals));
  const chromeLine = structureChromeLine(structure);
  if (chromeLine) {
    log("");
    log(chromeLine);
  }
  const degradedLine = structureDegradedLine(structure);
  if (degradedLine) log(fmt.dim(degradedLine));
}

/**
 * The Entities block (#2091): the site's own JSON-LD as one graph.
 *
 * Report-only and non-scoring, like Technologies. Leads with the counts that
 * name a problem (no stable `@id`, conflicting values, references to nothing)
 * and then the three entities the site declares most, because those are the
 * ones a search engine is trying to reconcile.
 */
function printEntities(map: EntityMap): void {
  log(fmt.bold("ENTITIES"));
  if (map.summary.nodeCount === 0) {
    log(fmt.dim(ENTITY_EMPTY_MESSAGE));
    return;
  }

  const s = map.summary;
  const flags: string[] = [];
  if (s.conflictCount > 0)
    flags.push(fmt.yellow(`${s.conflictCount} conflicting`));
  if (s.danglingCount > 0) flags.push(fmt.red(`${s.danglingCount} dangling`));
  if (s.nodesWithoutIdCount > 0) {
    flags.push(fmt.yellow(`${s.nodesWithoutIdCount} without @id`));
  }
  log(
    fmt.dim("The site's own JSON-LD — not part of the score. ") +
      `${s.nodeCount} entities · ${s.edgeCount} references · ${stableIdPercent(map)}% with a stable @id` +
      (flags.length > 0 ? ` · ${flags.join(fmt.dim(" · "))}` : "")
  );
  log("");
  for (const node of primaryEntities(map).slice(0, ENTITY_CONSOLE_LIMIT)) {
    const id = node.id ? fmt.dim(` ${node.id}`) : fmt.yellow(" no @id");
    log(
      `${fmt.bold(entityLabel(node))} ${fmt.dim(`(${node.types.join(", ")})`)} ` +
        fmt.dim(`${node.occurrences}x on ${entityPageTotal(node)} page(s)`) +
        id
    );
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
