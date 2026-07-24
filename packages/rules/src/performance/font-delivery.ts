// perf/font-delivery - Render-blocking third-party font CSS in the critical path

import { getHostname } from "@squirrelscan/utils";

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

export const fontDeliveryRule: Rule = {
  meta: {
    id: "perf/font-delivery",
    name: "Font Delivery",
    description: "Flags render-blocking third-party font stylesheets in the critical request chain",
    solution:
      "A <link rel='stylesheet'> to a hosted font service (e.g. fonts.googleapis.com) blocks rendering and adds a cross-origin round-trip before any text can paint. Make font delivery non-blocking: 1) Self-host the font files and the @font-face CSS to remove the third-party request entirely. 2) If you keep the hosted CSS, preconnect to the font host and load the stylesheet asynchronously (media='print' onload=\"this.media='all'\"). 3) Use font-display: swap so fallback text shows immediately. 4) Subset the font to the characters you actually use to cut bytes.",
    category: "perf",
    scope: "page",
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
      });
      return { checks };
    }

    const blocking: string[] = [];

    // Render-blocking font stylesheets: <link rel=stylesheet> to a font host that
    // is not deferred via media=print (the async-load trick) or rel=preload.
    // rel~= matches a whitespace-token list (e.g. rel="stylesheet preload").
    for (const link of head.querySelectorAll('link[rel~="stylesheet"]')) {
      const href = link.getAttribute("href");
      if (!href || !isFontCssHost(href, ctx.page.url)) continue;
      const media = link.getAttribute("media")?.toLowerCase();
      // media="print" (with or without an onload swap) does not block first paint.
      if (media === "print") continue;
      blocking.push(href);
    }

    // @import of a font provider inside inline <style> — blocking + extra round-trip.
    // Capture the URL and the trailing media condition (e.g. `... print;`).
    for (const style of doc.querySelectorAll("style")) {
      const content = style.textContent || "";
      const importRe = /@import\s+(?:url\()?\s*['"]?([^'")\s]+)['"]?\)?([^;]*);?/gi;
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(content)) !== null) {
        const url = match[1];
        const media = (match[2] || "").toLowerCase();
        if (!url || !isFontCssHost(url, ctx.page.url)) continue;
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
