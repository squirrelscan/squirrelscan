// integrity/template-discontinuity — flag pages whose template fingerprint
// diverges hard from the site's dominant theme cluster (the kit page had ZERO
// theme markup on an otherwise themed WP site).
//
// Site-scope. Builds a baseline from the majority theme cluster, then scores each
// page's similarity. Pages far below threshold are flagged. A page that ALSO
// carries page-level integrity signals (brand/obfuscation/overlay/doorway) is
// escalated to `fail`; a lone template outlier is `info` (could be a legitimate
// off-theme landing page).

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname } from "@squirrelscan/utils";

import {
  buildBaseline,
  fingerprintPage,
  similarityToBaseline,
  type PageFingerprint,
} from "./fingerprint";
import { detectPageSignals } from "./signals";

export const templateDiscontinuityRule: Rule = {
  meta: {
    id: "integrity/template-discontinuity",
    name: "Template Discontinuity",
    description:
      "Detects pages whose markup diverges hard from the site's common template — a standalone page with none of the site's theme is a classic injected-page signal",
    solution:
      "A page that shares almost none of your site's theme (no shared stylesheets, asset hosts, nav/footer, or CSS variables) may be an injected standalone page rather than something your CMS produced. Confirm the page is one you created; if not, treat the site as compromised: remove the page, audit recently modified files, and check server access logs. Legitimate off-theme landing pages should still load your shared assets.",
    category: "integrity",
    scope: "site",
    severity: "warning",
    weight: 6,
    optionsSchema: z.object({
      minPages: z
        .number()
        .int()
        .min(3)
        .default(4)
        .describe("Minimum pages needed to establish a reliable baseline"),
      similarityThreshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.2)
        .describe("Pages below this similarity to the baseline are flagged"),
    }),
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages ?? [];
    const minPages = ctx.options.minPages as number;
    const threshold = ctx.options.similarityThreshold as number;

    if (pages.length < minPages) {
      checks.push({
        name: "template-discontinuity",
        status: "skipped",
        message: `Need >=${minPages} pages to establish a template baseline`,
        skipReason: "Insufficient pages for baseline",
      });
      return { checks };
    }

    // Fingerprint every page with a parseable document. Streaming (#1021): the
    // per-page fingerprint was captured at page-time — read it; else fingerprint
    // each live document (v1). fingerprintPage is shared, so entries match exactly.
    const collected = ctx.collectedSignals;
    const entries: { url: string; fp: PageFingerprint }[] = [];
    if (collected) {
      for (const rec of collected.pages) {
        if (rec.fingerprint) entries.push({ url: rec.url, fp: rec.fingerprint });
      }
    } else {
      for (const page of pages) {
        const fp = fingerprintPage(page.parsed, page.url);
        if (fp) entries.push({ url: page.url, fp });
      }
    }

    if (entries.length < minPages) {
      checks.push({
        name: "template-discontinuity",
        status: "skipped",
        message: "Too few parseable pages for a template baseline",
        skipReason: "Insufficient parseable pages",
      });
      return { checks };
    }

    const baseline = buildBaseline(entries.map((e) => e.fp));

    // If the baseline itself is empty (no shared theme markers — e.g. a site of
    // wholly unrelated pages), we can't reliably call anything an outlier.
    const baselineEmpty =
      baseline.stylesheetHrefs.size === 0 && baseline.assetHosts.size === 0;
    if (baselineEmpty) {
      checks.push({
        name: "template-discontinuity",
        status: "skipped",
        message: "No shared template baseline detected across the site",
        skipReason: "No shared theme markers",
      });
      return { checks };
    }

    const outliers: {
      url: string;
      similarity: number;
      escalated: boolean;
    }[] = [];

    // Per-page integrity-signal count for escalation. Streaming: read the signals
    // captured at page-time; v1: detect them on demand for each outlier.
    const signalCountByUrl = collected
      ? new Map(collected.pages.map((r) => [r.url, r.signals.length]))
      : null;

    for (const { url, fp } of entries) {
      const similarity = similarityToBaseline(fp, baseline);
      if (similarity >= threshold) continue;

      let signalCount: number;
      if (signalCountByUrl) {
        signalCount = signalCountByUrl.get(url) ?? 0;
      } else {
        // Correlate: does this divergent page also carry page-level integrity
        // signals? Build a minimal page ctx for the signal detectors. `html: ""` is
        // intentional — the detectors read parsed.document/parsed.content, not
        // page.html (see orphan-page.ts for the same note).
        const page = pages.find((p) => p.url === url)!;
        const pageCtx: RuleContext = {
          page: {
            url: page.url,
            finalUrl: page.finalUrl,
            html: "",
            statusCode: page.statusCode,
            loadTime: 0,
            headers: page.headers ?? {},
            parsed: page.parsed,
          },
          parsed: page.parsed,
          site: ctx.site,
          siteMetadata: ctx.siteMetadata,
          options: {},
        };
        signalCount = detectPageSignals(pageCtx).size;
      }
      outliers.push({
        url,
        similarity: Math.round(similarity * 100) / 100,
        escalated: signalCount >= 1, // template-discontinuity + >=1 page signal
      });
    }

    if (outliers.length === 0) {
      checks.push({
        name: "template-discontinuity",
        status: "pass",
        message: "All pages share the site's common template",
      });
      return { checks };
    }

    // Split escalated (off-template AND carrying page-level compromise signals →
    // `fail`) from review-only outliers (off-template alone → `info`). Never mix
    // a non-escalated page into a high-severity finding (correlation gating).
    const escalated = outliers.filter((o) => o.escalated);
    const reviewOnly = outliers.filter((o) => !o.escalated);
    const fmt = (o: { url: string; similarity: number }) =>
      `${getPathname(o.url)} (sim ${o.similarity})`;
    const listOf = (items: typeof outliers) =>
      items.slice(0, 5).map(fmt).join("\n") +
      (items.length > 5 ? `\n+${items.length - 5} more` : "");

    if (escalated.length > 0) {
      checks.push({
        name: "template-discontinuity",
        status: "fail",
        message: `${escalated.length} off-template page(s) carrying compromise signals — likely injected`,
        value: listOf(escalated),
        items: escalated.map((o) => ({ id: o.url })),
        details: {
          total: escalated.length,
          baselinePages: baseline.pageCount,
          threshold,
          escalated: true,
          outliers: escalated,
        },
      });
    }

    if (reviewOnly.length > 0) {
      checks.push({
        name: "template-discontinuity-review",
        status: "info",
        message: `${reviewOnly.length} page(s) diverge from the site template (review)`,
        value: listOf(reviewOnly),
        items: reviewOnly.map((o) => ({ id: o.url })),
        details: {
          total: reviewOnly.length,
          baselinePages: baseline.pageCount,
          threshold,
          escalated: false,
          outliers: reviewOnly,
        },
      });
    }

    return { checks };
  },
};
