// JSON report output

import type {
  AuditStatusReasonCode,
  EditorSummaryPriority,
  MaxDurationCut,
  RefusedFetch,
  WafBlockedSummary,
  WafSuspectSummary,
} from "@squirrelscan/core-contracts";
import type { ResolvedAuditSettings } from "@squirrelscan/core-contracts/audit-levels";
import type {
  AuditReport,
  AuditStatus,
  CheckItem,
  CheckResult,
  ComponentOccurrence,
  EntityMap,
  ReportStructure,
} from "../types";
import type { ComponentFixGroup } from "../component-fix-groups";
import type {
  ComponentShape,
  PackedComponentOccurrence,
  PackedSubtreeLadder,
} from "@squirrelscan/core-contracts/component-evidence";
import {
  JSON_REPORT_PAGES,
  JSON_REPORT_SCHEMA_VERSION,
} from "@squirrelscan/core-contracts/limits";
import { packComponentOccurrences } from "@squirrelscan/core-contracts/component-evidence";
import { packSiteResourceOccurrences } from "@squirrelscan/core-contracts/site-resource-evidence";
import { componentOccurrenceKey } from "../component-fix-groups";
import type { GroupedCheck } from "../grouping";

import { REPORT_PAGES_HARD_CAP } from "../constants";
import { siteWideContext, siteWideItem } from "../site-wide-items";
import { fixUnits, ruleFixCoverage } from "../component-presentation";
import { siteResourceFixGroups } from "../site-resource-fix-groups";
import { isRenderableSiteResourceGroup } from "../site-resource-presentation";
import { reportFailureReasonCode } from "../failure-notice";
import { safeWafBlocked, safeWafSuspect } from "../waf-blocked";
import { getScoreGrade } from "../scoring";
import { getGroupName } from "../categories";
import { groupIssuesByCategory, flattenIssuesBySeverity, reportPassedRules } from "../grouping";
import { affectedPages } from "../affected-pages";
import {
  checkRegionScope,
  itemLabel,
  itemRegionScope,
  regionScopeData,
  type RegionScope,
} from "../region-scope";
import { checkPageTypeScope, pageTypeScopeData, type PageTypeScope } from "../page-type-scope";
import { techIconUrl } from "../technologies";
import { domainAgeYears, siteProfileRows } from "../site-metadata";
import { editorSummaryView } from "../editor-summary";
import { canonicalVariantCount, followedStartRedirect, scanScopeUnfetched, seedRedirect } from "../coverage";
import { privateTargetLine, privateTargetSkippedRules } from "../private-target";
import { notCheckedLine, notCheckedRules } from "../not-checked";
import { collectInfoChecks, type InfoCheck } from "../info-checks";
import { collectSkippedChecks, type SkippedCheck } from "../skipped";

/**
 * A fix group as it is SERIALIZED: identical to {@link ComponentFixGroup} except
 * that its occurrence objects are replaced by references into the check that
 * already carries them. An occurrence is ~800 bytes of hashes, so repeating a
 * group's members next to `checks[].componentOccurrences` doubled the evidence
 * in every report and added no information.
 */
type SlimComponentFixGroup = Omit<ComponentFixGroup, "occurrences"> & {
  /** #1023 R-F: `affectedPages` is a labeled sample; the count is authoritative. */
  affectedPagesHasMore: boolean;
  occurrenceCount: number;
  /**
   * Where this group's evidence lives: `checkIndex` indexes the sibling
   * `checks[]` array and `occurrenceIndex` indexes that check's
   * `componentOccurrences[]`.
   */
  occurrenceRefs: Array<{ checkIndex: number; occurrenceIndex: number }>;
};

/**
 * Replace a group's inline occurrences with positions in the already-serialized
 * check evidence.
 *
 * Resolution is by IDENTITY KEY, not object identity. `groupIssuesByCategory`
 * dedupes merged occurrence arrays, so the object a group holds is not
 * necessarily the same allocation the check ends up serializing — and a
 * reference-based lookup silently dropped those, leaving `occurrenceCount`
 * larger than `occurrenceRefs.length` with no indication which were missing.
 * Equal keys mean equal serialized content, so any match is a correct target.
 */
function slimComponentFixGroups(
  groups: ComponentFixGroup[],
  checks: GroupedCheck[],
  pageSampleLimit: number,
): SlimComponentFixGroup[] {
  const positions = new Map<string, { checkIndex: number; occurrenceIndex: number }>();
  checks.forEach((check, checkIndex) => {
    check.componentOccurrences?.forEach((occurrence, occurrenceIndex) => {
      const key = componentOccurrenceKey(occurrence);
      if (!positions.has(key)) positions.set(key, { checkIndex, occurrenceIndex });
    });
  });
  return groups.map(({ occurrences, affectedPages: pages, ...group }) => {
    const occurrenceRefs = occurrences
      .map((occurrence) => positions.get(componentOccurrenceKey(occurrence)))
      .filter((position): position is NonNullable<typeof position> => position !== undefined);
    return {
      ...group,
      affectedPages: pages.slice(0, pageSampleLimit),
      affectedPagesHasMore: pages.length > pageSampleLimit,
      // Every occurrence a group counts must be reachable. A shortfall means
      // the serialized evidence and the group disagree, which is a bug rather
      // than a degradation, so the count follows the refs that actually resolve.
      occurrenceCount: occurrenceRefs.length,
      occurrenceRefs,
    };
  });
}

/**
 * How a crawled page answered (#1260): `ok` (status under 400), `rate-limited` (429),
 * `http-error` (any other 4xx or 5xx) or `error` (no usable status). A URL whose fetch never
 * produced a stored response is not a page and is not listed.
 */
export type JsonPageOutcome = "ok" | "http-error" | "rate-limited" | "error";

/** The {@link JsonPageOutcome} of an HTTP status. */
export function pageOutcome(status: number): JsonPageOutcome {
  if (!Number.isInteger(status) || status < 100 || status > 599) return "error";
  if (status === 429) return "rate-limited";
  return status >= 400 ? "http-error" : "ok";
}

/** One crawled page in the opt-in `pages` list (#1260). */
export interface JsonPageRow {
  url: string;
  /** The URL the page was served from after redirects; `url` when it did not redirect. */
  finalUrl: string;
  /** HTTP status the page answered with. */
  status: number;
  outcome: JsonPageOutcome;
  /** Distinct rules that reported on the page (skipped checks not counted). */
  ruleCount: number;
}

export interface JsonRenderOptions {
  version?: string;
  /** Add `passedRules`, the rules that passed (`--include-passed`). */
  includePassed?: boolean;
  /**
   * Add `pages`, the crawled pages with their status and rule count (`--include-pages`, #1260).
   * Omitted: the report has no `pages` key. Cut at {@link JSON_REPORT_PAGES}.maxEntries with
   * `pagesTruncated` set.
   */
  pages?: readonly JsonPageRow[];
}

interface SlimJsonReport {
  meta: {
    version: string;
    /** The report's schema version, major.minor (#1260). Absent on reports from before 1.1. */
    schemaVersion: string;
    baseUrl: string;
    /** The deep page requested when `baseUrl` describes the site-wide scope. */
    requestedUrl?: string;
    /**
     * A refused off-site seed redirect (#1418). Present only when the seed
     * redirected off its own registrable domain and the crawler declined to
     * follow it: `baseUrl` above is what was graded, this is where the seed
     * pointed. `finalUrl` is null when the stored target was not a parseable
     * http(s) URL and was withheld rather than emitted; `note` reads correctly
     * either way.
     */
    seedRedirect?: {
      finalUrl: string | null;
      followed: false;
      note: string;
    };
    /**
     * The start URL as the user gave it, and every URL requested from it to the
     * audited one (#1281). Present only when the start URL redirected to another
     * site and the redirect was followed: `baseUrl` is the destination.
     */
    originalUrl?: string;
    redirectChain?: Array<{ url: string; status: number }>;
    timestamp: string;
    totalPages: number;
    /**
     * The page cap in force for this run (#1909). Present whenever the report
     * carries a scan scope.
     */
    maxPages?: number;
    /**
     * What the run ASKED for, present only when that exceeded the ceiling and
     * was clamped down to `maxPages` (#1909). Its ABSENCE is the normal case,
     * so a caller detects a clamp by whether this field is here rather than by
     * knowing the cap. Without it, a request for 10,000 pages and a 5,000-page
     * site produce identical reports.
     */
    requestedMaxPages?: number;
    /**
     * `"time"` when the crawl time budget ended a cloud crawl early. Absent on a
     * run that finished or hit the page cap.
     */
    stopReason?: "time";
    /**
     * In-scope URLs the crawl queued but never fetched before it stopped. Added
     * to the pages this run crawled (`coverage.auditedPages` on a smart audit,
     * else `totalPages`) it is a floor on the pages the crawl knew of. Absent
     * when nothing was left queued.
     */
    unfetched?: number;
    canonicalVariants?: number;
    canonicalVariantPages?: Array<{ page: string; canonical: string }>;
    /** The audit level and the settings it resolved to. Absent before audit levels. */
    auditLevel?: ResolvedAuditSettings;
    /** Smart audits (#110): present only when `smart_audits` ran. */
    coverage?: {
      auditedPages: number;
      knownPages: number;
      /** Findings a PREVIOUS audit observed. 0 on a first run (#1652). */
      carriedFindings: number;
      /** Findings on pages no audit has ever rendered (#1652). */
      unrenderedFindings?: number;
      /** Re-crawled pages that still carry earlier findings (#1031). */
      pagesWithStaleCarry?: number;
    };
  };
  /**
   * Audit validity (#801). Always present — "completed" when the core report
   * carries no status (back-compat) — so a failed/blocked 0-page audit never
   * serializes as a clean pass with zero issues.
   */
  status: AuditStatus;
  /** Short human reason, present when `status` is failed/blocked. */
  statusReason?: string;
  /**
   * Coverage lost to rate limiting (#1829). Present only when a host throttled
   * the crawl, so an integration can answer "is this page count the whole
   * site?" without parsing `statusReason` prose.
   */
  rateLimited?: { pages: number; hosts: string[]; unfetched?: number };
  /**
   * Machine-readable class behind `statusReason` (#1822); absent pre-#1822. On a
   * `partial` report it is `max_duration` when `--max-duration` cut the run (#1271).
   */
  statusReasonCode?: AuditStatusReasonCode;
  /** What the `--max-duration` time limit cut (#1271). Present only when it cut something. */
  maxDuration?: MaxDurationCut;
  /**
   * Root fetches (robots.txt, sitemaps, llms.txt, Markdown) the site refused
   *. Their absence is unknown, not confirmed. Present only when
   * something was refused.
   */
  refusedFetches?: RefusedFetch[];
  /**
   * Pages a WAF or bot manager answered with a challenge or block page (#1253).
   * Never audited or scored. `seed` is set when the audited page itself was
   * blocked, which makes `status` `blocked`; its `code` (`blocked_by_<provider>`)
   * is the machine-readable reason. Present only when a page was blocked.
   */
  wafBlocked?: WafBlockedSummary;
  /**
   * Pages that look like a provider's refusal but carry none of its block markers
   * (#1258). They were audited like any page, so their findings may describe the
   * provider's page. Present only when one was seen.
   */
  wafSuspect?: WafSuspectSummary;
  score: {
    overall: number | null; // null ⇒ N/A (failed/0-page audit, #586)
    grade: string;
    // Top-level group scores (#626) — 4 groups above the categories. Absent from
    // reports stored before #626 (renders as []).
    groups: Array<{
      group: string;
      name: string;
      score: number;
      passed: number;
      warnings: number;
      failed: number;
      total: number;
    }>;
    categories: Array<{ name: string; score: number }>;
  };
  summary: {
    passed: number;
    warnings: number;
    failed: number;
    /**
     * Pages a check skipped because it could not finish evaluating (#518): the
     * sum of `pagesCount` over `skippedChecks`. Not part of `passed`,
     * `warnings` or `failed`, and never scored.
     */
    skipped: number;
  };
  /**
   * Every crawled page with its HTTP status and the number of rules that reported on it
   * (`--include-pages`, #1260). Present only when asked for. At most
   * `JSON_REPORT_PAGES.maxEntries` entries: `pagesTotal` is the real count and
   * `pagesTruncated` says the list was cut.
   */
  pages?: JsonPageRow[];
  pagesTotal?: number;
  pagesTruncated?: boolean;
  issues: Array<{
    ruleId: string;
    name: string;
    description: string;
    solution?: string;
    /**
     * Display name (e.g. "Blocking"). Reconstruction (`convertSlimReport`)
     * maps it back to the category CODE, falling back to the `ruleId` prefix
     * for a name it does not know: a rule's id prefix need not be its
     * category (pub#836: `links/broken-links` is Reliability). `subcategory`
     * below is the code ("ad" | "privacy").
     */
    category: string;
    /** Top-level group code (#626), e.g. "seo" — which group the issue rolls up into. */
    group: string;
    subcategory?: string;
    severity: "error" | "warning" | "info";
    /** Additive, evidence-backed actionable targets; raw occurrences are complete. */
    componentFixGroups?: SlimComponentFixGroup[];
    /**
     * Groups that are ONE repair, referenced by id. Individual groups above are
     * kept in full: this is an additive view, so a consumer that does not know
     * about rollups reads exactly what it read before.
     */
    componentFixRollups?: Array<{
      /** Which rollup level produced it; additive, `root` is today's meaning. */
      level: "root" | "family";
      /** Structural variants merged; 1 at the root level. */
      variantCount: number;
      groupIds: string[];
      affectedPageCount: number;
      elementCount: number;
      attribution: string;
      defectKind: string;
      distinctValues: string[];
      additionalValues: number;
    }>;
    checks: Array<{
      name: string;
      status: "fail" | "warn";
      message: string;
      affectedPages: string[];
      affectedPagesCount: number;
      affectedPagesHasMore: boolean;
      /**
       * What stands in for the check's page list: the shared region a check that only reads one is
       * shown in (pub#846, `{ region, pages, regionPages, otherPages }`), or the page type every
       * one of its pages is (pub#857, `{ pageType, pages, typePages }`).
       */
      scope?: RegionScope | PageTypeScope;
      /**
       * Every item and every sourcePage, unchanged. An item may carry the region it is shown in,
       * `scope` (pub#846). Items the human renderers collapse carry a `siteWide` flag so an agent
       * gets the same collapse without re-deriving the threshold.
       */
      items?: Array<
        CheckItem & { scope?: RegionScope; siteWide?: { pages: number; of: number } }
      >;
      details?: Record<string, unknown>;
      /**
       * Complete raw evidence, and the ONLY copy in this document: fix groups
       * above reference these entries by index instead of repeating them.
       * Present even when no cross-page group is safe.
       *
       * Serialized in the HOISTED form: the shared region/family/variant triples
       * live in `componentShapes` and each row carries a `shape` index. Indices
       * into this array are stable, so `occurrenceRefs` still address it.
       */
      componentOccurrences?: PackedComponentOccurrence[];
      /**
       * Lookup tables for `componentOccurrences`; `v` is the layout version.
       * `ladders` is present only when some occurrence carries a subtree
       * ladder, and every `ladder` index on a row resolves into it. Emitting
       * the rows' indices without this table left consumers holding `ladder`
       * and `ladderLocators` values that pointed at nothing.
       */
      componentShapes?: {
        v: number;
        shapes: ComponentShape[];
        ladders?: PackedSubtreeLadder[];
      };
      componentEvidence?: CheckResult["componentEvidence"];
      legacyValue?: string;
    }>;
  }>;
  /**
   * Evaluation gaps (#518): checks a rule skipped because a scan limit was hit,
   * so "no issue" on those pages is not a clean result. Deliberately outside
   * `issues`, which consumers treat as findings. Present only when non-empty.
   */
  skippedChecks?: SkippedCheck[];
  /**
   * Info checks (#669): notes a rule recorded that are neither a finding nor a
   * skip, for example `redundant-noindex`. They never change the score and are not
   * in `issues`. Present only when non-empty.
   */
  infoChecks?: InfoCheck[];
  /**
   * Rules that passed: at least one passing check and no failing or warning
   * one. `scope` is the rule's own; `pages` counts distinct pages with a pass,
   * and is 0 when the pass rows carry none. Present only with
   * `--include-passed`, and only when non-empty.
   */
  passedRules?: Array<{
    ruleId: string;
    name: string;
    category: string;
    scope: "page" | "site";
    pages: number;
  }>;
  /**
   * Rules that do not apply to this audit's host (pub#629): the transport and
   * delivery rules, skipped because the host is local or private-network. Not
   * findings, not evaluation gaps, and never scored. Present only when a rule
   * was skipped for that reason.
   */
  notApplicable?: {
    reason: "private-target";
    message: string;
    rules: Array<{ ruleId: string; name: string }>;
  };
  /**
   * Checks this audit did not run (repo#2729): external link checking was off,
   * or the crawl did not follow links. NOT a pass: "no issue" for these rules
   * means nothing was checked. `message` is the full line every format shows,
   * including what to run instead. Never scored. Present only when non-empty.
   */
  notChecked?: Array<{
    ruleId: string;
    name: string;
    check: string;
    reason: string;
    message: string;
    /** A rule that hit an internal error: the first pages it was not evaluated on (#1291). */
    pages?: string[];
  }>;
  // Report-only — never part of the score. Present when the Pro cloud
  // editor-summary call ran (exec-email-shaped narrative + big-ticket items).
  editorSummary?: {
    prose: string;
    bigTicket: string[];
    verdict: string;
    model: string;
    generatedAt: string;
    /** Ranked next steps, when the server returned them. */
    priorities?: EditorSummaryPriority[];
  };
  // Report-only — never part of the score. The entity-map document (#2091),
  // emitted verbatim so it still validates against the core-contracts schema.
  entities?: EntityMap;
  // Report-only — never part of the score (#2307). Where the audited pages' links sit and the
  // page types the classifier gave them. Absent when no audited page carries either, which is
  // every crawl stored before the page classifier existed.
  structure?: ReportStructure;
  // Report-only — never part of the score. Present when a technology scan ran: the cloud one, or
  // the free local scan of the crawled pages (`source` says which, #1263).
  technologies?: {
    /** `local` (free signature scan of the crawled pages) or `cloud` (credited scan with history). */
    source?: "local" | "cloud";
    /** Present when a byte cap or the time budget cut the local scan short (#1387): fewer technologies than the site runs may be listed. */
    truncated?: { reasons: string[]; scripts: number };
    firstScan: boolean;
    added: string[];
    removed: string[];
    items: Array<{
      id: string;
      name: string;
      category: string;
      version: string | null;
      confidence: string;
      website?: string;
      logoUrl: string | null;
    }>;
  };
  // Report-only — never part of the score. Present when the cloud site-metadata
  // service resolved a profile. Raw enum codes are kept for programmatic use;
  // `display` carries the humanized labels rendered in the other formats.
  siteProfile?: {
    siteType: string;
    businessCategory?: string | null;
    primaryCountry?: string | null;
    audienceScope?: string | null;
    languages?: string[];
    title?: string | null;
    entityName?: string | null;
    entityType?: string;
    entityUrl?: string | null;
    contacts?: Array<{ kind: string; value: string; label?: string | null }>;
    socials?: Array<{ platform: string; url: string; handle?: string | null }>;
    isYMYL: boolean;
    isLocalBusiness: boolean;
    hasOwnershipVerified: boolean;
    confidence: string;
    domainAgeDays?: number | null;
    domainAgeYears?: number | null;
    registeredAt?: string | null;
    expiresAt?: string | null;
    registrar?: string | null;
    display: Array<{ key: string; label: string; value: string; url?: string }>;
  };
}

function buildSlimReport(
  report: AuditReport,
  version: string,
  includePassed: boolean,
  pages?: readonly JsonPageRow[]
): SlimJsonReport {
  const siteWide = siteWideContext(report);
  const categoryIssues = groupIssuesByCategory(report.ruleResults, report.checkTallies);
  const passedRules = reportPassedRules(report, includePassed);
  const es = editorSummaryView(report.editorSummary, report);
  const refusedSeedRedirect = seedRedirect(report);
  const startRedirect = followedStartRedirect(report);
  const skippedChecks = collectSkippedChecks(report.ruleResults);
  const infoChecks = collectInfoChecks(report.ruleResults);
  const privateTarget = privateTargetLine(report);
  const notChecked = notCheckedRules(report);
  const unfetched = scanScopeUnfetched(report);
  return {
    meta: {
      version,
      schemaVersion: JSON_REPORT_SCHEMA_VERSION,
      baseUrl: report.baseUrl,
      ...(report.requestedUrl ? { requestedUrl: report.requestedUrl } : {}),
      // Sits next to the `baseUrl` it qualifies (#1418): a consumer reading the
      // graded URL sees, in the same object, that the seed pointed elsewhere.
      ...(refusedSeedRedirect
        ? {
            seedRedirect: {
              finalUrl: refusedSeedRedirect.finalUrl,
              followed: false as const,
              note: refusedSeedRedirect.note,
            },
          }
        : {}),
      ...(startRedirect
        ? { originalUrl: startRedirect.originalUrl, redirectChain: startRedirect.chain }
        : {}),
      timestamp: report.timestamp,
      totalPages: report.totalPages,
      ...(report.scanScope?.maxPages !== undefined
        ? { maxPages: report.scanScope.maxPages }
        : {}),
      ...(report.scanScope?.requestedMaxPages !== undefined
        ? { requestedMaxPages: report.scanScope.requestedMaxPages }
        : {}),
      ...(report.scanScope?.stopReason !== undefined
        ? { stopReason: report.scanScope.stopReason }
        : {}),
      ...(unfetched > 0 ? { unfetched } : {}),
      // Query-string variants counted with their canonical page; `totalPages` excludes them (#858).
      ...(canonicalVariantCount(report) > 0 ? { canonicalVariants: canonicalVariantCount(report) } : {}),
      ...(canonicalVariantCount(report) > 0 && report.canonicalVariantPages?.length
        ? { canonicalVariantPages: report.canonicalVariantPages.slice(0, 100).map((v) => ({ page: String(v.page), canonical: String(v.canonical) })) }
        : {}),
      ...(report.coverage ? { coverage: report.coverage } : {}),
      // The audit level and the settings it resolved to: `level` (a level's
      // name, or `custom`), `basedOn`, `changes` and `settings`. Absent on
      // reports written before audit levels.
      ...(report.auditLevel ? { auditLevel: report.auditLevel } : {}),
      // #1990: how much of this audit's rules phase was replayed from a previous
      // audit rather than evaluated now. A replay and a fresh evaluation produce
      // identical findings by construction, so this is the only thing in the
      // report that distinguishes them (#1981).
      ...(report.rulesCache ? { rulesCache: report.rulesCache } : {}),
      // #1280: the first-party scripts the script rules evaluated.
      ...(report.scriptsEvaluated !== undefined
        ? { scriptsEvaluated: report.scriptsEvaluated }
        : {}),
    },
    status: report.status ?? "completed",
    ...(report.statusReason ? { statusReason: report.statusReason } : {}),
    // #1822: a programmatic consumer branches on the class, not on the prose.
    // Derived when the stored report predates the field, so a CI gate reading
    // it does not have to special-case older reports.
    ...(report.status === "failed" || report.status === "blocked"
      ? { statusReasonCode: reportFailureReasonCode(report) }
      : report.status === "partial" && report.statusReasonCode === "max_duration"
        ? { statusReasonCode: report.statusReasonCode }
        : {}),
    ...(report.maxDuration ? { maxDuration: report.maxDuration } : {}),
    ...(report.rateLimited && report.rateLimited.pages > 0
      ? { rateLimited: report.rateLimited }
      : {}),
    ...(report.refusedFetches?.length ? { refusedFetches: report.refusedFetches } : {}),
    ...(safeWafBlocked(report) ? { wafBlocked: safeWafBlocked(report)! } : {}),
    ...(safeWafSuspect(report) ? { wafSuspect: safeWafSuspect(report)! } : {}),
    score: {
      // null ⇒ N/A (failed/0-page audit); preserved through save/reload (#586).
      overall: report.healthScore?.overall ?? null,
      grade:
        report.healthScore?.overall == null ? "N/A" : getScoreGrade(report.healthScore.overall),
      groups:
        report.healthScore?.groups?.map((g) => ({
          group: g.group,
          // Derived from the group CODE so renames apply to stored reports.
          name: getGroupName(g.group),
          score: g.score,
          passed: g.passed,
          warnings: g.warnings,
          failed: g.failed,
          total: g.total,
        })) ?? [],
      categories:
        report.healthScore?.categories.map((c) => ({ name: c.name, score: c.score })) ?? [],
    },
    summary: {
      passed: report.passed,
      warnings: report.warnings,
      failed: report.failed,
      skipped: skippedChecks.reduce((sum, s) => sum + s.pagesCount, 0),
    },
    // Same guard as every other format, validated rather than just cast: the
    // declared shape promises string fields, so a malformed stored summary omits
    // the whole section rather than emitting a half-built one into the
    // user-facing JSON. Fields are listed out (not spread) to keep `paragraphs`,
    // which is a rendering aid, out of the persisted shape.
    ...(es
      ? {
          editorSummary: {
            prose: es.prose,
            bigTicket: es.bigTicket,
            verdict: es.verdict,
            model: es.model,
            generatedAt: es.generatedAt,
            ...(es.priorities.length > 0 ? { priorities: es.priorities } : {}),
          },
        }
      : {}),
    // Severity-first across the whole report (#1536), not category-by-category.
    ...(pages
      ? {
          pages: pages.slice(0, JSON_REPORT_PAGES.maxEntries).map((page) => ({
            url: page.url,
            finalUrl: page.finalUrl,
            status: page.status,
            outcome: page.outcome,
            ruleCount: page.ruleCount,
          })),
          pagesTotal: pages.length,
          pagesTruncated: pages.length > JSON_REPORT_PAGES.maxEntries,
        }
      : {}),
    issues: flattenIssuesBySeverity(categoryIssues).map((rule) => ({
      ruleId: rule.id,
      name: rule.name,
      description: rule.description,
      solution: rule.solution,
      category: rule.categoryName,
      group: rule.group,
      ...(rule.subcategory ? { subcategory: rule.subcategory } : {}),
      severity: rule.severity,
      ...(rule.componentFixGroups
        ? {
            componentFixGroups: slimComponentFixGroups(
              rule.componentFixGroups,
              rule.checks,
              REPORT_PAGES_HARD_CAP,
            ),
          }
        : {}),
      ...(() => {
        // #2341. JSON is the machine format, so it keeps EVERY unit, including
        // the single-page ones the human surfaces decline to print: a consumer
        // reconstructing the grouping needs the units that were rejected as
        // much as the ones that were shown.
        const resources = siteResourceFixGroups(rule);
        return resources.length > 0
          ? {
              siteResourceFixGroups: resources.map((group) => ({
                id: group.id,
                checkName: group.checkName,
                checkStatus: group.checkStatus,
                kind: group.kind,
                siteOrigin: group.siteOrigin,
                resourceKeys: group.resourceKeys,
                affectedPages: group.affectedPages.slice(0, REPORT_PAGES_HARD_CAP),
                affectedPageCount: group.affectedPageCount,
                rendered: isRenderableSiteResourceGroup(group),
              })),
            }
          : {};
      })(),
      ...(() => {
        // Both levels, so a consumer sees the same units the renderers print.
        const rollups = fixUnits(ruleFixCoverage(rule).groups).filter(
          (rollup) => rollup.groups.length > 1 || rollup.variantCount > 1,
        );
        return rollups.length > 0
          ? {
              componentFixRollups: rollups.map((rollup) => ({
                level: rollup.level,
                variantCount: rollup.variantCount,
                groupIds: rollup.groupIds,
                affectedPageCount: rollup.affectedPageCount,
                elementCount: rollup.elementCount,
                attribution: rollup.representative.attribution,
                defectKind: rollup.representative.defect.kind,
                distinctValues: rollup.distinctValues,
                additionalValues: rollup.additionalValues,
              })),
            }
          : {};
      })(),
      checks: rule.checks.map((check) => {
        // #1023 R-F: affectedPages is a labeled sample; count is authoritative.
        const ap = affectedPages(check);
        // pub#846: the region a check or item is shown in, beside the bounded page lists.
        const regionScope = checkRegionScope(check, ap.count, report.structure);
        const typeScope = regionScope
          ? undefined
          : checkPageTypeScope(check, ap.count, report.structure);
        return {
          name: check.name,
          status: check.status as "fail" | "warn",
          message: check.message,
          affectedPages: ap.sample,
          affectedPagesCount: ap.count,
          affectedPagesHasMore: ap.hasMore,
          ...(regionScope
            ? { scope: regionScopeData(regionScope) }
            : typeScope
              ? { scope: pageTypeScopeData(typeScope) }
              : {}),
          items: check.items?.map((item) => {
            const scope = itemRegionScope(item, report.structure, check);
            let shown: CheckItem & { scope?: RegionScope } = item;
            if (scope) {
              // The label drops the section phrase `scope` now carries; `meta.sections` keeps it.
              const label = itemLabel(item, scope);
              shown = { ...item, scope: regionScopeData(scope) };
              if (label === undefined) delete shown.label;
              else shown.label = label;
            }
            const info = siteWideItem(item, siteWide.total, siteWide.pageUrls);
            return info ? { ...shown, siteWide: { pages: info.pages, of: info.of } } : shown;
          }),
          details: check.details,
          ...(check.componentOccurrences?.length
            ? (() => {
                const packed = packComponentOccurrences(check.componentOccurrences);
                return {
                  componentOccurrences: packed.occurrences,
                  componentShapes: {
                    v: packed.v,
                    shapes: packed.shapes,
                    ...(packed.ladders?.length ? { ladders: packed.ladders } : {}),
                  },
                };
              })()
            : {}),
          ...(check.componentEvidence ? { componentEvidence: check.componentEvidence } : {}),
          // #2341: the raw evidence, packed. The derived `siteResourceFixGroups`
          // above are NOT what a re-import reads back — they are derived, and
          // `report -i` re-derives them from this, so there is one source of
          // truth rather than two that can disagree.
          ...(check.siteResourceOccurrences?.length
            ? {
                siteResourceOccurrences: packSiteResourceOccurrences(
                  check.siteResourceOccurrences,
                ),
              }
            : {}),
          ...(check.siteResourceEvidence
            ? { siteResourceEvidence: check.siteResourceEvidence }
            : {}),
          ...(check.value ? { legacyValue: check.value } : {}),
          // Smart audits (#110): provenance for findings carried across audits.
          // (#1652) "unrendered" is tested FIRST and emits no `lastSeenAt` —
          // no audit has rendered the page, so there is nothing it was last
          // seen at, and calling it "carried" would invent a prior audit.
          ...(check.unrenderedCount && check.unrenderedCount >= check.count
            ? { provenance: "unrendered" as const }
            : check.carriedCount && check.carriedCount >= check.count
              ? {
                  provenance: "carried" as const,
                  ...(check.lastSeenAt ? { lastSeenAt: check.lastSeenAt } : {}),
                }
              : {}),
        };
      }),
    })),
    ...(skippedChecks.length > 0 ? { skippedChecks } : {}),
    ...(infoChecks.length > 0 ? { infoChecks } : {}),
    ...(passedRules.length > 0
      ? {
          passedRules: passedRules.map((r) => ({
            ruleId: r.id,
            name: r.name,
            category: r.categoryName,
            scope: r.scope,
            pages: r.pages,
          })),
        }
      : {}),
    ...(privateTarget
      ? {
          notApplicable: {
            reason: "private-target" as const,
            message: privateTarget,
            rules: privateTargetSkippedRules(report).map((r) => ({ ruleId: r.id, name: r.name })),
          },
        }
      : {}),
    ...(notChecked.length > 0
      ? {
          notChecked: notChecked.map((r) => ({
            ruleId: r.ruleId,
            name: r.name,
            check: r.check,
            reason: r.reason,
            message: notCheckedLine(r),
            ...(r.pages && r.pages.length > 0 ? { pages: r.pages } : {}),
          })),
        }
      : {}),
    ...(report.technologies && report.technologies.items.length > 0
      ? {
          technologies: {
            ...(report.technologies.source ? { source: report.technologies.source } : {}),
            ...(report.technologies.truncated ? { truncated: report.technologies.truncated } : {}),
            firstScan: report.technologies.firstScan,
            added: report.technologies.added,
            removed: report.technologies.removed,
            items: report.technologies.items.map((t) => ({
              id: t.id,
              name: t.name,
              category: t.category,
              version: t.version,
              confidence: t.confidence,
              ...(t.website ? { website: t.website } : {}),
              logoUrl: techIconUrl(t.icon),
            })),
          },
        }
      : {}),
    // Page structure (#2307): the report-level block as data. Report-only, never scored.
    ...(report.structure ? { structure: report.structure } : {}),
    // Entities (#2091): the whole entity-map document, verbatim. Report-only
    // and never part of the score. Emitted as-is rather than reshaped so a
    // consumer can validate it against the core-contracts zod schema.
    ...(report.entityMap ? { entities: report.entityMap } : {}),
    ...(report.siteMetadata
      ? {
          siteProfile: {
            siteType: report.siteMetadata.siteType,
            businessCategory: report.siteMetadata.businessCategory ?? null,
            primaryCountry: report.siteMetadata.primaryCountry ?? null,
            audienceScope: report.siteMetadata.audienceScope ?? null,
            ...(report.siteMetadata.languages ? { languages: report.siteMetadata.languages } : {}),
            title: report.siteMetadata.title ?? null,
            entityName: report.siteMetadata.entityName ?? null,
            ...(report.siteMetadata.entityType
              ? { entityType: report.siteMetadata.entityType }
              : {}),
            entityUrl: report.siteMetadata.entityUrl ?? null,
            ...(report.siteMetadata.contacts
              ? {
                  contacts: report.siteMetadata.contacts.map((c) => ({
                    kind: c.kind,
                    value: c.value,
                    label: c.label ?? null,
                  })),
                }
              : {}),
            ...(report.siteMetadata.socials
              ? {
                  socials: report.siteMetadata.socials.map((s) => ({
                    platform: s.platform,
                    url: s.url,
                    handle: s.handle ?? null,
                  })),
                }
              : {}),
            isYMYL: report.siteMetadata.isYMYL,
            isLocalBusiness: report.siteMetadata.isLocalBusiness,
            hasOwnershipVerified: report.siteMetadata.hasOwnershipVerified,
            confidence: report.siteMetadata.confidence,
            domainAgeDays: report.siteMetadata.domainAgeDays ?? null,
            domainAgeYears: domainAgeYears(report.siteMetadata),
            registeredAt: report.siteMetadata.registeredAt ?? null,
            expiresAt: report.siteMetadata.expiresAt ?? null,
            registrar: report.siteMetadata.registrar ?? null,
            display: siteProfileRows(report.siteMetadata).map((r) => ({
              key: r.key,
              label: r.label,
              value: r.value,
              ...(r.url ? { url: r.url } : {}),
            })),
          },
        }
      : {}),
  };
}

export function renderJson(report: AuditReport, options?: JsonRenderOptions): string {
  const version = options?.version ?? "";
  const slim = buildSlimReport(report, version, options?.includePassed ?? false, options?.pages);
  return JSON.stringify(slim, null, 2);
}
