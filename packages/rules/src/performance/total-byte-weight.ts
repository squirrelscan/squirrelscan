// performance/total-byte-weight - Total page weight check
// Aligns with Lighthouse total-byte-weight audit

import { z } from "zod";

import type {
  CheckResult,
  ParsedPage,
  Rule,
  RuleContext,
  RuleResult,
} from "../types";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

/**
 * Per-page byte-weight signal read off a live DOM (#1021 E-E2). Shared by the
 * page-time collector (buildCollectedPageSignal) and this rule's legacy
 * `site.pages` fallback so both produce byte-identical sums. `inlineCssLen` /
 * `inlineJsLen` feed the total; the external `*Count`s feed the no-resource-data
 * estimate branch (used only for the first page).
 */
export function extractPageByteSignal(
  doc: NonNullable<ParsedPage["document"]>,
): {
  inlineCssLen: number;
  inlineJsLen: number;
  externalCssCount: number;
  externalJsCount: number;
  imageCount: number;
} {
  let inlineCssLen = 0;
  for (const style of querySelectorAllOutsideNoscript(doc, "style")) {
    inlineCssLen += (style.textContent || "").length;
  }

  let inlineJsLen = 0;
  for (const script of querySelectorAllOutsideNoscript(
    doc,
    "script:not([src])",
  )) {
    // Skip JSON-LD and other data scripts
    const type = script.getAttribute("type") || "";
    if (!type.includes("json") && !type.includes("template")) {
      inlineJsLen += (script.textContent || "").length;
    }
  }

  return {
    inlineCssLen,
    inlineJsLen,
    externalCssCount: querySelectorAllOutsideNoscript(
      doc,
      'link[rel="stylesheet"]',
    ).length,
    externalJsCount: querySelectorAllOutsideNoscript(doc, "script[src]").length,
    imageCount: querySelectorAllOutsideNoscript(doc, "img[src]").length,
  };
}

export const optionsSchema = z.object({
  warn_threshold_kb: z
    .number()
    .default(1600)
    .describe("Warning threshold for total page weight in KB"),
  error_threshold_kb: z
    .number()
    .default(5000)
    .describe("Error threshold for total page weight in KB"),
});

export const totalByteWeightRule: Rule = {
  meta: {
    id: "perf/total-byte-weight",
    name: "Total Page Weight",
    description: "Checks the byte weight of each page",
    solution:
      "Reduce total page weight for faster loads on slow connections. Optimize images (use modern formats, compress, serve appropriate sizes). Minify and compress CSS/JS. Remove unused code via tree-shaking. Lazy-load non-critical resources. Target under 1.6MB for mobile users.",
    category: "perf",
    scope: "site",
    severity: "warning",
    weight: 6,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];

    // Per-page own weight. The 1600 KB and 5000 KB thresholds describe one page
    // load, so each page is scored on its HTML plus the inline code and the
    // external resources it loads; nothing is summed across the site.
    const pages = ctx.site?.pages ?? [];
    const collected = ctx.collectedSignals;
    // The streaming engine scans each DOM at page-time (#1021); v1 scans the live
    // `site.pages` documents. Both produce the same per-page record.
    const records: PageWeight[] = collected
      ? collected.pages.map((rec) => ({
          url: rec.url,
          html: rec.htmlBytes ?? 0,
          inlineCss: rec.inlineCssLen,
          inlineJs: rec.inlineJsLen,
          externalCssCount: rec.externalCssCount,
          externalJsCount: rec.externalJsCount,
          imageCount: rec.imageCount,
        }))
      : pages.map((page) => {
          const s = page.parsed?.document
            ? extractPageByteSignal(page.parsed.document)
            : undefined;
          return {
            url: page.url,
            html: page.sizeBytes ?? 0,
            inlineCss: s?.inlineCssLen ?? 0,
            inlineJs: s?.inlineJsLen ?? 0,
            externalCssCount: s?.externalCssCount ?? 0,
            externalJsCount: s?.externalJsCount ?? 0,
            imageCount: s?.imageCount ?? 0,
          };
        });

    const byUrl = new Map<string, PageWeight>();
    for (const rec of records) byUrl.set(rec.url, rec);

    // Attribute each external resource to the pages that load it. A resource
    // shared by several pages counts toward each of them; keying by URL within a
    // page counts it once per page.
    const unsized = new Set<string>();
    const attribute = (
      kind: "css" | "js" | "images" | "fonts",
      list:
        | Array<{
            url: string;
            sizeBytes: number | null;
            sourcePages: string[];
          }>
        | undefined,
    ): void => {
      for (const res of list ?? []) {
        const size = res.sizeBytes;
        for (const pageUrl of new Set(res.sourcePages)) {
          const rec = byUrl.get(pageUrl);
          if (!rec) continue;
          const bucket = (rec.external ??= {
            css: new Map(),
            js: new Map(),
            images: new Map(),
            fonts: new Map(),
          })[kind];
          if (size === null || size === undefined) {
            unsized.add(res.url);
            bucket.set(res.url, 0);
          } else {
            bucket.set(res.url, size);
          }
        }
      }
    };
    attribute("css", ctx.site?.resourceSizes?.css);
    attribute("js", ctx.site?.scripts);
    attribute("images", ctx.site?.resourceSizes?.images);
    attribute("fonts", ctx.site?.resourceSizes?.fonts);

    const hasExternalResourceData =
      ctx.site?.resourceSizes || ctx.site?.scripts;
    const sumBucket = (m: Map<string, number> | undefined): number => {
      let n = 0;
      for (const v of m?.values() ?? []) n += v;
      return n;
    };

    interface Scored {
      rec: PageWeight;
      kb: number;
      parts: {
        html: number;
        css: number;
        js: number;
        images: number;
        fonts: number;
      };
    }
    const scored: Scored[] = records.map((rec, index) => {
      const parts = {
        html: rec.html,
        css: rec.inlineCss + sumBucket(rec.external?.css),
        js: rec.inlineJs + sumBucket(rec.external?.js),
        images: sumBucket(rec.external?.images),
        fonts: sumBucket(rec.external?.fonts),
      };
      let bytes =
        parts.html + parts.css + parts.js + parts.images + parts.fonts;
      // With no resource measurements at all, estimate the first page only.
      if (!hasExternalResourceData && index === 0) {
        bytes =
          rec.html +
          rec.inlineCss +
          rec.inlineJs +
          (rec.externalCssCount * 30 +
            rec.externalJsCount * 50 +
            rec.imageCount * 100) *
            1024;
      }
      return { rec, kb: bytes / 1024, parts };
    });

    const isEstimate = !hasExternalResourceData && scored.length > 0;
    const heaviest = scored.reduce<Scored | undefined>(
      (best, cur) => (!best || cur.kb > best.kb ? cur : best),
      undefined,
    );
    const overWarn = scored.filter(
      (s) => s.kb >= opts.warn_threshold_kb,
    ).length;
    const overError = scored.filter(
      (s) => s.kb >= opts.error_threshold_kb,
    ).length;
    const heaviestKb = heaviest?.kb ?? 0;

    const details: Record<string, string | number | boolean> = {
      pagesAnalyzed: scored.length,
      pagesOverWarn: overWarn,
      pagesOverError: overError,
    };
    if (heaviest) {
      details.heaviestPage = heaviest.rec.url;
      details.heaviestPageKb = `${heaviestKb.toFixed(0)}KB`;
      const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;
      if (heaviest.parts.html > 0) details.html = kb(heaviest.parts.html);
      if (heaviest.parts.css > 0) details.css = kb(heaviest.parts.css);
      if (heaviest.parts.js > 0) details.js = kb(heaviest.parts.js);
      if (heaviest.parts.images > 0) details.images = kb(heaviest.parts.images);
      if (heaviest.parts.fonts > 0) details.fonts = kb(heaviest.parts.fonts);
    }
    if (isEstimate) details.estimated = true;
    if (unsized.size > 0) details.unsizedResources = unsized.size;

    const label = isEstimate ? "Estimated heaviest page" : "Heaviest page";
    const where = heaviest
      ? `${heaviest.rec.url} ${heaviestKb.toFixed(0)}KB`
      : "no pages";
    const counts = `${overWarn} over ${opts.warn_threshold_kb}KB, ${overError} over ${opts.error_threshold_kb}KB`;
    const note =
      unsized.size > 0
        ? `; ${unsized.size} resource${unsized.size === 1 ? "" : "s"} could not be sized and ${unsized.size === 1 ? "is" : "are"} not counted`
        : "";
    const message = `${label}: ${where} (${counts})${note}`;
    const value = `${heaviestKb.toFixed(0)}KB`;

    if (heaviestKb < opts.warn_threshold_kb) {
      checks.push({
        name: "total-byte-weight",
        status: "pass",
        message,
        value,
        expected: `< ${opts.warn_threshold_kb}KB`,
        details,
      });
    } else if (heaviestKb < opts.error_threshold_kb) {
      checks.push({
        name: "total-byte-weight",
        status: "warn",
        message: `${message} (heavy page)`,
        value,
        expected: `< ${opts.warn_threshold_kb}KB`,
        details,
      });
    } else {
      checks.push({
        name: "total-byte-weight",
        status: "fail",
        message: `${message} (very heavy)`,
        value,
        expected: `< ${opts.error_threshold_kb}KB`,
        details,
      });
    }

    return { checks };
  },
};

interface PageWeight {
  url: string;
  html: number;
  inlineCss: number;
  inlineJs: number;
  externalCssCount: number;
  externalJsCount: number;
  imageCount: number;
  /** Resource URL to byte size, one map per kind, so a URL counts once per page. */
  external?: {
    css: Map<string, number>;
    js: Map<string, number>;
    images: Map<string, number>;
    fonts: Map<string, number>;
  };
}
