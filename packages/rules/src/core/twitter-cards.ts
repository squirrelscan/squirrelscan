// core/twitter-cards - Validates Twitter Card meta tags

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const twitterCardsRule: Rule = {
  meta: {
    id: "core/twitter-cards",
    name: "Twitter Cards",
    description: "Validates Twitter Card meta tags",
    solution:
      "Twitter Cards enhance how links appear in tweets. The twitter:card meta tag specifies the card type (summary, summary_large_image, player, or app). Add twitter:card, twitter:title, twitter:description, and twitter:image tags. For large images, use summary_large_image with images at least 800x418 pixels. Validate using Twitter's Card Validator tool.",
    category: "core",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const { twitter, og } = ctx.parsed;
    const checks: CheckResult[] = [];

    // Check twitter:card type
    if (!twitter.card) {
      // Twitter will fall back to OG tags, so this is just informational
      if (og.title && og.description) {
        checks.push({
          name: "twitter-card",
          status: "info",
          message: "No Twitter card specified, will use Open Graph fallback",
          value: null,
        });
      } else {
        checks.push({
          name: "twitter-card",
          status: "warn",
          message: "No Twitter card or Open Graph tags for Twitter sharing",
          value: null,
        });
      }
      return { checks };
    }

    // Validate card type
    const validTypes = ["summary", "summary_large_image", "app", "player"];
    if (!validTypes.includes(twitter.card)) {
      checks.push({
        name: "twitter-card",
        status: "warn",
        message: `Invalid Twitter card type: ${twitter.card}`,
        details: { card: twitter.card },
        items: validTypes.map((type) => ({
          id: type,
          label: `Valid: ${type}`,
        })),
      });
      return { checks };
    }

    // Check required fields for card types
    if (twitter.card === "summary_large_image" && !twitter.image && !og.image) {
      checks.push({
        name: "twitter-card",
        status: "warn",
        message: "summary_large_image card requires an image",
        value: twitter.card,
      });
      return { checks };
    }

    checks.push({
      name: "twitter-card",
      status: "pass",
      message: `Twitter card configured: ${twitter.card}`,
      value: twitter.card,
    });

    return { checks };
  },
};
