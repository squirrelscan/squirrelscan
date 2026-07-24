// perf/carousel-hidden-eager - Eagerly-loaded images inside hidden carousel slides

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Strong carousel/slider evidence: a known framework, or a "carousel"/"slideshow"
// container class. Deliberately NOT bare "slide"/"slider" tokens — those match
// unrelated UI (e.g. `slide-in` animations, off-canvas sliders) and over-flag.
const CAROUSEL_CLASS_RE =
  /swiper|splide|glide__|glide--|slick|flickity|embla__|keen-slider|owl-carousel|tns-|\bcarousel\b|\bslideshow\b/;

const MAX_ANCESTOR_DEPTH = 8;

function isHidden(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (el.hasAttribute("hidden")) return true;
  const style = (el.getAttribute("style") || "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

export const carouselHiddenEagerRule: Rule = {
  meta: {
    id: "perf/carousel-hidden-eager",
    name: "Carousel Hidden Eager Images",
    description: "Flags eagerly-loaded images inside hidden carousel slides (wasted bandwidth)",
    solution:
      "Images inside inactive/hidden carousel slides are still downloaded when loaded eagerly, wasting bandwidth and competing with above-fold resources: hiding a slide with display:none or aria-hidden does not stop the fetch. Add loading='lazy' to images in off-screen carousel slides so the browser defers them until the slide is shown. Keep the first (visible) slide eager so it is not delayed.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const flagged: string[] = [];

    for (const img of doc.querySelectorAll("img")) {
      // Inverse of the lazy-above-fold rules: only EAGER (non-lazy) images.
      if (img.getAttribute("loading") === "lazy") continue;
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) continue;

      // Walk ancestors: require BOTH a carousel/slider container in the chain AND
      // a hidden ancestor (the inactive slide). Requiring the carousel signal
      // avoids flagging generic hidden UI (tabs, off-canvas panels, animations).
      let el: Element | null = img.parentElement;
      let inCarousel = false;
      let hidden = false;
      let depth = 0;
      while (el && depth < MAX_ANCESTOR_DEPTH) {
        const cls = (el.getAttribute("class") || "").toLowerCase();
        if (cls && CAROUSEL_CLASS_RE.test(cls)) inCarousel = true;
        if (isHidden(el)) hidden = true;
        if (inCarousel && hidden) break;
        el = el.parentElement;
        depth++;
      }

      if (inCarousel && hidden) {
        flagged.push(src);
      }
    }

    if (flagged.length > 0) {
      checks.push({
        name: "carousel-hidden-eager",
        status: "warn",
        message: `${flagged.length} eagerly-loaded image(s) inside hidden carousel slides`,
        items: flagged.slice(0, 10).map((id) => ({ id })),
        details: flagged.length > 10 ? { additional: flagged.length - 10 } : undefined,
      });
    } else {
      checks.push({
        name: "carousel-hidden-eager",
        status: "pass",
        message: "No eager images in hidden carousel slides",
      });
    }

    return { checks };
  },
};
