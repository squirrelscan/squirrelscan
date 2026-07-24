// social/social-profiles - Social profile links detection
//
// Context-aware: when the Stage-0 profile knows official social accounts (from
// JSON-LD sameAs / og / visible links during metadata extraction), this rule
// cross-checks them against the page's actual links and FLAGS any detected
// account the page fails to link. Gated to site types where a social presence is
// expected; offline / no-metadata behaves exactly as today.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { crossCheckSocials, socialPlatformLabel } from "./social-match";

const SOCIAL_PLATFORMS = [
  { name: "Facebook", pattern: /facebook\.com\// },
  { name: "Twitter/X", pattern: /twitter\.com\/|x\.com\// },
  { name: "Instagram", pattern: /instagram\.com\// },
  { name: "LinkedIn", pattern: /linkedin\.com\// },
  { name: "YouTube", pattern: /youtube\.com\// },
  { name: "TikTok", pattern: /tiktok\.com\// },
  { name: "Pinterest", pattern: /pinterest\.com\// },
];

export const socialProfilesRule: Rule = {
  meta: {
    id: "social/social-profiles",
    name: "Social Profiles",
    description: "Checks for links to social media profiles",
    solution:
      "Link to your social media profiles from your website. Include in footer or about page. Use Organization schema with sameAs property to list all official social profiles. This helps Google's Knowledge Panel and verifies your brand across platforms. Ensure links open in new tabs.",
    category: "social",
    scope: "page",
    severity: "info",
    weight: 2,
    // A linked social presence matters for brand / commerce / publisher sites;
    // it's noise for docs, landing pages, personal pages. Gate to types where a
    // social presence is expected. Offline / no-metadata runs as today.
    appliesWhen: {
      siteTypes: [
        "ecommerce",
        "marketplace",
        "corporate",
        "smb_local",
        "agency",
        "saas",
        "news",
        "blog",
        "nonprofit",
        "media_streaming",
      ],
    },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const links = doc.querySelectorAll("a[href]");
    const foundProfiles: string[] = [];
    const pageHrefs: string[] = [];

    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (href) pageHrefs.push(href);

      for (const platform of SOCIAL_PLATFORMS) {
        if (
          platform.pattern.test(href) &&
          !foundProfiles.includes(platform.name)
        ) {
          foundProfiles.push(platform.name);
        }
      }
    }

    if (foundProfiles.length > 0) {
      checks.push({
        name: "social-profiles",
        status: "pass",
        message: `${foundProfiles.length} social platform(s) linked`,
        items: foundProfiles.map((platform) => ({ id: platform })),
      });
    } else {
      checks.push({
        name: "social-profiles",
        status: "info",
        message: "No social media profile links found",
        value: "Consider adding to footer",
      });
    }

    // Cross-check the detected (Stage-0) social accounts against the page links.
    // No-op when the profile has no socials (offline / free / nothing detected).
    const { missing } = crossCheckSocials(ctx.siteMetadata, pageHrefs);
    if (missing.length > 0) {
      checks.push({
        name: "social-profiles-missing",
        status: "warn",
        message: `${missing.length} known social account(s) not linked on this page`,
        value: "Link your official social profiles (Organization sameAs)",
        items: missing.map((a) => ({
          id: a.url,
          label: socialPlatformLabel(a.platform),
        })),
      });
    }

    return { checks };
  },
};
