// perf/lcp-fetchpriority - LCP candidate eagerly loaded without fetchpriority or preload

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Skip obvious non-LCP raster candidates (tracking pixels, spacers).
const NON_CONTENT_SRC = /pixel|spacer|blank|1x1|tracking/i;

// Below this (when BOTH dims are declared) the image is too small to be the LCP.
const MIN_HERO_DIMENSION = 300;

function isSmallDeclared(width: string | null, height: string | null): boolean {
  const w = width ? Number.parseInt(width, 10) : Number.NaN;
  const h = height ? Number.parseInt(height, 10) : Number.NaN;
  // Only judge when both dimensions are declared; undimensioned heroes stay eligible.
  if (Number.isNaN(w) || Number.isNaN(h)) return false;
  return Math.max(w, h) < MIN_HERO_DIMENSION;
}

// Absolute URL for src/preload comparison; null when unparseable.
function absUrl(value: string, base: string): string | null {
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

// Absolute URLs from a srcset / imagesrcset attribute (drops the descriptors).
function srcsetUrls(value: string | null, base: string): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(",")) {
    const url = part.trim().split(/\s+/)[0];
    if (!url) continue;
    const abs = absUrl(url, base);
    if (abs) out.push(abs);
  }
  return out;
}

export const lcpFetchpriorityRule: Rule = {
  meta: {
    id: "perf/lcp-fetchpriority",
    name: "LCP Image Fetch Priority",
    description:
      "Flags the hero/LCP image when it is eagerly loaded but has neither fetchpriority='high' nor a preload",
    solution:
      "The Largest Contentful Paint image should be discovered and fetched as early as possible. When the hero image is loaded eagerly but left at default priority, the browser races it against other resources and LCP suffers. Add fetchpriority='high' to the LCP <img> so the browser prioritises it, or preload it with <link rel='preload' as='image' href='...' fetchpriority='high'>. Either signal is enough; you do not need both. Only apply this to the single above-fold LCP image, never to below-fold images.",
    category: "perf",
    scope: "page",
    severity: "warning",
    // Low weight on purpose: lcp-hints (weight 7) already penalizes the
    // no-preload case, so this rule adds the fetchpriority nudge without
    // double-charging the same root cause (PR #710 review).
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Collect image preloads (href + responsive imagesrcset) to match against the candidate.
    const preloadImageUrls = new Set<string>();
    for (const link of doc.querySelectorAll('link[rel~="preload"][as="image"]')) {
      const href = link.getAttribute("href");
      if (href) {
        const abs = absUrl(href, ctx.page.url);
        if (abs) preloadImageUrls.add(abs);
      }
      for (const url of srcsetUrls(link.getAttribute("imagesrcset"), ctx.page.url)) {
        preloadImageUrls.add(url);
      }
    }

    // Find the LCP candidate: first eager (non-lazy) content image, excluding
    // site chrome (header/nav logos), icons, SVGs, data URIs and small images.
    let candidate: Element | null = null;
    for (const img of doc.querySelectorAll("img")) {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) continue;
      if (NON_CONTENT_SRC.test(src)) continue;
      const lower = src.toLowerCase().split("?")[0] ?? src;
      if (lower.endsWith(".svg") || lower.endsWith(".ico")) continue;
      if (img.getAttribute("loading") === "lazy") continue;
      if (isSmallDeclared(img.getAttribute("width"), img.getAttribute("height"))) continue;
      // Skip logos inside header/nav — rarely the LCP element.
      if (img.closest("header, nav")) continue;
      candidate = img;
      break;
    }

    if (!candidate) {
      checks.push({
        name: "lcp-fetchpriority",
        status: "info",
        message: "No eager hero image candidate found",
      });
      return { checks };
    }

    const src = candidate.getAttribute("src") ?? "";
    const fetchpriority = candidate.getAttribute("fetchpriority");
    const hasHighPriority = fetchpriority === "high";

    // Preloaded? Match the candidate's src OR any of its srcset URLs against the
    // recorded image-preload URLs (a responsive hero preloads a srcset variant).
    const candidateUrls = new Set<string>();
    const absSrc = absUrl(src, ctx.page.url);
    if (absSrc) candidateUrls.add(absSrc);
    for (const url of srcsetUrls(candidate.getAttribute("srcset"), ctx.page.url)) {
      candidateUrls.add(url);
    }
    // URL-matched only — an unmatched preload elsewhere on the page is no
    // evidence THIS image is handled (PR #710 review).
    const isPreloaded = [...candidateUrls].some((u) => preloadImageUrls.has(u));

    if (hasHighPriority || isPreloaded) {
      checks.push({
        name: "lcp-fetchpriority",
        status: "pass",
        message: hasHighPriority
          ? "Hero image has fetchpriority='high'"
          : "Hero image is preloaded",
      });
      return { checks };
    }

    const filename = src.split("/").pop()?.split("?")[0] || src;
    checks.push({
      name: "lcp-fetchpriority",
      status: "warn",
      message: "Hero/LCP image loaded eagerly without fetchpriority='high' or preload",
      items: [
        {
          id: src,
          label: filename,
          snippet: `<img src="${src}"${fetchpriority ? ` fetchpriority="${fetchpriority}"` : ""}>`,
        },
      ],
    });
    return { checks };
  },
};
