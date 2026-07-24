// schema/organization - Organization schema validation
//
// Validation of name/url/logo/sameAs is universally useful and stays UNGATED.
// When the Stage-0 profile knows official social accounts, the rule additionally
// cross-checks the schema `sameAs` array against them and flags any detected
// account the markup omits. The cross-check is a no-op without metadata.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { crossCheckSocials, socialPlatformLabel } from "../social/social-match";

const REQUIRED_PROPS = ["name", "url"];

export const organizationSchemaRule: Rule = {
  meta: {
    id: "schema/organization",
    name: "Organization Schema",
    description: "Validates Organization schema for brand presence",
    solution:
      "Organization schema helps Google understand your brand and may show a knowledge panel. Required: name, url, logo. Add contactPoint for customer service info, sameAs for social profiles (LinkedIn, Twitter, etc.). Place on homepage or about page. For local businesses, use LocalBusiness instead.",
    category: "schema",
    scope: "page",
    severity: "info",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let orgSchema: Record<string, unknown> | null = null;

    for (const script of schemaScripts) {
      try {
        const data = JSON.parse(script.textContent || "");
        const schemas = Array.isArray(data) ? data : [data];

        for (const schema of schemas) {
          const type = schema["@type"];
          if (
            type === "Organization" ||
            type === "Corporation" ||
            (Array.isArray(type) &&
              (type.includes("Organization") || type.includes("Corporation")))
          ) {
            orgSchema = schema;
            break;
          }
        }
      } catch {
        // Invalid JSON
      }
    }

    if (!orgSchema) {
      checks.push({
        name: "organization-schema",
        status: "info",
        message: "No Organization schema found",
      });
      return { checks };
    }

    // Check required properties
    const missing: string[] = [];
    for (const prop of REQUIRED_PROPS) {
      if (!orgSchema[prop]) {
        missing.push(prop);
      }
    }

    if (missing.length > 0) {
      checks.push({
        name: "organization-required",
        status: "warn",
        message: `Organization schema missing required properties`,
        items: missing.map((prop) => ({ id: prop })),
      });
    } else {
      checks.push({
        name: "organization-required",
        status: "pass",
        message: "Organization schema has required properties",
      });
    }

    // Check logo
    const logo = orgSchema["logo"];
    if (!logo) {
      checks.push({
        name: "organization-logo",
        status: "info",
        message: "Organization missing logo",
        value: "Add logo for knowledge panel",
      });
    }

    // Check sameAs (social profiles)
    const sameAs = orgSchema["sameAs"];
    const sameAsUrls: string[] = sameAs
      ? (Array.isArray(sameAs) ? sameAs : [sameAs]).filter(
          (u): u is string => typeof u === "string"
        )
      : [];
    if (sameAsUrls.length > 0) {
      checks.push({
        name: "organization-social",
        status: "pass",
        message: `${sameAsUrls.length} social profile(s) linked`,
      });
    } else {
      checks.push({
        name: "organization-social",
        status: "info",
        message: "No sameAs social profiles",
        value: "Link to social profiles for brand verification",
      });
    }

    // Cross-check detected (Stage-0) social accounts against the schema sameAs.
    // No-op without metadata or detected socials — keeps behaviour identical then.
    const { missing: missingSocials } = crossCheckSocials(ctx.siteMetadata, sameAsUrls);
    if (missingSocials.length > 0) {
      checks.push({
        name: "organization-sameas-missing",
        status: "warn",
        message: `${missingSocials.length} known social account(s) missing from schema sameAs`,
        value: "Add detected official profiles to Organization sameAs",
        items: missingSocials.map((a) => ({
          id: a.url,
          label: socialPlatformLabel(a.platform),
        })),
      });
    }

    return { checks };
  },
};
