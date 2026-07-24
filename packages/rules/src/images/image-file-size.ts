// images/image-file-size - Detect oversized image files

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

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
    const resources = ctx.site?.resourceSizes?.images ?? [];

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
        items: errorFiles.map((resource) => ({
          id: resource.url,
          sourcePages: resource.sourcePages,
          meta: {
            sizeBytes: resource.sizeBytes,
            size: formatBytes(resource.sizeBytes ?? 0),
            status: resource.status ?? undefined,
            contentType: resource.contentType ?? undefined,
          },
        })),
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
        items: warnFiles.map((resource) => ({
          id: resource.url,
          sourcePages: resource.sourcePages,
          meta: {
            sizeBytes: resource.sizeBytes,
            size: formatBytes(resource.sizeBytes ?? 0),
            status: resource.status ?? undefined,
            contentType: resource.contentType ?? undefined,
          },
        })),
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
