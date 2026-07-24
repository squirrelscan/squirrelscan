// perf/js-file-size - Detect oversized JavaScript files

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
    .default(RESOURCE_SIZE_LIMITS.JS_WARN_BYTES)
    .describe("Byte size to trigger warning"),
  error_bytes: z
    .number()
    .default(RESOURCE_SIZE_LIMITS.JS_ERROR_BYTES)
    .describe("Byte size to trigger error"),
});

export const jsFileSizeRule: Rule = {
  meta: {
    id: "perf/js-file-size",
    name: "JavaScript File Size Too Large",
    description:
      "Checks for JavaScript files that exceed recommended size limits",
    solution:
      "Large JavaScript files block the main thread and delay interactivity. Code-split bundles into smaller chunks, tree-shake unused exports, lazy-load non-critical scripts, and defer or async load third-party scripts. Use dynamic imports for route-based splitting.",
    category: "perf",
    scope: "site",
    severity: "error",
    weight: 7,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];
    const scripts = ctx.site?.scripts ?? [];

    if (scripts.length === 0) {
      checks.push({
        name: "js-file-size",
        status: "pass",
        message: "No JavaScript files detected",
      });
      return { checks };
    }

    const errorFiles = scripts.filter(
      (s) => s.sizeBytes !== null && s.sizeBytes > opts.error_bytes
    );
    const warnFiles = scripts.filter(
      (s) =>
        s.sizeBytes !== null &&
        s.sizeBytes > opts.warn_bytes &&
        s.sizeBytes <= opts.error_bytes
    );

    if (errorFiles.length > 0) {
      checks.push({
        name: "js-file-size",
        status: "fail",
        message: `${errorFiles.length} JS file(s) exceed ${formatBytes(opts.error_bytes)}`,
        items: errorFiles.map((script) => ({
          id: script.url,
          sourcePages: script.sourcePages,
          meta: {
            sizeBytes: script.sizeBytes,
            size: formatBytes(script.sizeBytes ?? 0),
            status: script.status ?? undefined,
            contentType: script.contentType ?? undefined,
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
        name: "js-file-size-warn",
        status: "warn",
        message: `${warnFiles.length} JS file(s) exceed ${formatBytes(opts.warn_bytes)}`,
        items: warnFiles.map((script) => ({
          id: script.url,
          sourcePages: script.sourcePages,
          meta: {
            sizeBytes: script.sizeBytes,
            size: formatBytes(script.sizeBytes ?? 0),
            status: script.status ?? undefined,
            contentType: script.contentType ?? undefined,
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
        name: "js-file-size",
        status: "pass",
        message: "All JavaScript files are within size limits",
      });
    }

    return { checks };
  },
};
