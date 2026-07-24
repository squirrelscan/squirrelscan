// images/optimized - Image compression analysis

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Known image CDN domains that typically serve optimized images
const imageCdnDomains = [
  "cloudinary.com",
  "imgix.net",
  "images.unsplash.com",
  "images.pexels.com",
  "cdn.shopify.com",
  "res.cloudinary.com",
  "imagekit.io",
  "twimg.com",
  "fbcdn.net",
  "googleusercontent.com",
  "cloudflare-ipfs.com",
  "cdn.sanity.io",
  "media.graphassets.com",
  "storyblok.com",
  "prismic.io",
  "contentful.com",
  "wp.com/cdn",
  "statically.io",
  "imagedelivery.net",
];

function isFromImageCdn(src: string): boolean {
  try {
    const hostname = new URL(src, "https://example.com").hostname;
    return imageCdnDomains.some((cdn) => hostname.includes(cdn));
  } catch {
    return false;
  }
}

export const optimizedRule: Rule = {
  meta: {
    id: "images/optimized",
    name: "Image Optimization",
    description: "Checks for image optimization indicators",
    solution:
      "Optimize images to reduce file sizes without visible quality loss. Use tools like Squoosh, ImageOptim, or TinyPNG. Consider using an image CDN (Cloudinary, Imgix, Cloudflare Images) for automatic optimization and responsive delivery. Modern formats (WebP, AVIF) offer 25-50% better compression.",
    category: "images",
    scope: "page",
    severity: "info",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];

    const images = doc.querySelectorAll("img[src]");

    if (images.length === 0) {
      checks.push({
        name: "image-optimization",
        status: "info",
        message: "No images found",
      });
      return { checks };
    }

    let fromCdn = 0;
    let modernFormat = 0;
    let legacyFormat = 0;

    const legacyImages: string[] = [];

    for (const img of images) {
      const src = img.getAttribute("src") || "";

      // Skip data URIs
      if (src.startsWith("data:")) continue;

      // Check if from image CDN
      if (isFromImageCdn(src)) {
        fromCdn++;
      }

      // Check format
      const srcLower = src.toLowerCase();
      const filename = src.split("/").pop()?.split("?")[0] || "";
      const ext = filename.split(".").pop()?.toLowerCase();

      if (
        ext === "webp" ||
        ext === "avif" ||
        srcLower.includes("format=webp") ||
        srcLower.includes("fm=webp") ||
        srcLower.includes("f_webp") ||
        srcLower.includes("format=avif")
      ) {
        modernFormat++;
      } else if (
        ext === "jpg" ||
        ext === "jpeg" ||
        ext === "png" ||
        ext === "gif"
      ) {
        legacyFormat++;
        if (!isFromImageCdn(src)) {
          legacyImages.push(filename);
        }
      } else if (ext === "svg" || ext === "ico") {
        // SVG and ICO don't need modern format conversion
        modernFormat++;
      }
    }

    // Report findings
    if (fromCdn > 0) {
      checks.push({
        name: "image-cdn",
        status: "pass",
        message: `${fromCdn} image(s) served from image CDN`,
        details: { note: "Image CDNs typically auto-optimize" },
      });
    }

    if (modernFormat > 0) {
      checks.push({
        name: "modern-image-formats",
        status: "pass",
        message: `${modernFormat} image(s) use modern formats`,
      });
    }

    if (legacyImages.length > 0) {
      checks.push({
        name: "legacy-image-formats",
        status: "info",
        message: `${legacyImages.length} image(s) could use WebP/AVIF`,
        items: legacyImages.slice(0, 10).map((id) => ({ id })),
        details: {
          note: "Convert JPG/PNG to WebP for 25-35% smaller files",
          ...(legacyImages.length > 10
            ? { additional: legacyImages.length - 10 }
            : {}),
        },
      });
    }

    // Picture element check (responsive images)
    const pictureElements = doc.querySelectorAll("picture");
    if (pictureElements.length > 0) {
      checks.push({
        name: "picture-elements",
        status: "pass",
        message: `${pictureElements.length} <picture> element(s) for responsive images`,
      });
    }

    if (fromCdn === 0 && modernFormat === 0 && legacyFormat > 3) {
      checks.push({
        name: "image-optimization-needed",
        status: "warn",
        message: "Images may not be optimized - consider using an image CDN",
        details: {
          suggestion: "Cloudinary, Imgix, or Cloudflare Images",
        },
      });
    }

    return { checks };
  },
};
