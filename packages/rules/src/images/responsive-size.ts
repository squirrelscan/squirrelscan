// images/responsive-size - Check image sizing vs display size

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  max_thumbnail_dimension: z
    .number()
    .default(100)
    .describe("Max dimension to consider as thumbnail"),
});

export const responsiveSizeRule: Rule = {
  meta: {
    id: "images/responsive-size",
    name: "Responsive Image Size",
    description:
      "Checks if images are sized appropriately for their display size",
    solution:
      "Serve images at appropriate sizes for their display dimensions. Oversized images waste bandwidth and slow page load. Undersized images look blurry on high-DPI displays. Use srcset to serve different sizes for different screens. For responsive images, serve 1x, 2x, and optionally 3x versions. Image CDNs can automatically resize images on-the-fly.",
    category: "images",
    scope: "page",
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;

    if (!doc) {
      checks.push({
        name: "responsive-size",
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    const images = doc.querySelectorAll("img[src]");

    if (images.length === 0) {
      checks.push({
        name: "responsive-size",
        status: "info",
        message: "No images found on page",
      });
      return { checks };
    }

    const potentiallyOversizedImages: string[] = [];
    let imagesWithSizeInfo = 0;

    for (const img of images) {
      const width = img.getAttribute("width");
      const height = img.getAttribute("height");

      if (!width || !height) continue;

      // Parse dimensions
      const displayWidth = Number.parseInt(String(width), 10);
      const displayHeight = Number.parseInt(String(height), 10);

      if (Number.isNaN(displayWidth) || Number.isNaN(displayHeight)) continue;
      if (displayWidth === 0 || displayHeight === 0) continue;

      imagesWithSizeInfo++;

      // Check for small display sizes (thumbnails) without srcset
      const isThumbnailSize =
        displayWidth <= opts.max_thumbnail_dimension &&
        displayHeight <= opts.max_thumbnail_dimension;

      const hasSrcset = img.hasAttribute("srcset");
      const isInPicture = img.closest("picture") !== null;

      // Small images without responsive features might be serving oversized files
      if (isThumbnailSize && !hasSrcset && !isInPicture) {
        const src = img.getAttribute("src") || "";
        const filename = src.split("/").pop()?.split("?")[0] || src;

        // Skip SVGs, icons, and data URIs
        if (
          !filename.endsWith(".svg") &&
          !filename.endsWith(".ico") &&
          !src.startsWith("data:")
        ) {
          potentiallyOversizedImages.push(
            `${filename} (${displayWidth}x${displayHeight}, no srcset)`
          );
        }
      }
    }

    // Report findings
    if (potentiallyOversizedImages.length > 0) {
      checks.push({
        name: "images-possibly-oversized",
        status: "warn",
        message: `${potentiallyOversizedImages.length} small image(s) may be serving oversized files`,
        items: potentiallyOversizedImages.slice(0, 10).map((id) => ({ id })),
        details:
          potentiallyOversizedImages.length > 10
            ? { additional: potentiallyOversizedImages.length - 10 }
            : undefined,
      });
    } else if (imagesWithSizeInfo > 0) {
      checks.push({
        name: "responsive-size",
        status: "pass",
        message: "Image sizes appear appropriate",
        details: { imagesChecked: imagesWithSizeInfo },
      });
    } else {
      checks.push({
        name: "responsive-size",
        status: "info",
        message: "No images with explicit dimensions to check",
      });
    }

    return { checks };
  },
};
