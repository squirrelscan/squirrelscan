// Compact LLM-optimized report

import type { AuditReport, CheckItem } from "../types";
import { getScoreGrade } from "../scoring";
import { getGroupName } from "../categories";
import { groupIssuesByCategory, flattenIssuesBySeverity, reportPassedRules } from "../grouping";
import {
  affectedPages,
  ruleAffectedPages,
  ruleAffectedRollup,
  ruleCarriedPageCount,
} from "../affected-pages";
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
import { hasCarriedPages } from "../page-type-scope";

/** "in the site footer, ..." from "In the site footer, ...", to sit inside a sentence. */
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
import { getDocsUrl } from "../docs";
import { domainAgeYears } from "../site-metadata";
import { lockedRulesMessage } from "../locked-rules";
import { privateTargetLine, privateTargetSkippedRules } from "../private-target";
import { notCheckedLine, notCheckedRules } from "../not-checked";
import { editorSummaryView } from "../editor-summary";
import { collectInfoChecks } from "../info-checks";
import {
  ENTITY_FINDING_LIMIT,
  ENTITY_TABLE_LIMIT,
  conflictedEntities,
  danglingEdges,
  danglingTargetId,
  entitiesWithoutId,
  entityLabel,
  entityPageTotal,
  primaryEntities,
  stableIdPercent,
} from "../entities";
import {
  structureChromeLine,
  structureDegradedLine,
  structureAttr,
  structurePageTypesLine,
  structureSectionName,
  structureTotalsLine,
} from "../structure";
import {
  followedStartRedirect,
  publishedReportNote,
  scanScopeUnfetched,
  seedRedirect,
  seedRedirectFollowUp,
} from "../coverage";
import { describeSlot, fixRollupLine, fixUnits, ruleFixCoverage } from "../component-presentation";
import {
  ruleSiteResourceCoverage,
  siteResourceFixLine,
  withSiteResourceCoverage,
} from "../site-resource-presentation";

import { uncoveredItems } from "../component-presentation";

/** Bounded page sample per fix group in LLM output. */
const LLM_FIX_GROUP_PAGES = 3;
import { LLM_REPORT } from "@squirrelscan/core-contracts/limits";
import { formatSiteWideItem, siteWideContext, siteWideItem } from "../site-wide-items";
import { stripControlChars } from "@squirrelscan/core-contracts/control-chars";
import { AUDIT_FAILURE_NEXT_STEP_THIRD } from "@squirrelscan/core-contracts/failure-reason";
import { refusedFetchLines, reportFailureReasonCode } from "../failure-notice";
import { safeWafBlocked, wafBlockedSeedCopy } from "../waf-blocked";

export interface LlmRenderOptions {
  /** Roll up groups that are one repair (default true). */
  componentRollup?: boolean;
  /** Collapse site-wide items into one line (default true). */
  siteWideCollapse?: boolean;
  version?: string;
  /** List the rules that passed after the issues (`--include-passed`). */
  includePassed?: boolean;
  /**
   * Add the `<info-checks>` block (`--include-info`, #669). Off by default: the
   * LLM report is read against a token budget, and most info checks are "nothing to
   * check" notes. The JSON report always has them.
   */
  includeInfo?: boolean;
}

/** Pages named per info check in the LLM output; the true count is in `pages`. */
const INFO_CHECK_PAGES = 3;
/** Info checks listed in the LLM output; the rest are counted, and all are in the JSON report. */
const INFO_CHECKS_LISTED = 25;

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function compressUrl(url: string, baseOrigin: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.origin === baseOrigin) return parsed.pathname + parsed.search + parsed.hash;
  } catch {}
  return url;
}

function indent(level: number): string {
  return " ".repeat(level);
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function getPathDepth(url: string, baseOrigin: string): number {
  try {
    const parsed = new URL(url, baseOrigin || undefined);
    return parsed.pathname.split("/").filter(Boolean).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function sampleAffectedPagesBreadthFirst(
  pages: string[],
  baseOrigin: string,
  maxPages: number = LLM_REPORT.maxAffectedPages,
): string[] {
  const unique = Array.from(new Set(pages));
  unique.sort((a, b) => {
    const depthDiff = getPathDepth(a, baseOrigin) - getPathDepth(b, baseOrigin);
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });
  return unique.slice(0, maxPages);
}

export function serializeMetaValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return truncateText(value, LLM_REPORT.maxMetaValueLength);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const json = JSON.stringify(value);
    if (!json) return "";
    return truncateText(json, LLM_REPORT.maxMetaValueLength);
  } catch {
    return truncateText(String(value), LLM_REPORT.maxMetaValueLength);
  }
}

export function renderLlm(report: AuditReport, options?: LlmRenderOptions): string {
  const lines: string[] = [];
  const siteWide = siteWideContext(report, options?.siteWideCollapse !== false);
  const version = options?.version ?? "0.0.0";

  let baseOrigin = "";
  try {
    baseOrigin = new URL(report.baseUrl).origin;
  } catch {}

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<audit version="${escapeXml(version)}">`);
  lines.push(
    `<site url="${escapeXml(report.baseUrl)}" crawled="${report.totalPages}" date="${escapeXml(report.timestamp)}"/>`,
  );

  // Refused off-site seed redirect (#1418). Without this an agent reads the
  // scores as being about the URL it was handed, when the seed redirected to a
  // different site that the crawler declined to follow. `final-url` is a URL
  // the AUDITED SITE chose: it is reported, never a destination to go fetch.
  const refusedSeedRedirect = seedRedirect(report);
  if (refusedSeedRedirect) {
    // `final-url` is omitted when the stored target did not survive
    // canonicalization: an agent that reads only attributes then sees no URL
    // rather than one nobody vetted, and the note below says why.
    const finalUrlAttr = refusedSeedRedirect.finalUrl
      ? ` final-url="${escapeXml(refusedSeedRedirect.finalUrl)}"`
      : "";
    lines.push(`<seed-redirect${finalUrlAttr} followed="false">`);
    lines.push(`${indent(1)}${escapeXml(refusedSeedRedirect.note)}`);
    lines.push("</seed-redirect>");
  }

  // Followed start redirect (#1281): the URL the user gave is not the site
  // graded above. Every URL is one the redirecting site chose: reported, never a
  // destination to go fetch.
  const startRedirect = followedStartRedirect(report);
  if (startRedirect) {
    lines.push(
      `<start-redirect original-url="${escapeXml(startRedirect.originalUrl)}" final-url="${escapeXml(startRedirect.finalUrl)}" followed="true">`,
    );
    for (const hop of startRedirect.chain) {
      lines.push(`${indent(1)}<hop status="${hop.status}">${escapeXml(hop.url)}</hop>`);
    }
    lines.push(`${indent(1)}${escapeXml(startRedirect.note)}`);
    lines.push("</start-redirect>");
  }

  // Failed/blocked audit (#792): nothing was audited. Without this an agent
  // reads <score overall="N/A"> + empty <issues/> as a clean pass. State it
  // plainly and 3rd-person — a block is the site refusing the crawler, not a
  // squirrelscan outage — with next steps the agent can relay to the owner.
  // #1829: coverage lost to throttling, as an attribute an agent can read
  // without parsing prose. Emitted for EVERY status, because the question
  // "are these numbers the whole site?" applies to a completed run too.
  if (report.rateLimited && report.rateLimited.pages > 0) {
    const hosts = report.rateLimited.hosts.join(", ");
    const unfetched = report.rateLimited.unfetched ?? 0;
    const unfetchedAttr = unfetched > 0 ? ` unfetched="${unfetched}"` : "";
    lines.push(
      `<rate-limited pages="${report.rateLimited.pages}"${unfetchedAttr} hosts="${escapeXml(hosts)}">`,
    );
    lines.push(
      `${indent(1)}${report.rateLimited.pages} page(s) could not be verified because the host rate limited the crawler (429/430). Their status is UNKNOWN, not broken, and they were excluded from scoring. Do not report them as dead links.`,
    );
    if (unfetched > 0) {
      lines.push(
        `${indent(1)}${unfetched} more URL(s) were discovered but never fetched. The pages above and these are missing from the audit, so the site is larger than the page count suggests.`,
      );
    }
    lines.push("</rate-limited>");
  }

  if (report.status === "partial" && report.statusReason) {
    lines.push(`<status state="partial" reason="${escapeXml(report.statusReason)}">`);
    lines.push(
      `${indent(1)}A real audit ran and the scores below are valid for the pages that were fetched, but the crawl did not cover the whole site. Treat missing pages as unaudited, not as passing.`,
    );
    lines.push("</status>");
  }

  if (report.status === "failed" || report.status === "blocked") {
    const reasonAttr = report.statusReason ? ` reason="${escapeXml(report.statusReason)}"` : "";
    const throttled = !!report.rateLimited && report.rateLimited.pages > 0;
    lines.push(`<status state="${report.status}"${reasonAttr}>`);
    const wafSeed = wafBlockedSeedCopy(report);
    if (wafSeed) {
      // #1253: a perimeter provider served a challenge or block page instead of the site.
      lines.push(`${indent(1)}${escapeXml(wafSeed.headline)} ${escapeXml(wafSeed.saw)} This is a block on the site side, NOT a squirrelscan outage, and the page that was served is not the site: do not report findings about it.`);
      lines.push(`${indent(1)}To get a full audit, relay one of these to the user:`);
      for (const remedy of wafSeed.remedies) lines.push(`${indent(2)}<remedy>${escapeXml(remedy)}</remedy>`);
    } else if (report.status === "blocked" && throttled) {
      lines.push(
        `${indent(1)}The host rate limited the crawler (429/430) before any pages could be read, so nothing was audited. This is throttling, NOT bot protection: allowlisting a crawler will not help.`,
      );
      lines.push(
        `${indent(1)}To get a full audit: crawl more slowly with \`[crawler] per_host_concurrency = 1\` and \`per_host_delay_ms = 500\` in squirrel.toml, raise \`max_backoff_ms\`, or retry later with \`squirrel audit ${escapeXml(report.baseUrl)}\`.`,
      );
    } else if (report.status === "blocked") {
      lines.push(
        `${indent(1)}The site refused the crawler before any pages could be read (a 403 or 429 from bot protection, a firewall, an auth wall, or rate limiting), so nothing was audited. This is a block on the site side, not a squirrelscan outage.`,
      );
      lines.push(
        `${indent(1)}To get a full audit: allowlist the squirrelscan crawler, turn off bot fight mode for the audit, or run the CLI from a trusted network with \`squirrel audit ${escapeXml(report.baseUrl)}\`.`,
      );
    } else {
      // #1822: `reason` on the tag is the one-line class; the body says what
      // that class means and what to do, third person for the agent surface.
      // `unknown` keeps the pre-#1822 sentence.
      const code = reportFailureReasonCode(report);
      lines.push(`${indent(1)}${escapeXml(AUDIT_FAILURE_NEXT_STEP_THIRD[code])}`);
      // squirrelscan/repo#3480: retrying a URL that redirects off-site fails
      // the same way. The destination is the SITE's choice, so it is offered
      // for the user to confirm, never as a target to go and fetch unasked.
      const followUp = seedRedirectFollowUp(report);
      if (followUp?.kind === "audit") {
        lines.push(
          `${indent(1)}The entry URL redirects to ${escapeXml(followUp.origin)}. If the user confirms that is the site they meant, audit it with \`${escapeXml(followUp.command)}\`.`,
        );
      } else if (followUp?.kind === "sign_in") {
        lines.push(
          `${indent(1)}${escapeXml(followUp.origin)} is a sign-in page: the site needs authentication before it can be audited. Do not audit the sign-in host. See ${followUp.docsUrl}.`,
        );
      } else {
        lines.push(
          `${indent(1)}Run the CLI with \`squirrel audit ${escapeXml(report.baseUrl)}\` to retry locally.`,
        );
      }
    }
    lines.push("</status>");
  }

  // #1253: pages a WAF or bot manager blocked. State plainly that what they
  // served is not the site, so an agent never "fixes" a challenge page.
  const wafBlocked = safeWafBlocked(report);
  if (wafBlocked) {
    const providers = escapeXml(wafBlocked.providers.join(", "));
    const code = escapeXml(wafBlocked.seed?.code ?? wafBlocked.pages[0]?.code ?? "blocked_by_waf");
    lines.push(`<waf-blocked pages="${wafBlocked.total}" providers="${providers}" code="${code}">`);
    lines.push(
      `${indent(1)}${wafBlocked.total} page(s) were answered with a challenge or block page by a WAF or bot manager. They were excluded from rule evaluation and scoring, so they carry no findings. Do not report them as broken pages.`,
    );
    for (const page of wafBlocked.seed ? [wafBlocked.seed, ...wafBlocked.pages] : wafBlocked.pages) {
      const by = page.provider ? ` provider="${escapeXml(page.provider)}"` : "";
      lines.push(
        `${indent(1)}<page url="${escapeXml(page.url)}" status="${page.status}"${by} signal="${escapeXml(page.signal)}"/>`,
      );
    }
    lines.push("</waf-blocked>");
  }

  // Root fetches the site refused. Their absence is UNKNOWN, so an agent
  // must not turn them into "add a robots.txt" or "add a sitemap" fixes.
  const refused = refusedFetchLines(report);
  if (refused.length > 0) {
    lines.push("<refused-fetches>");
    lines.push(
      `${indent(1)}The site refused these requests, so whether the resources exist is UNKNOWN. Do not report them as missing.`,
    );
    for (const line of refused) lines.push(`${indent(1)}<fetch>${escapeXml(line)}</fetch>`);
    lines.push("</refused-fetches>");
  }

  // null ⇒ N/A (failed/0-page audit) — never coerce to 0/"F" (#586).
  const overall = report.healthScore?.overall ?? null;
  const grade = overall === null ? "N/A" : getScoreGrade(overall);
  lines.push(`<score overall="${overall ?? "N/A"}" grade="${grade}">`);
  // Top-level group scores (#626), above the finer per-category scores.
  for (const g of report.healthScore?.groups ?? []) {
    lines.push(
      `${indent(1)}<group name="${escapeXml(getGroupName(g.group))}" score="${g.score}" errors="${g.failed}" warnings="${g.warnings}"/>`,
    );
  }
  for (const cat of report.healthScore?.categories ?? []) {
    lines.push(`${indent(1)}<cat name="${escapeXml(cat.name)}" score="${cat.score}"/>`);
  }
  lines.push("</score>");

  lines.push(
    `<summary passed="${report.passed}" warnings="${report.warnings}" failed="${report.failed}"/>`,
  );

  // Smart audits (#110): coverage — audited N of M known pages; the rest of the
  // findings are carried forward from prior runs (page not re-crawled this run).
  if (report.coverage) {
    const c = report.coverage;
    // (#1652) `unrendered` is emitted only when non-zero so the attribute set is
    // byte-identical for every report without never-rendered pages. It is NOT
    // folded into `carried`: an agent reading carried="N" is entitled to assume
    // a prior audit observed those N.
    const unrendered = c.unrenderedFindings ?? 0;
    const unrenderedAttr = unrendered > 0 ? ` unrendered="${unrendered}"` : "";
    lines.push(
      `<coverage audited="${c.auditedPages}" known="${c.knownPages}" carried="${c.carriedFindings}"${unrenderedAttr}/>`,
    );
  }

  // Scan scope disclosure (#1180): where the audit ran + crawl cap, so an agent
  // reading the report knows what the score is based on.
  if (report.scanScope) {
    const s = report.scanScope;
    const cap = s.maxPages !== undefined ? ` max-pages="${s.maxPages}"` : "";
    // Present only when the request was clamped (#1909). An agent reading this
    // otherwise cannot tell a 5,000-page site from a refusal to crawl the rest,
    // and the LLM render is the whole response for an MCP caller.
    const requested =
      s.requestedMaxPages !== undefined
        ? ` requested-max-pages="${s.requestedMaxPages}"`
        : "";
    // Present only on a time stop: the crawl budget, not the page limit, ended it.
    const stop = s.stopReason ? ` stop-reason="${s.stopReason}"` : "";
    // In-scope URLs left queued: how much more of the site the crawl knew of.
    const left = scanScopeUnfetched(report);
    const unfetched = left > 0 ? ` unfetched="${left}"` : "";
    // Query-string variants counted with their canonical page (#858).
    const variantCount = Number(report.canonicalVariants ?? s.canonicalVariants ?? 0);
    const variants = Number.isSafeInteger(variantCount) && variantCount > 0 ? ` canonical-variants="${variantCount}"` : "";
    lines.push(
      `<scan-scope origin="${s.origin}" crawled="${s.pagesCrawled}"${cap}${requested} capped="${s.capped}"${stop}${unfetched}${variants}/>`,
    );
  }

  // repo#2661: a capped published report lists a sample of each issue's pages
  // and items beside the true counts. Escaped like every other value here: the
  // numbers in it come off the report's own JSON.
  const capped = publishedReportNote(report);
  if (capped) lines.push(`<published-summary>${escapeXml(capped)}</published-summary>`);

  // The audit level, so an agent knows what kind of audit the score rests on
  // and which settings were changed from the level (a custom audit). The
  // changed setting keys are the core-contracts AuditSettings names.
  if (report.auditLevel) {
    const a = report.auditLevel;
    // Escaped like every other attribute here: the snapshot can come from a
    // stored or fetched report, and this output is read by an agent.
    lines.push(
      `<audit-level level="${escapeXml(String(a.level))}" based-on="${escapeXml(String(a.basedOn))}" changes="${escapeXml(a.changes.map(String).join(","))}" pages="${Number(a.settings.pages)}"${a.offline === true ? ` offline="true" cloud-checks="false" render="off" external-links="false"` : ""}/>`,
    );
  }

  // Rule-result cache disclosure (#1990). An agent asking "is this a fresh
  // reading of my site?" cannot tell from the findings — a replay is identical by
  // construction — so the answer has to be stated (#1981).
  // #1280: how many first-party scripts the script rules evaluated, so two
  // runs (or a run with and without store_scripts) compare.
  if (typeof report.scriptsEvaluated === "number") {
    lines.push(`<scripts-evaluated count="${Math.trunc(report.scriptsEvaluated)}"/>`);
  }

  if (report.rulesCache) {
    const rc = report.rulesCache;
    const why = rc.disabledReason ? ` disabled-reason="${rc.disabledReason}"` : "";
    lines.push(
      `<rules-cache pages-replayed="${rc.pagesReplayed}" pages-evaluated="${rc.pagesEvaluated}"${why}/>`,
    );
  }

  // Editor's summary — report-only exec narrative for the agent (does not affect the score).
  const es = editorSummaryView(report.editorSummary, report);
  if (es) {
    lines.push(`<editor-summary model="${escapeXml(es.model)}">`);
    for (const para of es.paragraphs) {
      lines.push(`${indent(1)}<para>${escapeXml(para)}</para>`);
    }
    if (es.priorities.length === 0 && es.bigTicket.length > 0) {
      lines.push(`${indent(1)}<big-ticket>`);
      for (const item of es.bigTicket) {
        lines.push(`${indent(2)}<item>${escapeXml(item)}</item>`);
      }
      lines.push(`${indent(1)}</big-ticket>`);
    }
    if (es.verdict) lines.push(`${indent(1)}<verdict>${escapeXml(es.verdict)}</verdict>`);
    lines.push("</editor-summary>");
  }

  // Ranked priorities from the editor's summary: the agent's ordered to-do list.
  if (es && es.priorities.length > 0) {
    lines.push("<priorities>");
    for (const [i, p] of es.priorities.entries()) {
      const attrs = [`rank="${i + 1}"`, `effort="${escapeXml(p.effort)}"`];
      if (p.ruleIds.length > 0) attrs.push(`rules="${escapeXml(p.ruleIds.join(" "))}"`);
      if (p.technologies.length > 0) attrs.push(`tech="${escapeXml(p.technologies.join(" "))}"`);
      lines.push(`${indent(1)}<priority ${attrs.join(" ")}>`);
      lines.push(`${indent(2)}<title>${escapeXml(p.title)}</title>`);
      if (p.why) lines.push(`${indent(2)}<why>${escapeXml(p.why)}</why>`);
      lines.push(`${indent(2)}<action>${escapeXml(p.action)}</action>`);
      lines.push(`${indent(1)}</priority>`);
    }
    lines.push("</priorities>");
  }

  // Site profile — report-only context for the agent (Stage 0; does not affect the score).
  const meta = report.siteMetadata;
  if (meta) {
    const attrs: string[] = [`type="${escapeXml(meta.siteType)}"`];
    if (meta.businessCategory) attrs.push(`category="${escapeXml(meta.businessCategory)}"`);
    if (meta.audienceScope) attrs.push(`audience="${escapeXml(meta.audienceScope)}"`);
    if (meta.primaryCountry) attrs.push(`country="${escapeXml(meta.primaryCountry)}"`);
    attrs.push(`ymyl="${meta.isYMYL}"`);
    attrs.push(`local-business="${meta.isLocalBusiness}"`);
    attrs.push(`confidence="${escapeXml(meta.confidence)}"`);
    lines.push(`<site-profile ${attrs.join(" ")}>`);
    if (meta.languages && meta.languages.length > 0) {
      lines.push(`${indent(1)}<languages>${escapeXml(meta.languages.join(", "))}</languages>`);
    }
    const entityName = meta.entityName ?? meta.title;
    if (entityName) {
      const et =
        meta.entityType && meta.entityType !== "unknown"
          ? ` kind="${escapeXml(meta.entityType)}"`
          : "";
      const eu = meta.entityUrl ? ` url="${escapeXml(meta.entityUrl)}"` : "";
      lines.push(`${indent(1)}<identity name="${escapeXml(entityName)}"${et}${eu}/>`);
    }
    for (const c of meta.contacts ?? []) {
      lines.push(
        `${indent(1)}<contact kind="${escapeXml(c.kind)}" value="${escapeXml(c.value)}"/>`,
      );
    }
    for (const s of meta.socials ?? []) {
      lines.push(
        `${indent(1)}<social platform="${escapeXml(s.platform)}" url="${escapeXml(s.url)}"/>`,
      );
    }
    const years = domainAgeYears(meta);
    if (years != null || meta.registeredAt) {
      const ya = years != null ? ` years="${years}"` : "";
      const ra = meta.registeredAt ? ` registered="${escapeXml(meta.registeredAt)}"` : "";
      const rg = meta.registrar ? ` registrar="${escapeXml(meta.registrar)}"` : "";
      lines.push(`${indent(1)}<domain${ya}${ra}${rg}/>`);
    }
    lines.push("</site-profile>");
  }

  // Technologies — report-only context for the agent (does not affect the score).
  if (report.technologies && report.technologies.items.length > 0) {
    const tech = report.technologies;
    lines.push(
      `<technologies first-scan="${tech.firstScan}" added="${tech.added.length}" removed="${tech.removed.length}">`,
    );
    for (const t of tech.items) {
      const ver = t.version ? ` version="${escapeXml(t.version)}"` : "";
      lines.push(
        `${indent(1)}<tech name="${escapeXml(t.name)}" cat="${escapeXml(t.category)}"${ver}/>`,
      );
    }
    lines.push("</technologies>");
  }

  const categoryIssues = groupIssuesByCategory(report.ruleResults, report.checkTallies);

  if (categoryIssues.length > 0) {
    lines.push("<issues>");
    // Flat and severity-first (#1536): errors, then recommendations, then
    // warnings, across the whole report. No <category> wrapper — the rule
    // carries category/group as attributes, so the order an agent reads IS the
    // order it should fix in.
    for (const rule of flattenIssuesBySeverity(categoryIssues)) {
      let ruleStatus = "pass";
      for (const check of rule.checks) {
        if (check.status === "fail") {
          ruleStatus = "fail";
          break;
        }
        if (check.status === "warn") ruleStatus = "warn";
      }
  
      // Smart audits (#110): a rule's findings are "carried" when every
      // surfaced check came from pages not re-crawled this run.
      const carriedChecks = rule.checks.filter(
        (c) => c.carriedCount && c.carriedCount >= c.count,
      ).length;
      const allPagesForRule = ruleAffectedPages(rule.checks);
      const carriedPageCount = ruleCarriedPageCount(rule.checks);
      // #1135: fully carried → provenance="carried"; some-but-not-all → a
      // "N/M" fraction attribute so an agent can tell "mixed" from "fresh"
      // without walking every check.
      // (#1652) A rule every one of whose checks sits on a never-rendered page
      // is `provenance="unrendered"` — checked BEFORE the carried branch so a
      // first run can never emit provenance="carried" (nothing prior exists to
      // have carried it). Mixed unrendered/fresh falls through to the carried
      // logic, which correctly reports no carry.
      const unrenderedChecks = rule.checks.filter(
        (c) => c.unrenderedCount && c.unrenderedCount >= c.count,
      ).length;
      const carriedAttr =
        unrenderedChecks > 0 && unrenderedChecks === rule.checks.length
          ? ` provenance="unrendered"`
          : carriedChecks > 0 && carriedChecks === rule.checks.length
            ? ` provenance="carried"`
            : carriedPageCount > 0
              ? ` carried_pages="${carriedPageCount}/${allPagesForRule.size}"`
              : "";
  
      const docsUrl = getDocsUrl(rule.id);
      lines.push(
        `${indent(1)}<rule id="${escapeXml(rule.id)}" severity="${rule.severity}" category="${escapeXml(rule.categoryName)}" group="${escapeXml(rule.group)}"${rule.subcategory ? ` subcategory="${escapeXml(rule.subcategory)}"` : ""} status="${ruleStatus}"${carriedAttr} docs="${escapeXml(docsUrl)}">`,
      );
  
      // pub#837: a check whose items are links says how many pages carry them.
      const messages = rule.checks
        .map((c) =>
          c.message && hasItemSources(c)
            ? c.message + affectedPagesSuffix(c, affectedPages(c).count)
            : c.message,
        )
        .filter((m) => m);
      if (messages.length > 0) lines.push(`${indent(2)}${escapeXml(messages.join("; "))}`);
      // Shared-resource units (#2341) narrow the coverage the component units
      // computed, so the page arithmetic below counts a page as accounted for
      // whichever kind of unit named it.
      const siteResources = ruleSiteResourceCoverage(rule);
      const coverage = withSiteResourceCoverage(ruleFixCoverage(rule), siteResources, rule);
      for (const group of siteResources.groups) {
        lines.push(
          `${indent(2)}<fix-once scope="site-resource" pages="${group.affectedPageCount}" resources="${group.resourceKeys.length}">${escapeXml(
            siteResourceFixLine(group, LLM_FIX_GROUP_PAGES, (page) =>
              compressUrl(page, baseOrigin),
            ),
          )}</fix-once>`,
        );
      }
      for (const rollup of fixUnits(coverage.groups, options?.componentRollup !== false)) {
        // One actionable line per REPAIR. No hashes, no signatures, no internal
        // keys: an agent cannot act on grouping mechanics.
        const repeated = rollup.representative.attribution === "repeated-subtree";
        const tag = repeated ? "likely-shared-block" : "fix-once";
        lines.push(
          `${indent(2)}<${tag} pages="${rollup.affectedPageCount}"${
            // Only when groups were actually merged: a single-group rollup must
            // serialize exactly as it did before rollups existed.
            rollup.groups.length > 1 ? ` elements="${rollup.elementCount}"` : ""
          }>${escapeXml(
            `${fixRollupLine(rollup, LLM_FIX_GROUP_PAGES, (page) => compressUrl(page, baseOrigin), false)}${
              // One group is one element; its slot still locates the fix. For a
              // unit spanning several, the block anchor inside the line replaces it.
              rollup.groups.length === 1 ? ` [${describeSlot(rollup.representative)}]` : ""
            }`,
          )}</${tag}>`,
        );
      }
      if (rule.mixedProvenanceNote) {
        lines.push(`${indent(2)}${escapeXml(rule.mixedProvenanceNote)}`);
      }
  
      // Union of check.pages + item-level sourcePages / page-URL ids so
      // site-scope rules (blocked-links, sitemap-*) report real page counts.
      const allPages = ruleAffectedPages(rule.checks);
      // #1023 R-F / #1306: authoritative rule total = a max-based FLOOR (per-
      // check accessor), not the sampled union size — a folded/sampled rule
      // would otherwise report only its retained sample (e.g. 200/200, not
      // 200/600). `hasMore` marks the floor as a lower bound (2+ truncated
      // checks with possibly-disjoint hidden pages) → suffix "+".
      const rollup = ruleAffectedRollup(rule.checks);
      const totalLabel = `${rollup.count}${rollup.hasMore ? "+" : ""}`;
  
      // pub#846/#857: a check that names its region or its page type lists no pages here: its own
      // line says where it is. The pages of the rule's other checks are still listed, so a
      // documentation check on all 9 pages and a contact check below the share both read right.
      const scopedChecks = rule.checks.filter((c) =>
        checkPagesScopedAway(c, affectedPages(c).count, report.structure),
      );
      const openChecks = rule.checks.filter((c) => !scopedChecks.includes(c));
      const openPages = ruleAffectedPages(openChecks);
      const openRollup = ruleAffectedRollup(openChecks);
      const openLabel = `${openRollup.count}${openRollup.hasMore ? "+" : ""}`;
      // #2307: a fully covered rule has already said which pages are affected, once per
      // repair target. Repeating them as a flat list is the noise this feature was supposed to
      // remove; a partly covered one lists only the pages no repair target named.
      const legacyPages =
        coverage.mode === "full"
          ? new Set<string>()
          : coverage.mode === "partial"
            ? new Set([...openPages].filter((page) => coverage.uncoveredPages.includes(page)))
            : openPages;
      if (coverage.mode !== "full" && allPages.size > 0 && openChecks.length === 0) {
        lines.push(`${indent(2)}Pages (${totalLabel})`);
      } else if (legacyPages.size > 0) {
        const sampledPages = sampleAffectedPagesBreadthFirst(Array.from(legacyPages), baseOrigin);
        const pageList = sampledPages
          .map((p) => escapeXml(compressUrl(p, baseOrigin)))
          .join(", ");
        if (coverage.mode === "partial") {
          // Explicit: these pages were NOT attributed to a shared component, so
          // a reader never reads the absence of a group as "not affected".
          lines.push(
            `${indent(2)}Pages not attributed to a shared component (${legacyPages.size}): ${pageList}`,
          );
        } else if (sampledPages.length < openRollup.count) {
          lines.push(`${indent(2)}Pages (${sampledPages.length}/${openLabel}): ${pageList}`);
        } else {
          lines.push(`${indent(2)}Pages (${openLabel}): ${pageList}`);
        }
      }
      for (const c of scopedChecks) {
        const scope = checkScopeLine(c, affectedPages(c).count, report.structure);
        if (scope) lines.push(`${indent(2)}${escapeXml(scope)}`);
      }

      const allItems: CheckItem[] = [];
      // repo#2661: items a capped (or clamped) check left out still count.
      // `details.additional` is always items LEFT OUT of `items`: the fold's and
      // the publish clamp's dropped count, and every rule's own "first N items,
      // the rest as additional" remainder (rules/src/shared/sample-items.ts and
      // the a11y rules' slice(0, 10)). So listed + additional is the total.
      let itemsLeftOut = 0;
      // The items of every check of the rule are listed together, so one that carries pages from
      // an earlier audit keeps all of them on their page rows (pub#860).
      let ruleCarriesPages = false;
      for (const check of rule.checks) {
        if (hasCarriedPages(check)) ruleCarriesPages = true;
        // Narrowed to what the printed groups did NOT account for, so a
        // partially covered rule does not report the same pages twice.
        allItems.push(...uncoveredItems(check.items, coverage));
        const additional = check.details?.additional;
        if (typeof additional === "number" && additional > 0) itemsLeftOut += Math.floor(additional);
      }
  
      if (allItems.length > 0 && coverage.mode !== "full") {
        // Collapse first: an item that is the same resource on nearly every
        // page becomes ONE line with no page list, and does not consume a slot
        // in the bounded sample below.
        const collapsed: string[] = [];
        const remaining: CheckItem[] = [];
        for (const item of allItems) {
          const info = siteWideItem(item, siteWide.total, siteWide.pageUrls);
          if (info) {
            const label = item.label && item.label !== item.id ? item.label : item.id;
            const shown = label.startsWith("http") ? compressUrl(label, baseOrigin) : label;
            collapsed.push(
              formatSiteWideItem(shown, info, (page) => compressUrl(page, baseOrigin)),
            );
          } else {
            remaining.push(item);
          }
        }
        // Collapsed lines count against the SAME budget as ordinary items.
        // Emitting them on top of it let a rule with many site-wide items grow
        // the output instead of shrinking it, which is the opposite of the point.
        const shownCollapsed = collapsed.slice(0, LLM_REPORT.maxItems);
        for (const line of shownCollapsed) lines.push(`${indent(2)}${escapeXml(line)}`);
        if (collapsed.length > shownCollapsed.length) {
          lines.push(
            `${indent(2)}Site-wide items (${shownCollapsed.length}/${collapsed.length} shown)`,
          );
        }

        const itemBudget = Math.max(0, LLM_REPORT.maxItems - shownCollapsed.length);
        const sampledItems = remaining.slice(0, itemBudget);
        const itemsTotal = remaining.length + itemsLeftOut;
        if (sampledItems.length > 0) {
          lines.push(
            sampledItems.length < itemsTotal
              ? `${indent(2)}Items (${sampledItems.length}/${itemsTotal}):`
              : `${indent(2)}Items (${itemsTotal}):`,
          );
        } else if (itemsTotal > 0) {
          // The site-wide lines took the whole budget: say what is left out, never drop it.
          lines.push(`${indent(2)}Items (0/${itemsTotal}): none listed`);
        }
  
        for (const item of sampledItems) {
          const itemId = item.id.startsWith("http") ? compressUrl(item.id, baseOrigin) : item.id;
          let itemLine = `${indent(3)}- ${escapeXml(itemId)}`;
          // pub#837/#846: the item's pages, and the region it is shown in; a scoped item's label
          // drops the section phrase the region says.
          const view = itemSourceView(item, report.structure, ruleCarriesPages ? { provenance: "carried" } : undefined);
          const label = itemLabel(item, view.scope);
          if (label && label !== item.id) itemLine += ` (${escapeXml(label)})`;
          if (item.snippet) itemLine += ` | ${escapeXml(item.snippet)}`;
          if (item.meta) {
            const metaParts: string[] = [];
            for (const [k, v] of Object.entries(item.meta)) {
              if (v !== undefined && v !== null) {
                const serialized = serializeMetaValue(v);
                if (serialized) metaParts.push(`${k}: ${escapeXml(serialized)}`);
              }
            }
            if (metaParts.length > 0) itemLine += ` [${metaParts.join(", ")}]`;
          }
          // pub#837: each page once, with its links and where they sit. pub#846: an item
          // scoped to a region names it, then the pages it is on outside it.
          const shown = view.rows.slice(0, LLM_REPORT.maxItemSourcePages);
          const hidden = Math.max(0, view.total - shown.length);
          const sources = shown
            .map((row) => escapeXml(sourceRowText(compressUrl(row.page, baseOrigin), row.detail)))
            .join(", ");
          const more = hidden > 0 ? `; ${moreSourcePages(hidden)}` : "";
          if (view.scope) {
            const where = escapeXml(lowerFirst(regionScopeLine(view.scope)));
            itemLine += shown.length > 0 ? ` (${where}; also from: ${sources}${more})` : ` (${where})`;
          } else if (shown.length > 0) {
            itemLine += ` (from: ${sources}${more})`;
          }
          lines.push(itemLine);
        }
      } else if (itemsLeftOut > 0 && coverage.mode !== "full") {
        // pub#866: a check that keeps no items still says how many it has.
        lines.push(`${indent(2)}Items (0/${itemsLeftOut}): none listed`);
      }

      lines.push(`${indent(1)}</rule>`);
    }
    lines.push("</issues>");
  } else {
    lines.push("<issues/>");
  }

  const passedRules = reportPassedRules(report, options?.includePassed);
  if (passedRules.length > 0) {
    lines.push(`<passed count="${passedRules.length}">`);
    for (const rule of passedRules) {
      lines.push(
        `${indent(1)}<rule id="${escapeXml(rule.id)}" name="${escapeXml(rule.name)}" category="${escapeXml(rule.categoryName)}" scope="${rule.scope}" pages="${rule.pages}"/>`,
      );
    }
    lines.push("</passed>");
  }

  // pub#629: rules that do not apply to a local or private-network host. An
  // agent must not read their absence from <issues> as "HTTPS and caching are
  // fine", nor go fixing a dev server's transport. One element, not one per rule.
  const privateTarget = privateTargetLine(report);
  if (privateTarget) {
    const rules = privateTargetSkippedRules(report);
    lines.push(`<not-applicable reason="private-target" count="${rules.length}">`);
    lines.push(`${indent(1)}${escapeXml(privateTarget)}`);
    for (const rule of rules) {
      lines.push(`${indent(1)}<rule id="${escapeXml(rule.id)}" name="${escapeXml(rule.name)}"/>`);
    }
    lines.push("</not-applicable>");
  }

  // Info checks (#669), opt-in with `includeInfo`: notes a rule recorded that are
  // neither findings nor skips. They never change the score. A few pages each,
  // with the true count.
  const infoChecks = options?.includeInfo ? collectInfoChecks(report.ruleResults) : [];
  if (infoChecks.length > 0) {
    lines.push(`<info-checks count="${infoChecks.length}">`);
    for (const info of infoChecks.slice(0, INFO_CHECKS_LISTED)) {
      const shown = info.pages.slice(0, INFO_CHECK_PAGES);
      lines.push(
        `${indent(1)}<check rule="${escapeXml(info.ruleId)}" name="${escapeXml(info.check)}" pages="${info.pagesCount}">${escapeXml(info.message)}${shown.length > 0 ? ` Pages: ${shown.map((p) => escapeXml(p)).join(", ")}${info.pagesCount > shown.length ? ", ..." : ""}` : ""}</check>`,
      );
    }
    if (infoChecks.length > INFO_CHECKS_LISTED) {
      lines.push(`${indent(1)}<more count="${infoChecks.length - INFO_CHECKS_LISTED}">Listed in full in the JSON report (infoChecks).</more>`);
    }
    lines.push("</info-checks>");
  }

  // Cloud-/Pro-gated rules that didn't run this audit (#780) — an agent must
  // learn these were skipped (and why), not silently read a partial audit as
  // complete. Audience logic is shared with the HTML report (#368/#747/#792).
  const locked = lockedRulesMessage(report);
  if (locked) {
    lines.push(`<locked-rules count="${locked.count}" audience="${locked.audience}">`);
    lines.push(`${indent(1)}${escapeXml(locked.action)}`);
    if (locked.cta) {
      lines.push(
        `${indent(1)}<cta label="${escapeXml(locked.cta.label)}" url="${escapeXml(locked.cta.url)}"/>`,
      );
    }
    for (const rule of locked.rules) {
      lines.push(`${indent(1)}<rule id="${escapeXml(rule.id)}" name="${escapeXml(rule.name)}"/>`);
    }
    lines.push("</locked-rules>");
  }

  // Entities (#2091) — the site's own JSON-LD as one graph. Report-only context
  // for the agent; it does not affect the score. Attribute-first so a model can
  // read the shape without parsing the rows.
  if (report.entityMap) {
    const map = report.entityMap;
    const s = map.summary;
    lines.push(
      `<entities count="${s.nodeCount}" references="${s.edgeCount}" dangling="${s.danglingCount}" conflicts="${s.conflictCount}" without-id="${s.nodesWithoutIdCount}" stable-id-share="${stableIdPercent(map)}" pages-without-entities="${s.pagesWithoutEntities}">`
    );
    for (const node of primaryEntities(map).slice(0, ENTITY_TABLE_LIMIT)) {
      const id = node.id ? ` id="${escapeXml(node.id)}"` : "";
      lines.push(
        `${indent(1)}<entity type="${escapeXml(node.types.join(","))}" name="${escapeXml(entityLabel(node))}"${id} occurrences="${node.occurrences}" pages="${entityPageTotal(node)}"/>`
      );
    }
    for (const node of conflictedEntities(map).slice(0, ENTITY_FINDING_LIMIT)) {
      for (const conflict of node.conflicts) {
        lines.push(
          `${indent(1)}<conflict entity="${escapeXml(entityLabel(node))}" property="${escapeXml(conflict.property)}" values="${conflict.values.length}">`
        );
        for (const value of conflict.values) {
          lines.push(
            `${indent(2)}<value pages="${value.pages.length + value.morePages}">${escapeXml(value.value)}</value>`
          );
        }
        lines.push(`${indent(1)}</conflict>`);
      }
    }
    for (const edge of danglingEdges(map).slice(0, ENTITY_FINDING_LIMIT)) {
      lines.push(
        `${indent(1)}<dangling predicate="${escapeXml(edge.predicate)}" target="${escapeXml(danglingTargetId(edge))}" occurrences="${edge.occurrences}"/>`
      );
    }
    for (const node of entitiesWithoutId(map).slice(0, ENTITY_FINDING_LIMIT)) {
      lines.push(
        `${indent(1)}<without-id type="${escapeXml(node.types.join(","))}" name="${escapeXml(entityLabel(node))}" pages="${entityPageTotal(node)}"/>`
      );
    }
    lines.push("</entities>");
  }

  // Report detail: the last element, after every finding. What this audit did not check, then the
  // page structure. An agent reads the absence of an issue in <issues> through the first.
  const detail: string[] = [];
  // repo#2729: checks this audit did not run (link checks off, links not
  // followed). Their absence from <issues> is NOT a clean result: an agent must
  // not tell the user "no broken links" when no link was checked.
  const notChecked = notCheckedRules(report);
  if (notChecked.length > 0) {
    detail.push(`<not-checked count="${notChecked.length}">`);
    for (const rule of notChecked) {
      detail.push(
        `${indent(1)}<rule id="${escapeXml(rule.ruleId)}" name="${escapeXml(rule.name)}" check="${escapeXml(rule.check)}" reason="${escapeXml(rule.reason)}">${escapeXml(notCheckedLine(rule))}</rule>`,
      );
    }
    detail.push("</not-checked>");
  }

  // Page structure (#2307) — report-only context for the agent (does not affect the score): which
  // part of the page the links sit in, and the page types. The sentences are for reading, the
  // rows for counting.
  if (report.structure) {
    const structure = report.structure;
    const share = structure.chrome.share;
    detail.push(
      `<page-structure pages="${structureAttr(structure.pages)}" links="${structureAttr(structure.totalLinks)}"${typeof share === "number" ? ` chrome-share="${structureAttr(share)}"` : ""}>`,
    );
    for (const line of [
      structurePageTypesLine(structure),
      structureChromeLine(structure),
      structureTotalsLine(structure),
      structureDegradedLine(structure),
    ]) {
      if (line) detail.push(`${indent(1)}${escapeXml(line)}`);
    }
    // The section id as the JSON report spells it, so a row can be matched to `structure.sections`.
    for (const row of structure.sections) {
      if (structureSectionName(row.section) === undefined) continue;
      detail.push(
        `${indent(1)}<section name="${escapeXml(row.section)}" pages="${structureAttr(row.pages)}" links="${structureAttr(row.links)}"/>`,
      );
    }
    detail.push("</page-structure>");
  }

  if (detail.length > 0) {
    lines.push("<report-detail>");
    for (const line of detail) lines.push(`${indent(1)}${line}`);
    lines.push("</report-detail>");
  }

  lines.push("</audit>");
  // Sanitise once, at the boundary — see the note in text.ts. This output is
  // documented as pipeable straight into an agent (`--format llm | claude`), so
  // it is also the path where control bytes would land in a model's context.
  return stripControlChars(lines.join("\n"));
}
