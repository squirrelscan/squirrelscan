// crawl/html-size - Checks HTML document size against Googlebot limits

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import {
  GOOGLEBOT_HTML_MAX_BYTES,
  GOOGLEBOT_HTML_WARN_BYTES,
} from "@squirrelscan/utils/constants";

export const optionsSchema = z.object({
  warn_bytes: z
    .number()
    .default(GOOGLEBOT_HTML_WARN_BYTES)
    .describe("Byte size to trigger warning"),
  error_bytes: z
    .number()
    .default(GOOGLEBOT_HTML_MAX_BYTES)
    .describe("Byte size to trigger error (Googlebot truncation limit)"),
});

export const htmlSizeRule: Rule = {
  meta: {
    id: "crawl/html-size",
    name: "HTML Size",
    description: "Checks HTML document size against Googlebot crawl limits",
    solution:
      "Googlebot truncates HTML documents at 2MB—content beyond that limit is silently ignored during indexing. Move inline styles and scripts to external files, defer non-critical content, lazy-load below-the-fold sections, and remove unnecessary markup. Keep critical SEO content (title, meta, headings, main body) near the top of the document so it's indexed even if truncation occurs.",
    category: "crawl",
    scope: "page",
    severity: "error",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];
    const bytes = Buffer.byteLength(ctx.page.html, "utf-8");
    const kb = Math.round(bytes / 1024);
    const mb = (bytes / (1024 * 1024)).toFixed(1);

    if (bytes >= opts.error_bytes) {
      checks.push({
        name: "html-size",
        status: "fail",
        message: `HTML is ${mb}MB — exceeds Googlebot 2MB limit, content will be truncated`,
        value: bytes,
        expected: opts.error_bytes,
      });
    } else if (bytes >= opts.warn_bytes) {
      checks.push({
        name: "html-size",
        status: "warn",
        message: `HTML is ${kb}KB — approaching Googlebot 2MB limit`,
        value: bytes,
        expected: opts.error_bytes,
      });
    } else {
      checks.push({
        name: "html-size",
        status: "pass",
        message: `HTML size OK: ${kb}KB`,
        value: bytes,
      });
    }

    return { checks };
  },
};
