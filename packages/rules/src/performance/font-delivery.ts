// perf/font-delivery - Render-blocking third-party font CSS in the critical path

import { getHostname, querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

import { findCssImports } from "../shared/css-imports";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Hosted font-CSS providers whose stylesheet sits in the critical request chain.
const FONT_CSS_HOSTS = [
  "fonts.googleapis.com",
  "use.typekit.net",
  "p.typekit.net",
  "fast.fonts.net",
  "fast.fonts.com",
  "cloud.typography.com",
  "fonts.bunny.net",
  "use.fontawesome.com",
];

function isFontCssHost(url: string, base: string): boolean {
  let host: string | null;
  try {
    host = new URL(url, base).hostname.toLowerCase();
  } catch {
    host = getHostname(url);
  }
  if (!host) return false;
  return FONT_CSS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * An `@import`'s conditions without its `layer(...)` and `supports(...)` parts,
 * which name a cascade layer or a feature test, not a medium: `layer(print)` is
 * not print-only. One pass with a depth count, never a regex such as
 * `/layer\([^)]*\)/g`, which rescans to the end of an unclosed `layer(` at every
 * occurrence (quadratic on site-controlled CSS).
 */
export function mediaQueriesOf(conditions: string): string {
  let out = "";
  let i = 0;
  while (i < conditions.length) {
    const prev = conditions[i - 1];
    const atWord = prev === undefined || !/[-_a-z0-9]/.test(prev);
    const fn = atWord
      ? conditions.startsWith("layer(", i)
        ? 6
        : conditions.startsWith("supports(", i)
          ? 9
          : 0
      : 0;
    if (fn === 0) {
      out += conditions[i];
      i++;
      continue;
    }
    let depth = 1;
    i += fn;
    while (i < conditions.length && depth > 0) {
      if (conditions[i] === "(") depth++;
      else if (conditions[i] === ")") depth--;
      i++;
    }
    out += " ";
  }
  return out;
}

export const fontDeliveryRule: Rule = {
  meta: {
    id: "perf/font-delivery",
    name: "Font Delivery",
    description: "Flags render-blocking third-party font stylesheets in the critical request chain",
    solution:
      "A <link rel='stylesheet'> to a hosted font service (e.g. fonts.googleapis.com) blocks rendering and adds a cross-origin round-trip before any text can paint. Make font delivery non-blocking: 1) Self-host the font files and the @font-face CSS to remove the third-party request entirely. 2) If you keep the hosted CSS, preconnect to the font host and load the stylesheet asynchronously (media='print' onload=\"this.media='all'\"). 3) Use font-display: swap so fallback text shows immediately. 4) Subset the font to the characters you actually use to cut bytes.",
    category: "perf",
    scope: "page",
    verdictScope: "template",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const head = doc.querySelector("head");
    if (!head) {
      checks.push({
        name: "font-delivery",
        status: "info",
        message: "No <head> element found",
        details: { inconclusive: true },
      });
      return { checks };
    }

    const blocking: string[] = [];

    // Render-blocking font stylesheets: <link rel=stylesheet> to a font host that
    // is not deferred via media=print (the async-load trick) or rel=preload.
    // rel~= matches a whitespace-token list (e.g. rel="stylesheet preload").
    for (const link of querySelectorAllOutsideNoscript(head, 'link[rel~="stylesheet"]')) {
      const href = link.getAttribute("href");
      if (!href || !isFontCssHost(href, ctx.page.url)) continue;
      const media = link.getAttribute("media")?.toLowerCase();
      // media="print" (with or without an onload swap) does not block first paint.
      if (media === "print") continue;
      blocking.push(href);
    }

    // @import of a font provider inside inline <style> — blocking + extra round-trip.
    // Only the imports a browser fetches count: not one in a comment or a string,
    // nor one after another rule (#725). `media` is the trailing condition
    // (e.g. `... print;`).
    for (const style of querySelectorAllOutsideNoscript(doc, "style")) {
      for (const cssImport of findCssImports(style.textContent || "")) {
        const url = cssImport.url;
        const media = mediaQueriesOf(cssImport.media.toLowerCase());
        if (!isFontCssHost(url, ctx.page.url)) continue;
        // A print-only @import does not block screen render. `not print` DOES apply
        // to screen, so keep it; only skip a plain print (no not/screen/all).
        const printOnly =
          /\bprint\b/.test(media) && !/\bnot\b/.test(media) && !/\b(screen|all)\b/.test(media);
        if (printOnly) continue;
        blocking.push(`@import ${url}`);
      }
    }

    if (blocking.length > 0) {
      checks.push({
        name: "font-delivery",
        status: "warn",
        message: `${blocking.length} render-blocking third-party font stylesheet(s) in the critical path`,
        items: blocking.map((id) => ({ id })),
      });
    } else {
      checks.push({
        name: "font-delivery",
        status: "pass",
        message: "No render-blocking third-party font stylesheets",
      });
    }

    return { checks };
  },
};
