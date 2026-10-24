// links/https-downgrade - HTTPS to HTTP downgrade detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { isCloudflareEmailProtectionUrl } from "@squirrelscan/utils";

import {
  addSection,
  pageRegionsField,
  sectionMeta,
  withSection,
  type SectionCounts,
} from "./link-section-label";

export const httpsDowngradeRule: Rule = {
  meta: {
    id: "links/https-downgrade",
    name: "HTTPS Downgrade",
    description: "Detects links from HTTPS pages to HTTP destinations",
    solution:
      "Links from HTTPS to HTTP pages create security warnings and break the trust chain. Users may see 'not secure' warnings. Update all links to use HTTPS. If the target site doesn't support HTTPS, consider if you really need to link there. For internal links, ensure your entire site uses HTTPS.",
    category: "links",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const pageUrl = new URL(ctx.page.url);

    // Only check if current page is HTTPS
    if (pageUrl.protocol !== "https:") {
      checks.push({
        name: "https-downgrade",
        status: "info",
        message: "Page is not HTTPS, downgrade check not applicable",
      });
      return { checks };
    }

    const httpLinks: string[] = [];
    const links = doc.querySelectorAll("a[href]");

    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;

      // Check for explicit http:// links. Cloudflare's email-protection link is a mailto in the
      // browser, not a page, so its scheme is no downgrade (pub#811, pub#838).
      if (href.startsWith("http://") && !isCloudflareEmailProtectionUrl(href)) {
        httpLinks.push(href);
      }
    }

    if (httpLinks.length > 0) {
      // #2307: where each offending link sits, by resolved URL. Without sections (an old crawl)
      // the items stay bare.
      const placed = new Map<string, SectionCounts>();
      for (const link of ctx.parsed.links ?? []) {
        if (link.url.startsWith("http://")) addSection(placed, link.url, link.section);
      }
      const resolve = (href: string): string | undefined => {
        try {
          return new URL(href, ctx.page.url).toString();
        } catch {
          return undefined;
        }
      };
      checks.push({
        name: "https-downgrade",
        status: "warn",
        message: `${httpLinks.length} link(s) downgrade to HTTP`,
        items: httpLinks.map((url) => {
          const resolved = resolve(url);
          const sections = resolved ? placed.get(resolved) : undefined;
          return sections
            ? {
                id: url,
                label: withSection(url, sections),
                meta: sectionMeta(sections),
                // pub#846: the page's sections, so the report can scope a repeated link to one.
                ...pageRegionsField(sections),
              }
            : { id: url };
        }),
      });
    } else {
      checks.push({
        name: "https-downgrade",
        status: "pass",
        message: "No HTTPS to HTTP downgrades",
      });
    }

    return { checks };
  },
};
