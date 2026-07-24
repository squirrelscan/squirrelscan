// legal/subprocessor-disclosure - GDPR Art. 28 sub-processor / DPA disclosure
//
// SaaS / fintech / software vendors that process customer personal data on behalf
// of their customers are controllers' processors under GDPR Art. 28 and must
// publish the sub-processors they use (plus a Data Processing Agreement / DPA).
// This site-scope rule looks for a subprocessors / data-processing / DPA page or
// link. It is gated (`appliesWhen`) to the site/business types where this duty is
// relevant — for everyone else (and offline / no-metadata) it never runs.

import type { Rule, RuleContext, RuleResult, CheckResult, ParsedPage } from "../types";

import { getPathname } from "@squirrelscan/utils";

// URL-path patterns for a dedicated sub-processor / data-processing page.
const SUBPROCESSOR_PATH_PATTERNS = [
  /\/sub[-_]?processors?\b/i,
  /\/data[-_]?processing\b/i,
  /\/data[-_]?processing[-_]?agreement\b/i,
  /\/dpa\b/i,
  /\/gdpr\/?$/i,
  /\/trust\/(sub[-_]?processors?|data[-_]?processing)/i,
];

// Link-text patterns (the page may live at a non-obvious URL but be linked with
// explicit anchor text).
const SUBPROCESSOR_TEXT_PATTERNS = [
  /sub[-\s]?processors?/i,
  /data[-\s]?processing[-\s]?agreement/i,
  /\bdpa\b/i,
];

/**
 * The first sub-processor / DPA link match on ONE page's live DOM (`href || url`),
 * or null — the exact break-on-first-anchor result the rule's legacy step-2 loop
 * produces. Shared by the page-time collector (#1021 E-E2) and the legacy fallback.
 */
export function matchSubprocessorLink(
  doc: NonNullable<ParsedPage["document"]>,
  pageUrl: string
): string | null {
  for (const link of doc.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") || "";
    const text = (link.textContent || "").trim();
    const hrefMatches = SUBPROCESSOR_PATH_PATTERNS.some((p) => p.test(href));
    const textMatches = SUBPROCESSOR_TEXT_PATTERNS.some((p) => p.test(text));
    if (hrefMatches || textMatches) {
      return href || pageUrl;
    }
  }
  return null;
}

export const subprocessorDisclosureRule: Rule = {
  meta: {
    id: "legal/subprocessor-disclosure",
    name: "Sub-processor Disclosure",
    description: "Checks for a sub-processor / data-processing (DPA) disclosure page or link",
    solution:
      "Under GDPR Art. 28, processors must disclose the sub-processors they engage and offer a Data Processing Agreement (DPA). Publish a /subprocessors page listing each third party that handles customer personal data (purpose, location), keep it current, and link a DPA from your legal/trust pages. B2B SaaS and fintech buyers expect this during security review.",
    category: "legal",
    scope: "site",
    severity: "info",
    weight: 3,
    // Art. 28 sub-processor duty applies to commercial data-processors. Gate on
    // tech/business SITE TYPES — `siteType` is always present (NOT NULL), so this
    // also covers a SaaS whose fine-grained `businessCategory` came back null —
    // AND, when a category IS known, narrow to the data-heavy ones. The siteTypes
    // guard fixes the false positive where a personal blog / news site (category
    // null) used to fire this warning. Offline / no-metadata / low-confidence → runs.
    appliesWhen: {
      siteTypes: ["saas", "web_app", "corporate"],
      businessCategories: ["software_technology", "fintech", "banking", "it_services"],
    },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "subprocessor-disclosure",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    let disclosureUrl: string | null = null;

    // 1) A dedicated page by URL path.
    for (const page of pages) {
      const path = getPathname(page.url);
      if (SUBPROCESSOR_PATH_PATTERNS.some((p) => p.test(path))) {
        disclosureUrl = page.url;
        break;
      }
    }

    // 2) A link to a sub-processor / DPA page (text or href) on any crawled page.
    // Streaming (#1021): read the per-page match captured at page-time; else scan
    // each live document (v1). Both iterate pages in the same order and take the
    // first match, so the chosen disclosure URL is identical.
    if (!disclosureUrl) {
      if (ctx.collectedSignals) {
        for (const rec of ctx.collectedSignals.pages) {
          if (rec.subprocessorMatch) {
            disclosureUrl = rec.subprocessorMatch;
            break;
          }
        }
      } else {
        for (const page of pages) {
          const doc = page.parsed.document;
          if (!doc) continue;
          const match = matchSubprocessorLink(doc, page.url);
          if (match) {
            disclosureUrl = match;
            break;
          }
        }
      }
    }

    if (disclosureUrl) {
      checks.push({
        name: "subprocessor-disclosure",
        status: "pass",
        message: "Sub-processor / data-processing disclosure found",
        value: disclosureUrl,
      });
    } else {
      checks.push({
        name: "subprocessor-disclosure",
        status: "warn",
        message: "No sub-processor / data-processing (DPA) disclosure found",
        value: "Publish a /subprocessors page + DPA (GDPR Art. 28)",
      });
    }

    return { checks };
  },
};
