// XML report output

import type { ReportBranding } from "@squirrelscan/core-contracts";
import type { AuditReport } from "../types";
import { getScoreGrade } from "../scoring";
import { getGroupName } from "../categories";
import { groupIssuesByCategory, flattenIssuesBySeverity, reportPassedRules } from "../grouping";
import { affectedPages, itemsNotListed } from "../affected-pages";
import { domainAgeYears } from "../site-metadata";
import { editorSummaryView } from "../editor-summary";
import { entityPageTotal, stableIdPercent } from "../entities";
import { scanScopeUnfetched, seedRedirect } from "../coverage";
import { notCheckedLine, notCheckedRules } from "../not-checked";
import { pageTypePhrase, structureAttr, structureSectionName } from "../structure";
import { checkRegionScope, itemLabel, itemRegionScope, type RegionScope } from "../region-scope";
import { checkPageTypeScope, type PageTypeScope } from "../page-type-scope";

/** `<scope page-type="docs" pages="9" type-pages="11"/>` (pub#857). */
function pageTypeScopeElement(scope: PageTypeScope): string {
  return `<scope page-type="${escapeXml(scope.pageType)}" pages="${scope.pages}" type-pages="${scope.typePages}"/>`;
}

/** `<scope region="footer" pages="49" region-pages="53" other-pages="0"/>` (pub#846). */
function scopeElement(scope: RegionScope): string {
  return `<scope region="${scope.region}" pages="${scope.pages}" region-pages="${scope.regionPages}" other-pages="${scope.otherPages}"/>`;
}

export interface XmlRenderOptions {
  version?: string;
  /** White-label branding (#810) — Team orgs get a neutral `<audit>` root. */
  branding?: ReportBranding;
  /** List the rules that passed after the issues (`--include-passed`). */
  includePassed?: boolean;
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
  // Scan scope (#350, as in every other renderer since #1180): where the audit
  // ran, the page limit in force, and whether it bound, so a consumer diffing two
  // reports can tell a site that shrank from a crawl that was capped.
  // `requested-max-pages` only when the request was clamped (#1909), and
  // `stop-reason` only when the crawl time budget ended it. Absent on a report
  // from before #1180.
  if (report.scanScope) {
    const s = report.scanScope;
    const cap = s.maxPages !== undefined ? ` max-pages="${s.maxPages}"` : "";
    const requested =
      s.requestedMaxPages !== undefined ? ` requested-max-pages="${s.requestedMaxPages}"` : "";
    const stop = s.stopReason ? ` stop-reason="${escapeXml(s.stopReason)}"` : "";
    const left = scanScopeUnfetched(report);
    const unfetched = left > 0 ? ` unfetched="${left}"` : "";
    lines.push(
      `${indent(2)}<scan-scope origin="${escapeXml(s.origin)}" crawled="${s.pagesCrawled}"${cap}${requested} capped="${s.capped}"${stop}${unfetched}/>`,
    );
  }
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
  const es = editorSummaryView(report.editorSummary, report);
  if (es) {
    lines.push(`${indent(1)}<editor-summary model="${escapeXml(es.model)}">`);
    for (const para of es.paragraphs) {
      lines.push(`${indent(2)}<para>${escapeXml(para)}</para>`);
    }
    if (es.priorities.length === 0 && es.bigTicket.length > 0) {
      lines.push(`${indent(2)}<big-ticket>`);
      for (const item of es.bigTicket) {
        lines.push(`${indent(3)}<item>${escapeXml(item)}</item>`);
      }
      lines.push(`${indent(2)}</big-ticket>`);
    }
    if (es.verdict) lines.push(`${indent(2)}<verdict>${escapeXml(es.verdict)}</verdict>`);
    lines.push(`${indent(1)}</editor-summary>`);
  }

  // Ranked priorities from the editor's summary (report-only; not scored).
  if (es && es.priorities.length > 0) {
    lines.push(`${indent(1)}<priorities>`);
    for (const [i, p] of es.priorities.entries()) {
      const rules = p.ruleIds.length > 0 ? ` rules="${escapeXml(p.ruleIds.join(" "))}"` : "";
      const tech = p.technologies.length > 0 ? ` technologies="${escapeXml(p.technologies.join(" "))}"` : "";
      lines.push(`${indent(2)}<priority rank="${i + 1}" effort="${escapeXml(p.effort)}"${rules}${tech}>`);
      lines.push(`${indent(3)}<title>${escapeXml(p.title)}</title>`);
      if (p.why) lines.push(`${indent(3)}<why>${escapeXml(p.why)}</why>`);
      lines.push(`${indent(3)}<action>${escapeXml(p.action)}</action>`);
      lines.push(`${indent(2)}</priority>`);
    }
    lines.push(`${indent(1)}</priorities>`);
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

  // Page structure (#2307) — report-only (does not affect the health score). Section and page
  // type names are the ids the JSON report uses.
  if (report.structure) {
    const structure = report.structure;
    const share = structure.chrome.share;
    lines.push(
      `${indent(1)}<page-structure pages="${structureAttr(structure.pages)}" links="${structureAttr(structure.totalLinks)}" unknown-links="${structureAttr(structure.unknownLinks)}" chrome-links="${structureAttr(structure.chrome.links)}" content-links="${structureAttr(structure.chrome.contentLinks)}"${typeof share === "number" ? ` chrome-share="${structureAttr(share)}"` : ""}>`,
    );
    for (const row of structure.sections) {
      if (structureSectionName(row.section) === undefined) continue;
      lines.push(
        `${indent(2)}<section name="${escapeXml(row.section)}" pages="${structureAttr(row.pages)}" links="${structureAttr(row.links)}"/>`,
      );
    }
    const types = structure.pageTypes;
    lines.push(
      `${indent(2)}<page-types not-classified="${structureAttr(types.notClassified)}" by-model="${structureAttr(types.byModel)}" degraded="${structureAttr(types.degraded)}">`,
    );
    for (const type of types.counts) {
      if (pageTypePhrase(type.label, type.pages) === undefined) continue;
      lines.push(
        `${indent(3)}<page-type label="${escapeXml(type.label)}" pages="${structureAttr(type.pages)}"/>`,
      );
    }
    lines.push(`${indent(2)}</page-types>`);
    lines.push(`${indent(1)}</page-structure>`);
  }

  const categoryIssues = groupIssuesByCategory(report.ruleResults, report.checkTallies);

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
        // pub#846: a check that only reads one shared region names it, beside its page list.
        const checkScope = checkRegionScope(check, pages.count, report.structure);
        if (checkScope) lines.push(`${indent(4)}${scopeElement(checkScope)}`);
        else {
          // pub#857: a check on every page of one page type names the type, beside its page list.
          const typeScope = checkPageTypeScope(check, pages.count, report.structure);
          if (typeScope) lines.push(`${indent(4)}${pageTypeScopeElement(typeScope)}`);
        }
        if (pages.sample.length > 0) {
          lines.push(
            `${indent(4)}<affected-pages count="${pages.count}" examples="${pages.sample.length}" has-more="${pages.hasMore}">`,
          );
          for (const page of pages.sample)
            lines.push(`${indent(5)}<page url="${escapeXml(page)}"/>`);
          lines.push(`${indent(4)}</affected-pages>`);
        }

        // pub#866: `not-listed` counts the items the report left out of the list.
        const left = itemsNotListed(check);
        const notListed = left > 0 ? ` not-listed="${left}"` : "";
        if (check.items && check.items.length > 0) {
          lines.push(`${indent(4)}<items count="${check.items.length}"${notListed}>`);
          for (const item of check.items) {
            lines.push(`${indent(5)}<item id="${escapeXml(item.id)}">`);
            // pub#846: the region the item is shown in, beside its bounded page list; a scoped
            // item's label drops the section phrase the region says.
            const scope = itemRegionScope(item, report.structure);
            const label = itemLabel(item, scope);
            if (label && label !== item.id) lines.push(`${indent(6)}<label>${escapeXml(label)}</label>`);
            if (scope) lines.push(`${indent(6)}${scopeElement(scope)}`);
            if (item.meta) {
              for (const [k, v] of Object.entries(item.meta)) {
                // An object value (a link's `sections` counts) as JSON, not "[object Object]".
                if (v !== undefined && v !== null)
                  lines.push(`${indent(6)}<${k}>${escapeXml(typeof v === "object" ? JSON.stringify(v) : String(v))}</${k}>`);
              }
            }
            if (item.sourcePages && item.sourcePages.length > 0) {
              // pub#837: each page once, with its links to the item and where they sit.
              const sources = new Map((item.sources ?? []).map((s) => [s.page, s]));
              lines.push(`${indent(6)}<source-pages>`);
              for (const src of new Set(item.sourcePages)) {
                const source = sources.get(src);
                const url = `url="${escapeXml(src)}"`;
                const sections = Object.entries(source?.sections ?? {}).filter(([, n]) => (n ?? 0) > 0);
                if (!source) {
                  lines.push(`${indent(7)}<page ${url}/>`);
                  continue;
                }
                const attrs = `${url} links="${escapeXml(String(source.links))}"`;
                if (sections.length === 0) {
                  lines.push(`${indent(7)}<page ${attrs}/>`);
                  continue;
                }
                lines.push(`${indent(7)}<page ${attrs}>`);
                for (const [name, n] of sections)
                  lines.push(`${indent(8)}<section name="${escapeXml(name)}" links="${escapeXml(String(n))}"/>`);
                lines.push(`${indent(7)}</page>`);
              }
              lines.push(`${indent(6)}</source-pages>`);
            }
            lines.push(`${indent(5)}</item>`);
          }
          lines.push(`${indent(4)}</items>`);
        } else if (left > 0) {
          lines.push(`${indent(4)}<items count="0"${notListed}/>`);
        }

        lines.push(`${indent(3)}</check>`);
      }
      lines.push(`${indent(2)}</rule>`);
    }
    lines.push(`${indent(1)}</issues>`);
  } else {
    lines.push(`${indent(1)}<issues/>`);
  }

  const passedRules = reportPassedRules(report, options?.includePassed);
  if (passedRules.length > 0) {
    lines.push(`${indent(1)}<passed count="${passedRules.length}">`);
    for (const rule of passedRules) {
      lines.push(
        `${indent(2)}<rule id="${escapeXml(rule.id)}" category="${escapeXml(rule.categoryName)}" scope="${rule.scope}" pages="${rule.pages}">`,
      );
      lines.push(`${indent(3)}<name>${escapeXml(rule.name)}</name>`);
      lines.push(`${indent(2)}</rule>`);
    }
    lines.push(`${indent(1)}</passed>`);
  }

  // repo#2729: checks this audit did not run. Not issues, and not clean either.
  const notChecked = notCheckedRules(report);
  if (notChecked.length > 0) {
    lines.push(`${indent(1)}<not-checked count="${notChecked.length}">`);
    for (const rule of notChecked) {
      lines.push(
        `${indent(2)}<rule id="${escapeXml(rule.ruleId)}" name="${escapeXml(rule.name)}" check="${escapeXml(rule.check)}" reason="${escapeXml(rule.reason)}">${escapeXml(notCheckedLine(rule))}</rule>`,
      );
    }
    lines.push(`${indent(1)}</not-checked>`);
  }

  // Entities (#2091) — the site's JSON-LD as one graph. Report-only, never part
  // of the score. Carries the whole document: the summary as attributes, then
  // every node and edge, so an XML consumer sees the same map the JSON one does.
  if (report.entityMap) {
    const map = report.entityMap;
    const s = map.summary;
    lines.push(
      `${indent(1)}<entities format="${escapeXml(map.format)}" version="${map.version}" site="${escapeXml(map.site)}" generated-at="${escapeXml(map.generatedAt)}" count="${s.nodeCount}" references="${s.edgeCount}" dangling="${s.danglingCount}" conflicts="${s.conflictCount}" without-id="${s.nodesWithoutIdCount}" page-local="${s.pageLocalCount}" stable-id-share="${stableIdPercent(map)}" pages="${s.pagesTotal}" pages-without-entities="${s.pagesWithoutEntities}">`
    );
    for (const node of map.nodes) {
      const id = node.id ? ` id="${escapeXml(node.id)}"` : "";
      lines.push(
        `${indent(2)}<entity key="${escapeXml(node.key)}" type="${escapeXml(node.types.join(","))}" name="${escapeXml(node.name ?? "")}"${id} occurrences="${node.occurrences}" pages="${entityPageTotal(node)}" conflicts="${node.conflicts.length}" dangling-refs="${node.danglingRefs}" page-local="${node.pageLocal}">`
      );
      for (const conflict of node.conflicts) {
        lines.push(
          `${indent(3)}<conflict property="${escapeXml(conflict.property)}">`
        );
        for (const value of conflict.values) {
          lines.push(
            `${indent(4)}<value pages="${value.pages.length + value.morePages}">${escapeXml(value.value)}</value>`
          );
        }
        lines.push(`${indent(3)}</conflict>`);
      }
      lines.push(`${indent(2)}</entity>`);
    }
    for (const edge of map.edges) {
      lines.push(
        `${indent(2)}<reference source="${escapeXml(edge.source)}" predicate="${escapeXml(edge.predicate)}" target="${escapeXml(edge.target)}" dangling="${edge.dangling}" occurrences="${edge.occurrences}"/>`
      );
    }
    lines.push(`${indent(1)}</entities>`);
  }

  lines.push(`</${rootTag}>`);
  return lines.join("\n");
}
