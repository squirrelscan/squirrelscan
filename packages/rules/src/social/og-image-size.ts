// social/og-image-size - Open Graph image size check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const ogImageSizeRule: Rule = {
  meta: {
    id: "social/og-image-size",
    name: "OG Image Size",
    description: "Checks og:image meets recommended size (1200x630)",
    solution:
      "og:image should be at least 1200x630 pixels for optimal display on Facebook and LinkedIn. Smaller images may appear cropped or low quality. Use 1.91:1 aspect ratio. Keep file size under 8MB. Test with Facebook Sharing Debugger. Consider creating dedicated social images for key pages.",
    category: "social",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const ogImage = doc.querySelector('meta[property="og:image"]');
    const ogImageWidth = doc.querySelector('meta[property="og:image:width"]');
    const ogImageHeight = doc.querySelector('meta[property="og:image:height"]');

    if (!ogImage) {
      checks.push({
        name: "og-image-size",
        status: "info",
        message: "No og:image tag found",
      });
      return { checks };
    }

    const imageUrl = ogImage.getAttribute("content");
    checks.push({
      name: "og-image-exists",
      status: "pass",
      message: "og:image is set",
      value: imageUrl?.substring(0, 60) || undefined,
    });

    // Check dimensions if provided
    const width = parseInt(ogImageWidth?.getAttribute("content") || "0", 10);
    const height = parseInt(ogImageHeight?.getAttribute("content") || "0", 10);

    // Always include which image we're talking about — a bare page-level
    // warning leaves the user hunting for the offending file
    const imageItem = imageUrl
      ? [{ id: imageUrl, label: `og:image: ${imageUrl}` }]
      : undefined;

    if (width > 0 && height > 0) {
      if (width >= 1200 && height >= 630) {
        checks.push({
          name: "og-image-size",
          status: "pass",
          message: "og:image dimensions meet recommendations",
          value: `${width}x${height}`,
          items: imageItem,
        });
      } else {
        checks.push({
          name: "og-image-size",
          status: "warn",
          message: `og:image may be too small (${width}x${height})`,
          value: `${width}x${height} (recommended: 1200x630)`,
          items: imageItem,
        });
      }
    } else {
      checks.push({
        name: "og-image-size",
        status: "info",
        message: "og:image dimensions not specified",
        value: "Add og:image:width and og:image:height",
        items: imageItem,
      });
    }

    return { checks };
  },
};
