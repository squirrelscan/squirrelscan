// JSON report output

import type { AuditFailureReasonCode } from "@squirrelscan/core-contracts";
import type { AuditReport, AuditStatus, CheckItem } from "../types";
import { reportFailureReasonCode } from "../failure-notice";
import { getScoreGrade } from "../scoring";
import { getGroupName } from "../categories";
import { groupIssuesByCategory, flattenIssuesBySeverity } from "../grouping";
import { affectedPages } from "../affected-pages";
import { techIconUrl } from "../technologies";
import { domainAgeYears, siteProfileRows } from "../site-metadata";
import { editorSummaryView } from "../editor-summary";
import { seedRedirect } from "../coverage";

export interface JsonRenderOptions {
  version?: string;
}

interface SlimJsonReport {
  meta: {
    version: string;
    baseUrl: string;
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
    timestamp: string;
    totalPages: number;
    /** Smart audits (#110): present only when `smart_audits` ran. */
    coverage?: {
      auditedPages: number;
      knownPages: number;
      /** Findings a PREVIOUS audit observed. 0 on a first run (#1652). */
      carriedFindings: number;
      /** Findings on pages no audit has ever rendered (#1652). */
      unrenderedFindings?: number;
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
  rateLimited?: { pages: number; hosts: string[] };
  /** Machine-readable class behind `statusReason` (#1822); absent pre-#1822. */
  statusReasonCode?: AuditFailureReasonCode;
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
  };
  issues: Array<{
    ruleId: string;
    name: string;
    description: string;
    solution?: string;
    /**
     * Display name (e.g. "Blocking"), informational only. Reconstruction
     * (`convertSlimReport`) derives the canonical category CODE from the
     * `ruleId` prefix, not from this field — keep that in mind when consuming
     * slim JSON externally. `subcategory` below is the code ("ad" | "privacy").
     */
    category: string;
    /** Top-level group code (#626), e.g. "seo" — which group the issue rolls up into. */
    group: string;
    subcategory?: string;
    severity: "error" | "warning" | "info";
    checks: Array<{
      name: string;
      status: "fail" | "warn";
      message: string;
      affectedPages: string[];
      affectedPagesCount: number;
      affectedPagesHasMore: boolean;
      items?: CheckItem[];
      details?: Record<string, unknown>;
      legacyValue?: string;
    }>;
  }>;
  // Report-only — never part of the score. Present when the Pro cloud
  // editor-summary call ran (exec-email-shaped narrative + big-ticket items).
  editorSummary?: {
    prose: string;
    bigTicket: string[];
    verdict: string;
    model: string;
    generatedAt: string;
  };
  // Report-only — never part of the score. Present when cloud tech-detect ran.
  technologies?: {
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

function buildSlimReport(report: AuditReport, version: string): SlimJsonReport {
  const categoryIssues = groupIssuesByCategory(report.ruleResults);
  const es = editorSummaryView(report.editorSummary);
  const refusedSeedRedirect = seedRedirect(report);
  return {
    meta: {
      version,
      baseUrl: report.baseUrl,
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
      timestamp: report.timestamp,
      totalPages: report.totalPages,
      ...(report.coverage ? { coverage: report.coverage } : {}),
    },
    status: report.status ?? "completed",
    ...(report.statusReason ? { statusReason: report.statusReason } : {}),
    // #1822: a programmatic consumer branches on the class, not on the prose.
    // Derived when the stored report predates the field, so a CI gate reading
    // it does not have to special-case older reports.
    ...(report.status === "failed" || report.status === "blocked"
      ? { statusReasonCode: reportFailureReasonCode(report) }
      : {}),
    ...(report.rateLimited && report.rateLimited.pages > 0
      ? { rateLimited: report.rateLimited }
      : {}),
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
          },
        }
      : {}),
    // Severity-first across the whole report (#1536), not category-by-category.
    issues: flattenIssuesBySeverity(categoryIssues).map((rule) => ({
      ruleId: rule.id,
      name: rule.name,
      description: rule.description,
      solution: rule.solution,
      category: rule.categoryName,
      group: rule.group,
      ...(rule.subcategory ? { subcategory: rule.subcategory } : {}),
      severity: rule.severity,
        checks: rule.checks.map((check) => {
          // #1023 R-F: affectedPages is a labeled sample; count is authoritative.
          const ap = affectedPages(check);
          return {
            name: check.name,
            status: check.status as "fail" | "warn",
            message: check.message,
            affectedPages: ap.sample,
            affectedPagesCount: ap.count,
            affectedPagesHasMore: ap.hasMore,
            items: check.items,
            details: check.details,
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
    ...(report.technologies && report.technologies.items.length > 0
      ? {
          technologies: {
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
  const slim = buildSlimReport(report, version);
  return JSON.stringify(slim, null, 2);
}
