// links/nofollow-internal - Internal links with nofollow

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { isCloudflareEmailProtectionUrl } from "@squirrelscan/utils";

import {
  addSection,
  pageRegionsField,
  sectionMeta,
  withSection,
  type SectionCounts,
} from "./link-section-label";

export const nofollowInternalRule: Rule = {
  meta: {
    id: "links/nofollow-internal",
    name: "Nofollow Internal",
    description: "Flags internal links with rel=nofollow",
    solution:
      "Nofollow on internal links wastes PageRank and is generally bad practice. Internal links should flow link equity freely throughout your site. Remove nofollow from internal links unless you have a specific reason (e.g., user-generated content links). Use nofollow for external links you don't endorse.",
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

    const nofollowInternal: string[] = [];
    // The resolved URL of each, to look up where it sits (#2307).
    const resolvedOf = new Map<string, string>();

    const links = doc.querySelectorAll("a[href][rel]");

    for (const link of links) {
      const href = link.getAttribute("href");
      const rel = link.getAttribute("rel") || "";

      if (!href) continue;

      // Cloudflare's email-protection link is a mailto in the browser, not a page (pub#838).
      if (isCloudflareEmailProtectionUrl(href)) continue;

      // Check if nofollow
      const hasNofollow = rel.toLowerCase().includes("nofollow");
      if (!hasNofollow) continue;

      // Check if internal
      try {
        const linkUrl = new URL(href, ctx.page.url);
        if (linkUrl.hostname === pageUrl.hostname) {
          nofollowInternal.push(href);
          resolvedOf.set(href, linkUrl.toString());
        }
      } catch {
        // Invalid URL
      }
    }

    if (nofollowInternal.length > 0) {
      // #2307: where the nofollowed links sit, by resolved URL. Only links that carry `nofollow`
      // count, as in the check above: a followed link to the same URL elsewhere on the page, or
      // one marked only `sponsored` or `ugc` (which `isNofollow` also covers), does not change it.
      // A parse that recorded no `rel` has nothing to say, and the items stay bare.
      const placed = new Map<string, SectionCounts>();
      for (const link of ctx.parsed.links ?? []) {
        if (link.isInternal && link.rel?.some((r) => r.toLowerCase() === "nofollow")) {
          addSection(placed, link.url, link.section);
        }
      }
      checks.push({
        name: "nofollow-internal",
        status: "warn",
        message: `${nofollowInternal.length} internal link(s) have nofollow`,
        items: nofollowInternal.map((url) => {
          const sections = placed.get(resolvedOf.get(url) ?? "");
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
        name: "nofollow-internal",
        status: "pass",
        message: "No internal links with nofollow",
      });
    }

    return { checks };
  },
};
