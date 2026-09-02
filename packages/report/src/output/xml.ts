// XML report output

import type { ReportBranding } from "@squirrelscan/core-contracts";
import type { AuditReport } from "../types";
import { getScoreGrade } from "../scoring";
import { getGroupName } from "../categories";
import { groupIssuesByCategory, flattenIssuesBySeverity } from "../grouping";
import { affectedPages } from "../affected-pages";
import { domainAgeYears } from "../site-metadata";
import { editorSummaryView } from "../editor-summary";
import { seedRedirect } from "../coverage";

export interface XmlRenderOptions {
  version?: string;
  /** White-label branding (#810) — Team orgs get a neutral `<audit>` root. */
  branding?: ReportBranding;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function indent(level: number): string {
  return "  ".repeat(level);
}

export function renderXml(report: AuditReport, options?: XmlRenderOptions): string {
  const lines: string[] = [];
  const version = options?.version ?? "0.0.0";
  // White-label drops the squirrelscan-branded root element name (#810).
  const rootTag = options?.branding?.whiteLabel ? "audit" : "squirrelscan-audit";

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<${rootTag} version="${escapeXml(version)}">`);

  lines.push(`${indent(1)}<site>`);
  lines.push(`${indent(2)}<url>${escapeXml(report.baseUrl)}</url>`);
  lines.push(`${indent(2)}<pages-crawled>${report.totalPages}</pages-crawled>`);
  lines.push(`${indent(2)}<audit-date>${escapeXml(report.timestamp)}</audit-date>`);
  lines.push(`${indent(1)}</site>`);

  // Refused off-site seed redirect (#1418): the seed left its own registrable
  // domain, the crawler declined to follow it, and `<site><url>` above is what
  // was graded. Without this the document is a clean audit of a URL nobody
  // asked for. `<final-url>` is a URL the AUDITED SITE chose — reported, never
  // a destination to go fetch — and is omitted entirely when it did not survive
  // canonicalization, in which case `<note>` says so.
  const refusedSeedRedirect = seedRedirect(report);
  if (refusedSeedRedirect) {
    lines.push(`${indent(1)}<seed-redirect followed="false">`);
    if (refusedSeedRedirect.finalUrl) {
      lines.push(`${indent(2)}<final-url>${escapeXml(refusedSeedRedirect.finalUrl)}</final-url>`);
    }
    lines.push(`${indent(2)}<note>${escapeXml(refusedSeedRedirect.note)}</note>`);
    lines.push(`${indent(1)}</seed-redirect>`);
  }

  // null ⇒ N/A (failed/0-page audit) — never coerce to 0/"F" (#586).
  const overall = report.healthScore?.overall ?? null;
  const grade = overall === null ? "N/A" : getScoreGrade(overall);
  lines.push(`${indent(1)}<health-score overall="${overall ?? "N/A"}" grade="${grade}">`);
  // Top-level group scores (#626), above the finer per-category scores.
  for (const g of report.healthScore?.groups ?? []) {
    lines.push(
      `${indent(2)}<group name="${escapeXml(getGroupName(g.group))}" score="${g.score}" passed="${g.passed}" warnings="${g.warnings}" failed="${g.failed}"/>`,
    );
  }
  for (const cat of report.healthScore?.categories ?? []) {
    lines.push(`${indent(2)}<category name="${escapeXml(cat.name)}" score="${cat.score}"/>`);
  }
  lines.push(`${indent(1)}</health-score>`);

  lines.push(`${indent(1)}<summary passed="${report.passed}" warnings="${report.warnings}" failed="${report.failed}"/>`);

  // Editor's summary — report-only exec narrative (does not affect the health score).
  const es = editorSummaryView(report.editorSummary);
  if (es) {
    lines.push(`${indent(1)}<editor-summary model="${escapeXml(es.model)}">`);
    for (const para of es.paragraphs) {
      lines.push(`${indent(2)}<para>${escapeXml(para)}</para>`);
    }
    if (es.bigTicket.length > 0) {
      lines.push(`${indent(2)}<big-ticket>`);
      for (const item of es.bigTicket) {
        lines.push(`${indent(3)}<item>${escapeXml(item)}</item>`);
      }
      lines.push(`${indent(2)}</big-ticket>`);
    }
    if (es.verdict) lines.push(`${indent(2)}<verdict>${escapeXml(es.verdict)}</verdict>`);
    lines.push(`${indent(1)}</editor-summary>`);
  }

  // Site profile — report-only (Stage-0 context; does not affect the health score).
  const meta = report.siteMetadata;
  if (meta) {
    const cat = meta.businessCategory ? ` business-category="${escapeXml(meta.businessCategory)}"` : "";
    const aud = meta.audienceScope ? ` audience-scope="${escapeXml(meta.audienceScope)}"` : "";
    const ctry = meta.primaryCountry ? ` primary-country="${escapeXml(meta.primaryCountry)}"` : "";
    lines.push(
      `${indent(1)}<site-profile site-type="${escapeXml(meta.siteType)}"${cat}${aud}${ctry} ymyl="${meta.isYMYL}" local-business="${meta.isLocalBusiness}" confidence="${escapeXml(meta.confidence)}">`,
    );
    if (meta.languages && meta.languages.length > 0) {
      lines.push(`${indent(2)}<languages>${escapeXml(meta.languages.join(", "))}</languages>`);
    }
    const entityName = meta.entityName ?? meta.title;
    if (entityName) {
      const et = meta.entityType && meta.entityType !== "unknown" ? ` kind="${escapeXml(meta.entityType)}"` : "";
      const eu = meta.entityUrl ? ` url="${escapeXml(meta.entityUrl)}"` : "";
      lines.push(`${indent(2)}<identity name="${escapeXml(entityName)}"${et}${eu}/>`);
    }
    if (meta.contacts && meta.contacts.length > 0) {
      lines.push(`${indent(2)}<contacts>`);
      for (const c of meta.contacts) {
        const label = c.label ? ` label="${escapeXml(c.label)}"` : "";
        lines.push(`${indent(3)}<contact kind="${escapeXml(c.kind)}" value="${escapeXml(c.value)}"${label}/>`);
      }
      lines.push(`${indent(2)}</contacts>`);
    }
    if (meta.socials && meta.socials.length > 0) {
      lines.push(`${indent(2)}<socials>`);
      for (const s of meta.socials) {
        const handle = s.handle ? ` handle="${escapeXml(s.handle)}"` : "";
        lines.push(`${indent(3)}<social platform="${escapeXml(s.platform)}" url="${escapeXml(s.url)}"${handle}/>`);
      }
      lines.push(`${indent(2)}</socials>`);
    }
    const years = domainAgeYears(meta);
    if (years != null || meta.registeredAt || meta.registrar) {
      const ya = years != null ? ` age-years="${years}"` : "";
      const ad = meta.domainAgeDays != null ? ` age-days="${meta.domainAgeDays}"` : "";
      const ra = meta.registeredAt ? ` registered="${escapeXml(meta.registeredAt)}"` : "";
      const ea = meta.expiresAt ? ` expires="${escapeXml(meta.expiresAt)}"` : "";
      const rg = meta.registrar ? ` registrar="${escapeXml(meta.registrar)}"` : "";
      lines.push(`${indent(2)}<domain${ya}${ad}${ra}${ea}${rg}/>`);
    }
    lines.push(`${indent(1)}</site-profile>`);
  }

  // Technologies — report-only (does not affect the health score).
  if (report.technologies && report.technologies.items.length > 0) {
    const tech = report.technologies;
    lines.push(
      `${indent(1)}<technologies first-scan="${tech.firstScan}" added="${tech.added.length}" removed="${tech.removed.length}">`,
    );
    for (const t of tech.items) {
      const ver = t.version ? ` version="${escapeXml(t.version)}"` : "";
      const icon = t.icon ? ` icon="${escapeXml(t.icon)}"` : "";
      lines.push(
        `${indent(2)}<technology name="${escapeXml(t.name)}" category="${escapeXml(t.category)}"${ver}${icon}/>`,
      );
    }
    lines.push(`${indent(1)}</technologies>`);
  }

  const categoryIssues = groupIssuesByCategory(report.ruleResults);

  if (categoryIssues.length > 0) {
    lines.push(`${indent(1)}<issues>`);
    // Flat and severity-first (#1536): no <category> wrapper — each rule carries
    // its category and group as attributes, so document order IS fix order.
    for (const rule of flattenIssuesBySeverity(categoryIssues)) {
      lines.push(`${indent(2)}<rule id="${escapeXml(rule.id)}" severity="${rule.severity}" category="${escapeXml(rule.categoryName)}" group="${escapeXml(rule.group)}"${rule.subcategory ? ` subcategory="${escapeXml(rule.subcategory)}"` : ""}>`);
      lines.push(`${indent(3)}<name>${escapeXml(rule.name)}</name>`);
      lines.push(`${indent(3)}<description>${escapeXml(rule.description)}</description>`);
      if (rule.solution) lines.push(`${indent(3)}<solution>${escapeXml(rule.solution)}</solution>`);

      for (const check of rule.checks) {
        lines.push(`${indent(3)}<check name="${escapeXml(check.name)}" status="${check.status}">`);
        lines.push(`${indent(4)}<message>${escapeXml(check.message)}</message>`);

        // #1023 R-F: count is the authoritative total; the listed pages are a
        // labeled sample (examples) when has-more.
        const pages = affectedPages(check);
        if (pages.sample.length > 0) {
          lines.push(
            `${indent(4)}<affected-pages count="${pages.count}" examples="${pages.sample.length}" has-more="${pages.hasMore}">`,
          );
          for (const page of pages.sample)
            lines.push(`${indent(5)}<page url="${escapeXml(page)}"/>`);
          lines.push(`${indent(4)}</affected-pages>`);
        }

        if (check.items && check.items.length > 0) {
          lines.push(`${indent(4)}<items count="${check.items.length}">`);
          for (const item of check.items) {
            lines.push(`${indent(5)}<item id="${escapeXml(item.id)}">`);
            if (item.label && item.label !== item.id) lines.push(`${indent(6)}<label>${escapeXml(item.label)}</label>`);
            if (item.meta) {
              for (const [k, v] of Object.entries(item.meta)) {
                if (v !== undefined && v !== null) lines.push(`${indent(6)}<${k}>${escapeXml(String(v))}</${k}>`);
              }
            }
            if (item.sourcePages && item.sourcePages.length > 0) {
              lines.push(`${indent(6)}<source-pages>`);
              for (const src of item.sourcePages) lines.push(`${indent(7)}<page url="${escapeXml(src)}"/>`);
              lines.push(`${indent(6)}</source-pages>`);
            }
            lines.push(`${indent(5)}</item>`);
          }
          lines.push(`${indent(4)}</items>`);
        }

        lines.push(`${indent(3)}</check>`);
      }
      lines.push(`${indent(2)}</rule>`);
    }
    lines.push(`${indent(1)}</issues>`);
  } else {
    lines.push(`${indent(1)}<issues/>`);
  }

  lines.push(`</${rootTag}>`);
  return lines.join("\n");
}
