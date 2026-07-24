// crawl/pdf-size - Checks linked PDF sizes against Googlebot limits

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { GOOGLEBOT_PDF_MAX_BYTES, GOOGLEBOT_PDF_WARN_BYTES } from "@squirrelscan/utils/constants";

export const optionsSchema = z.object({
  warn_bytes: z
    .number()
    .default(GOOGLEBOT_PDF_WARN_BYTES)
    .describe("Byte size to trigger warning"),
  error_bytes: z
    .number()
    .default(GOOGLEBOT_PDF_MAX_BYTES)
    .describe("Byte size to trigger error (Googlebot truncation limit)"),
});

export const pdfSizeRule: Rule = {
  meta: {
    id: "crawl/pdf-size",
    name: "PDF Size",
    description:
      "Checks linked PDF sizes against Googlebot 60MB truncation limit",
    solution:
      "Googlebot truncates PDFs at 60MB—content beyond that limit is ignored during indexing. Split large documents into smaller parts, compress images within PDFs, or add a noindex X-Robots-Tag header if the PDF doesn't need to appear in search results.",
    category: "crawl",
    scope: "site",
    severity: "error",
    weight: 4,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];
    const pdfSizes = ctx.site?.pdfSizes;

    if (!pdfSizes || pdfSizes.length === 0) {
      // No PDF data available — check if there are any PDF links at all
      const pages = ctx.site?.pages;
      if (!pages || pages.length === 0) {
        checks.push({
          name: "pdf-size",
          status: "skipped",
          message: "No pages crawled",
          skipReason: "No pages available",
        });
        return { checks };
      }

      // Check if any PDF links exist in the crawled pages
      let hasPdfLinks = false;
      const baseOrigin = ctx.site?.baseUrl
        ? new URL(ctx.site.baseUrl).origin
        : null;

      for (const page of pages) {
        for (const link of page.parsed.links) {
          if (!link.url) continue;
          if (!link.url.toLowerCase().endsWith(".pdf")) continue;
          try {
            const linkOrigin = new URL(link.url).origin;
            if (baseOrigin && linkOrigin === baseOrigin) {
              hasPdfLinks = true;
              break;
            }
          } catch {
            // Skip malformed URLs
          }
        }
        if (hasPdfLinks) break;
      }

      if (!hasPdfLinks) {
        checks.push({
          name: "pdf-size",
          status: "pass",
          message: "No internal PDF links found",
        });
      } else {
        checks.push({
          name: "pdf-size",
          status: "skipped",
          message: "PDF size data not available",
          skipReason: "Pre-fetched PDF size data not provided",
        });
      }
      return { checks };
    }

    // Consume pre-fetched PDF size data
    const errorPdfs: Array<{ url: string; bytes: number }> = [];
    const warnPdfs: Array<{ url: string; bytes: number }> = [];
    const fetchErrors: string[] = [];

    for (const pdf of pdfSizes) {
      if (pdf.error) {
        fetchErrors.push(pdf.url);
        continue;
      }
      if (pdf.sizeBytes == null) continue;

      if (pdf.sizeBytes >= opts.error_bytes) {
        errorPdfs.push({ url: pdf.url, bytes: pdf.sizeBytes });
      } else if (pdf.sizeBytes >= opts.warn_bytes) {
        warnPdfs.push({ url: pdf.url, bytes: pdf.sizeBytes });
      }
    }

    if (errorPdfs.length > 0) {
      checks.push({
        name: "pdf-size",
        status: "fail",
        message: `${errorPdfs.length} PDF(s) exceed Googlebot 60MB limit`,
        items: errorPdfs.map((p) => ({
          id: p.url,
          detail: `${(p.bytes / (1024 * 1024)).toFixed(1)}MB`,
        })),
      });
    }

    if (warnPdfs.length > 0) {
      checks.push({
        name: "pdf-size-warn",
        status: "warn",
        message: `${warnPdfs.length} PDF(s) exceed 30MB — approaching Googlebot 60MB limit`,
        items: warnPdfs.map((p) => ({
          id: p.url,
          detail: `${(p.bytes / (1024 * 1024)).toFixed(1)}MB`,
        })),
      });
    }

    if (errorPdfs.length === 0 && warnPdfs.length === 0) {
      checks.push({
        name: "pdf-size",
        status: "pass",
        message: `${pdfSizes.length} PDF(s) checked — all under 30MB`,
      });
    }

    if (fetchErrors.length > 0) {
      checks.push({
        name: "pdf-size-errors",
        status: "info",
        message: `Could not check ${fetchErrors.length} PDF(s)`,
        items: fetchErrors.map((url) => ({ id: url })),
      });
    }

    return { checks };
  },
};
