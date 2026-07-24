// perf/lazy-above-fold - Detects lazy loading on above-fold images

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

// Ancestor is hidden from all users/AT — never an LCP candidate (#699).
const HIDDEN_ANCESTOR_SELECTOR = '[aria-hidden="true"], [hidden], [inert]';

function isHiddenViaAncestor(el: Element): boolean {
  if (el.closest(HIDDEN_ANCESTOR_SELECTOR)) return true;
  // Inline display:none can't be matched with an attribute selector (the
  // value varies), so walk ancestors manually for that one case.
  let node: Element | null = el;
  while (node) {
    const style = node.getAttribute("style");
    if (style && /display\s*:\s*none\b/i.test(style)) return true;
    node = node.parentElement;
  }
  return false;
}

// Common carousel/slider markup — the ARIA Authoring Practices "slide" role
// plus the major slider libraries' slide class conventions. Only the
// first/active slide is actually rendered above the fold; later slides sit
// off-screen until the user interacts (#699).
const SLIDE_SELECTOR = [
  '[aria-roledescription="slide"]',
  '[class*="carousel-item"]',
  '[class*="carousel-slide"]',
  '[class*="swiper-slide"]',
  '[class*="slick-slide"]',
  '[class*="splide__slide"]',
].join(", ");

// Explicit active-slide markers used by the major slider libraries. Trust
// these over DOM order — the active slide is NOT guaranteed to be the first
// sibling (#699 codex review: assuming "first = active" can silently skip a
// genuinely visible, lazy-loaded second/third slide).
const ACTIVE_SLIDE_SELECTOR = [
  ".active",
  ".is-active",
  ".swiper-slide-active",
  ".slick-active",
  ".splide__slide--active",
  '[aria-current="true"]',
].join(", ");

function isActiveSlideMarker(slide: Element): boolean {
  return slide.matches(ACTIVE_SLIDE_SELECTOR) || slide.getAttribute("aria-hidden") === "false";
}

function isInactiveCarouselSlide(el: Element): boolean {
  const slide = el.closest(SLIDE_SELECTOR);
  if (!slide) return false;
  const parent = slide.parentElement;
  if (!parent) return false;
  const slideSiblings = Array.from(parent.children).filter((sib) => sib.matches(SLIDE_SELECTOR));
  if (slideSiblings.length < 2) return false;

  const markedActive = slideSiblings.filter(isActiveSlideMarker);
  if (markedActive.length > 0) {
    // Trust the explicit state over DOM order.
    return !markedActive.includes(slide);
  }

  // No explicit active marker anywhere in the group — fall back to the
  // conservative "first slide is active" DOM-order heuristic.
  return slideSiblings[0] !== slide;
}

// A footer landmark is essentially never above the fold, regardless of how
// short the page is (#699 — a bottom CTA-band logo was flagged on a short
// page purely because DOM order put it within the first 3 images).
function isInsideFooter(el: Element): boolean {
  return el.closest("footer") !== null;
}

export const lazyAboveFoldRule: Rule = {
  meta: {
    id: "perf/lazy-above-fold",
    name: "Lazy Loading Above Fold",
    description: "Detects lazy loading on likely above-fold images",
    solution:
      "Don't use loading='lazy' on images that appear above the fold (visible without scrolling). Lazy loading these images delays LCP because the browser waits for layout before fetching. For hero images and LCP candidates: 1) Remove loading='lazy'. 2) Add fetchpriority='high'. 3) Consider preloading with <link rel='preload' as='image'>. Only use lazy loading for below-fold images.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Get first few images - likely above fold candidates
    const allImages = doc.querySelectorAll("img");
    const aboveFoldLazy: string[] = [];

    let imageIndex = 0;
    for (const img of allImages) {
      // Consider first 3 images as likely above-fold
      if (imageIndex >= 3) break;

      // Not a real above-fold candidate — skip without consuming the
      // above-fold window so genuinely visible images later in the DOM still
      // get evaluated (#699).
      if (isHiddenViaAncestor(img) || isInactiveCarouselSlide(img) || isInsideFooter(img)) {
        continue;
      }

      const src = img.getAttribute("src");
      const loading = img.getAttribute("loading");

      // Skip data URIs and tiny images
      if (src?.startsWith("data:") || src?.includes("pixel") || src?.includes("spacer")) {
        continue;
      }

      if (loading === "lazy" && src) {
        aboveFoldLazy.push(src);
      }

      imageIndex++;
    }

    if (aboveFoldLazy.length > 0) {
      checks.push({
        name: "lazy-above-fold",
        status: "warn",
        message: `${aboveFoldLazy.length} above-fold image(s) with lazy loading`,
        items: aboveFoldLazy.map((url) => ({ id: url })),
      });
    } else {
      checks.push({
        name: "lazy-above-fold",
        status: "pass",
        message: "No lazy loading on above-fold images",
      });
    }

    return { checks };
  },
};
