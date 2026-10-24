// social/og-image-size - Open Graph image size check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const SUPPORTED_IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "webp"]);
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function imageExtension(imageUrl: string, pageUrl: string): string | null {
  try {
    const pathname = new URL(imageUrl, pageUrl).pathname;
    const extension = pathname.match(/\.([a-z0-9]+)$/i)?.[1];
    return extension?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function imageFormatCheck(
  tag: "og:image" | "twitter:image",
  imageUrl: string,
  pageUrl: string,
  declaredType?: string | null,
): CheckResult | null {
  const extension = imageExtension(imageUrl, pageUrl);
  const contentType = declaredType?.split(";", 1)[0]?.trim().toLowerCase() || null;
  const checkName = tag === "og:image" ? "og-image-format" : "twitter-image-format";
  const imageItem = [{ id: imageUrl, label: `${tag}: ${imageUrl}` }];

  if (extension === "svg" || contentType === "image/svg+xml") {
    return {
      name: checkName,
      status: "warn",
      message: `${tag} uses SVG, which social preview clients may not render`,
      value: "Use a 1200x630 PNG or JPEG instead",
      items: imageItem,
    };
  }

  if (extension === "avif" || contentType === "image/avif") {
    return {
      name: checkName,
      status: "info",
      message: `${tag} uses AVIF, whose social preview support is inconsistent`,
      value: "Use a 1200x630 PNG or JPEG for the widest support",
      items: imageItem,
    };
  }

  if (
    (extension !== null && SUPPORTED_IMAGE_EXTENSIONS.has(extension)) ||
    (contentType !== null && SUPPORTED_IMAGE_TYPES.has(contentType))
  ) {
    return {
      name: checkName,
      status: "pass",
      message: `${tag} uses a broadly supported image format`,
      value: contentType ?? extension?.toUpperCase(),
      items: imageItem,
    };
  }

  return null;
}

export const ogImageSizeRule: Rule = {
  meta: {
    id: "social/og-image-size",
    name: "OG Image Size",
    description: "Checks social images use a supported format and recommended dimensions",
    solution:
      "Use a PNG or JPEG social image at least 1200x630 pixels for reliable display on Facebook and LinkedIn. SVG may not render, while smaller images may appear cropped or low quality. Use a 1.91:1 aspect ratio, keep the file under 8MB, and test with Facebook Sharing Debugger. Consider creating dedicated social images for key pages.",
    category: "social",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const ogImage = doc.querySelector('meta[property="og:image"]');
    const ogImageType = doc.querySelector('meta[property="og:image:type"]');
    const ogImageWidth = doc.querySelector('meta[property="og:image:width"]');
    const ogImageHeight = doc.querySelector('meta[property="og:image:height"]');
    const twitterImage = doc.querySelector(
      'meta[name="twitter:image"], meta[property="twitter:image"]',
    );

    if (!ogImage) {
      checks.push({
        name: "og-image-size",
        status: "info",
        message: "No og:image tag found",
      });
    } else {
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

      if (imageUrl) {
        const format = imageFormatCheck(
          "og:image",
          imageUrl,
          ctx.page.url,
          ogImageType?.getAttribute("content"),
        );
        if (format) checks.push(format);
      }
    }

    const twitterImageUrl = twitterImage?.getAttribute("content");
    if (twitterImageUrl) {
      const format = imageFormatCheck("twitter:image", twitterImageUrl, ctx.page.url);
      if (format) checks.push(format);
    }

    return { checks };
  },
};
