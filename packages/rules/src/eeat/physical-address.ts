// eeat/physical-address - Physical address visibility

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const physicalAddressRule: Rule = {
  meta: {
    id: "eeat/physical-address",
    name: "Physical Address",
    description: "Checks for visible physical address information",
    solution:
      "A physical address builds trust and is essential for local businesses. Include in: footer, contact page, about page. Use PostalAddress schema markup. For local SEO, ensure NAP (Name, Address, Phone) consistency across the site and external listings. Virtual businesses can use registered office addresses.",
    category: "eeat",
    scope: "site",
    severity: "info",
    weight: 3,
    // A visible physical address is a trust signal for real-world local
    // businesses; an online-only SaaS / blog has no storefront to surface. Gate to
    // local businesses. Offline / no-metadata runs as today.
    appliesWhen: { requiresLocalBusiness: true },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "physical-address",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Check for address schema
    let hasAddressSchema = false;
    let hasLocalBusinessSchema = false;

    for (const page of pages) {
      if (page.parsed.schema.types.includes("PostalAddress")) {
        hasAddressSchema = true;
      }
      if (
        page.parsed.schema.types.some((t) =>
          ["LocalBusiness", "Organization", "Restaurant", "Store"].includes(t)
        )
      ) {
        hasLocalBusinessSchema = true;
      }
    }

    if (hasAddressSchema || hasLocalBusinessSchema) {
      checks.push({
        name: "physical-address",
        status: "pass",
        message: "Address schema markup found",
        value: hasLocalBusinessSchema
          ? "LocalBusiness/Organization"
          : "PostalAddress",
      });
    } else {
      checks.push({
        name: "physical-address",
        status: "info",
        message: "No address schema markup detected",
        value: "Add PostalAddress schema if applicable",
      });
    }

    return { checks };
  },
};
