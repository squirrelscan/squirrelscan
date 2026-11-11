// images/image-file-size - Detect oversized image files

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult, CheckItem } from "../types";

import { RESOURCE_SIZE_LIMITS } from "@squirrelscan/utils/constants";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

// Pages named in an item's meta, so a format that prints no `sourcePages` still
// says where the file is embedded (#1753).
const MAX_PAGES_IN_META = 10;

interface SizedImage {
  url: string;
  sizeBytes: number | null;
  status?: number | null;
  contentType?: string | null;
  sourcePages: string[];
}

function sizedItem(resource: SizedImage): CheckItem {
  const pages = [...new Set(resource.sourcePages)];
  const size = formatBytes(resource.sizeBytes ?? 0);
  return {
    id: resource.url,
    // Said in the label too: the text and markdown formats print the label, not meta.
    label:
      pages.length > 0
        ? `${resource.url} (${size}, embedded on ${pages.length} page${pages.length === 1 ? "" : "s"})`
        : `${resource.url} (${size}, no crawled page recorded as embedding it)`,
    sourcePages: pages,
    meta: {
      sizeBytes: resource.sizeBytes,
      size,
      status: resource.status ?? undefined,
      contentType: resource.contentType ?? undefined,
      pageCount: pages.length,
      ...(pages.length > 0 ? { pages: pages.slice(0, MAX_PAGES_IN_META) } : {}),
      ...(pages.length > MAX_PAGES_IN_META ? { pagesNotListed: pages.length - MAX_PAGES_IN_META } : {}),
    },
  };
}

export const optionsSchema = z.object({
  warn_bytes: z
    .number()
    .default(RESOURCE_SIZE_LIMITS.IMAGE_WARN_BYTES)
    .describe("Byte size to trigger warning"),
  error_bytes: z
    .number()
    .default(RESOURCE_SIZE_LIMITS.IMAGE_ERROR_BYTES)
    .describe("Byte size to trigger error"),
});

export const imageFileSizeRule: Rule = {
  meta: {
    id: "images/image-file-size",
    name: "Image File Size Too Large",
    description: "Checks for image files that exceed recommended size limits",
    solution:
      "Large images slow down page loads and impact Core Web Vitals. Compress oversized images, use modern formats (WebP/AVIF), and resize images to the display dimensions. Consider responsive images with srcset to serve smaller files on mobile.",
    category: "images",
    scope: "site",
    severity: "error",
    weight: 7,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];
    // The file a browser downloads, not every file the markup names (#1251): an
    // <img src> that only sits behind a srcset whose selected candidate is
    // another file is measured for other rules but is not what visitors load.
    const resources = (ctx.site?.resourceSizes?.images ?? []).filter((r) => !r.fallbackOnly);

    if (resources.length === 0) {
      checks.push({
        name: "image-file-size",
        status: "pass",
        message: "No image files detected",
      });
      return { checks };
    }

    const errorFiles = resources.filter(
      (r) => r.sizeBytes !== null && r.sizeBytes > opts.error_bytes
    );
    const warnFiles = resources.filter(
      (r) =>
        r.sizeBytes !== null &&
        r.sizeBytes > opts.warn_bytes &&
        r.sizeBytes <= opts.error_bytes
    );

    if (errorFiles.length > 0) {
      checks.push({
        name: "image-file-size",
        status: "fail",
        message: `${errorFiles.length} image(s) exceed ${formatBytes(opts.error_bytes)}`,
        items: errorFiles.map(sizedItem),
        details: {
          thresholdBytes: opts.error_bytes,
          total: errorFiles.length,
        },
      });
    }

    if (warnFiles.length > 0) {
      checks.push({
        name: "image-file-size-warn",
        status: "warn",
        message: `${warnFiles.length} image(s) exceed ${formatBytes(opts.warn_bytes)}`,
        items: warnFiles.map(sizedItem),
        details: {
          thresholdBytes: opts.warn_bytes,
          total: warnFiles.length,
        },
      });
    }

    if (errorFiles.length === 0 && warnFiles.length === 0) {
      checks.push({
        name: "image-file-size",
        status: "pass",
        message: "All image files are within size limits",
      });
    }

    return { checks };
  },
};
