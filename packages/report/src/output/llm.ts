// Compact LLM-optimized report

import type { AuditReport, CheckItem } from "../types";
import { getScoreGrade } from "../scoring";
import { getGroupName } from "../categories";
import { groupIssuesByCategory } from "../grouping";
import { ruleAffectedPages, ruleAffectedRollup, ruleCarriedPageCount } from "../affected-pages";
import { getDocsUrl } from "../docs";
import { domainAgeYears } from "../site-metadata";
import { lockedRulesMessage } from "../locked-rules";
import { LLM_REPORT } from "@squirrelscan/core-contracts/limits";

export interface LlmRenderOptions {
  version?: string;
}

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

  // Failed/blocked audit (#792): nothing was audited. Without this an agent
  // reads <score overall="N/A"> + empty <issues/> as a clean pass. State it
  // plainly and 3rd-person — a block is the site refusing the crawler, not a
  // squirrelscan outage — with next steps the agent can relay to the owner.
  if (report.status === "failed" || report.status === "blocked") {
    const reasonAttr = report.statusReason ? ` reason="${escapeXml(report.statusReason)}"` : "";
    lines.push(`<status state="${report.status}"${reasonAttr}>`);
    if (report.status === "blocked") {
      lines.push(
        `${indent(1)}The site refused the crawler before any pages could be read (a 403 or 429 from bot protection, a firewall, an auth wall, or rate limiting), so nothing was audited. This is a block on the site side, not a squirrelscan outage.`,
      );
      lines.push(
        `${indent(1)}To get a full audit: allowlist the squirrelscan crawler, turn off bot fight mode for the audit, or run the CLI from a trusted network with \`squirrel audit ${escapeXml(report.baseUrl)}\`.`,
      );
    } else {
      lines.push(
        `${indent(1)}No pages could be fetched from the site, so nothing was audited. The site may have been down, unreachable, or timing out. Check that the site is reachable and try again, or run the CLI with \`squirrel audit ${escapeXml(report.baseUrl)}\`.`,
      );
    }
    lines.push("</status>");
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
    lines.push(
      `<coverage audited="${c.auditedPages}" known="${c.knownPages}" carried="${c.carriedFindings}"/>`,
    );
  }

  // Scan scope disclosure (#1180): where the audit ran + crawl cap, so an agent
  // reading the report knows what the score is based on.
  if (report.scanScope) {
    const s = report.scanScope;
    const cap = s.maxPages !== undefined ? ` max-pages="${s.maxPages}"` : "";
    lines.push(
      `<scan-scope origin="${s.origin}" crawled="${s.pagesCrawled}"${cap} capped="${s.capped}"/>`,
    );
  }

  // Editor's summary — report-only exec narrative for the agent (does not affect the score).
  if (report.editorSummary) {
    const es = report.editorSummary;
    lines.push(`<editor-summary model="${escapeXml(es.model)}">`);
    for (const para of es.prose.split(/\n{2,}/)) {
      const trimmed = para.trim();
      if (trimmed) lines.push(`${indent(1)}<para>${escapeXml(trimmed)}</para>`);
    }
    if (es.bigTicket.length > 0) {
      lines.push(`${indent(1)}<big-ticket>`);
      for (const item of es.bigTicket) {
        lines.push(`${indent(2)}<item>${escapeXml(item)}</item>`);
      }
      lines.push(`${indent(1)}</big-ticket>`);
    }
    if (es.verdict) lines.push(`${indent(1)}<verdict>${escapeXml(es.verdict)}</verdict>`);
    lines.push("</editor-summary>");
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

  const categoryIssues = groupIssuesByCategory(report.ruleResults);

  if (categoryIssues.length > 0) {
    lines.push("<issues>");
    for (const category of categoryIssues) {
      lines.push(
        `${indent(1)}<category name="${escapeXml(category.name)}" group="${escapeXml(category.group)}" errors="${category.failCount}" warnings="${category.warnCount}">`,
      );
      for (const rule of category.rules) {
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
        const carriedAttr =
          carriedChecks > 0 && carriedChecks === rule.checks.length
            ? ` provenance="carried"`
            : carriedPageCount > 0
              ? ` carried_pages="${carriedPageCount}/${allPagesForRule.size}"`
              : "";

        const docsUrl = getDocsUrl(rule.id);
        lines.push(
          `${indent(2)}<rule id="${escapeXml(rule.id)}" severity="${rule.severity}"${rule.subcategory ? ` subcategory="${escapeXml(rule.subcategory)}"` : ""} status="${ruleStatus}"${carriedAttr} docs="${escapeXml(docsUrl)}">`,
        );

        const messages = rule.checks.map((c) => c.message).filter((m) => m);
        if (messages.length > 0) lines.push(`${indent(3)}${escapeXml(messages.join("; "))}`);
        if (rule.mixedProvenanceNote) {
          lines.push(`${indent(3)}${escapeXml(rule.mixedProvenanceNote)}`);
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
        const totalPages = rollup.count;
        const totalLabel = `${totalPages}${rollup.hasMore ? "+" : ""}`;

        if (allPages.size > 0) {
          const sampledPages = sampleAffectedPagesBreadthFirst(Array.from(allPages), baseOrigin);
          const pageList = sampledPages
            .map((p) => escapeXml(compressUrl(p, baseOrigin)))
            .join(", ");
          if (sampledPages.length < totalPages) {
            lines.push(`${indent(3)}Pages (${sampledPages.length}/${totalLabel}): ${pageList}`);
          } else {
            lines.push(`${indent(3)}Pages (${totalLabel}): ${pageList}`);
          }
        }

        const allItems: CheckItem[] = [];
        for (const check of rule.checks) {
          if (check.items && check.items.length > 0) allItems.push(...check.items);
        }

        if (allItems.length > 0) {
          const sampledItems = allItems.slice(0, LLM_REPORT.maxItems);
          lines.push(
            sampledItems.length < allItems.length
              ? `${indent(3)}Items (${sampledItems.length}/${allItems.length}):`
              : `${indent(3)}Items (${allItems.length}):`,
          );

          for (const item of sampledItems) {
            const itemId = item.id.startsWith("http") ? compressUrl(item.id, baseOrigin) : item.id;
            let itemLine = `${indent(4)}- ${escapeXml(itemId)}`;
            if (item.label && item.label !== item.id) itemLine += ` (${escapeXml(item.label)})`;
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
            if (item.sourcePages && item.sourcePages.length > 0) {
              const sourcePages = item.sourcePages.slice(0, LLM_REPORT.maxItemSourcePages);
              const sources = sourcePages
                .map((s) => escapeXml(compressUrl(s, baseOrigin)))
                .join(", ");
              if (sourcePages.length < item.sourcePages.length) {
                itemLine += ` (from: ${sources}; +${item.sourcePages.length - sourcePages.length} more)`;
              } else {
                itemLine += ` (from: ${sources})`;
              }
            }
            lines.push(itemLine);
          }
        }

        lines.push(`${indent(2)}</rule>`);
      }
      lines.push(`${indent(1)}</category>`);
    }
    lines.push("</issues>");
  } else {
    lines.push("<issues/>");
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

  lines.push("</audit>");
  return lines.join("\n");
}
