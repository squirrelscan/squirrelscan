// JSON report output

import type { AuditReport, AuditStatus, CheckItem } from "../types";
import { getScoreGrade } from "../scoring";
import { getGroupName } from "../categories";
import { groupIssuesByCategory } from "../grouping";
import { affectedPages } from "../affected-pages";
import { techIconUrl } from "../technologies";
import { domainAgeYears, siteProfileRows } from "../site-metadata";

export interface JsonRenderOptions {
  version?: string;
}

interface SlimJsonReport {
  meta: {
    version: string;
    baseUrl: string;
    timestamp: string;
    totalPages: number;
    /** Smart audits (#110): present only when `smart_audits` ran. */
    coverage?: {
      auditedPages: number;
      knownPages: number;
      carriedFindings: number;
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
  return {
    meta: {
      version,
      baseUrl: report.baseUrl,
      timestamp: report.timestamp,
      totalPages: report.totalPages,
      ...(report.coverage ? { coverage: report.coverage } : {}),
    },
    status: report.status ?? "completed",
    ...(report.statusReason ? { statusReason: report.statusReason } : {}),
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
    ...(report.editorSummary
      ? {
          editorSummary: {
            prose: report.editorSummary.prose,
            bigTicket: report.editorSummary.bigTicket,
            verdict: report.editorSummary.verdict,
            model: report.editorSummary.model,
            generatedAt: report.editorSummary.generatedAt,
          },
        }
      : {}),
    issues: categoryIssues.flatMap((category) =>
      category.rules.map((rule) => ({
        ruleId: rule.id,
        name: rule.name,
        description: rule.description,
        solution: rule.solution,
        category: category.name,
        group: category.group,
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
            ...(check.carriedCount && check.carriedCount >= check.count
              ? {
                  provenance: "carried" as const,
                  ...(check.lastSeenAt ? { lastSeenAt: check.lastSeenAt } : {}),
                }
              : {}),
          };
        }),
      })),
    ),
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
