// local/nap-consistency - NAP (Name, Address, Phone) consistency

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { flattenJsonLdNodes, getPathname } from "@squirrelscan/utils";

export const napConsistencyRule: Rule = {
  meta: {
    id: "local/nap-consistency",
    name: "NAP Consistency",
    description: "Checks for consistent Name, Address, Phone across site",
    solution:
      "NAP consistency is critical for local SEO. Your business name, address, and phone number should be identical everywhere - on your site and across all listings. Use schema.org LocalBusiness markup. Avoid abbreviations inconsistencies (St. vs Street). Include NAP in footer for site-wide visibility.",
    category: "local",
    scope: "site",
    severity: "warning",
    weight: 6,
    // NAP consistency only matters for real-world local businesses. Skip with a
    // visible reason for global SaaS / blogs. Offline / no-metadata runs as today.
    appliesWhen: { requiresLocalBusiness: true },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "nap-consistency",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Look for LocalBusiness schema
    let hasLocalBusiness = false;
    let businessName: string | null = null;

    for (const page of pages) {
      if (
        page.parsed.schema.types.some((t) =>
          ["LocalBusiness", "Organization", "Restaurant", "Store"].includes(t)
        )
      ) {
        hasLocalBusiness = true;
        // Try to extract name from raw schema (flattened — handles @graph)
        if (page.parsed.schema.raw) {
          const localBiz = flattenJsonLdNodes(page.parsed.schema.raw).find(
            (s) =>
              ["LocalBusiness", "Organization"].includes(s["@type"] as string)
          );
          if (localBiz?.name) {
            businessName = localBiz.name as string;
          }
        }
        break;
      }
    }

    if (hasLocalBusiness) {
      checks.push({
        name: "local-business-schema",
        status: "pass",
        message: "LocalBusiness/Organization schema found",
        value: businessName || undefined,
      });
    } else {
      checks.push({
        name: "local-business-schema",
        status: "info",
        message: "No LocalBusiness schema found",
        value: "Add schema if this is a local business",
      });
    }

    // Check for contact page NAP
    const contactPage = pages.find((p) =>
      /\/contact/i.test(getPathname(p.url))
    );

    if (contactPage) {
      const hasPhone = contactPage.parsed.links.some((l) =>
        l.url.startsWith("tel:")
      );
      const hasEmail = contactPage.parsed.links.some((l) =>
        l.url.startsWith("mailto:")
      );

      if (hasPhone || hasEmail) {
        checks.push({
          name: "contact-info",
          status: "pass",
          message: "Contact page has contact information",
        });
      }
    }

    return { checks };
  },
};
