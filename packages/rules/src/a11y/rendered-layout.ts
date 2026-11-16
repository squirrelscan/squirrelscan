// a11y/rendered-layout - rendered reflow, text spacing and text resize (WCAG 1.4.10, 1.4.12, 1.4.4).
//
// Markup cannot say whether a page still works at 320 CSS px, with the WCAG text-spacing overrides
// applied, or with text at 200%: only a browser can. The cloud `render` service takes these
// measurements in the same browser pass that renders the page, so no second render is paid for.
// The static `a11y/zoom-disabled` rule stays as the offline check.

import type {
  RenderLayoutElement,
  RenderLayoutProbeResult,
  RenderResultItem,
} from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

const REFLOW = "reflow";
const TEXT_SPACING = "text-spacing";
const TEXT_RESIZE = "text-resize";
const SKIPPED = "rendered-layout";

/** Sub-pixel rounding between layout and scroll metrics is not an overflow. */
const OVERFLOW_TOLERANCE_PX = 1;
/** Elements named in one message; the rest are counted. The details carry the capped list. */
const MAX_NAMED = 5;
/** Longest selector a finding carries. */
const MAX_SELECTOR = 200;

function selectorOf(el: RenderLayoutElement): string {
  const s = String(el.selector ?? "");
  return s.length > MAX_SELECTOR ? `${s.slice(0, MAX_SELECTOR - 1)}…` : s;
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function usable(result: RenderLayoutProbeResult | undefined): result is RenderLayoutProbeResult {
  return (
    !!result &&
    isFinitePositive(result.scrollWidth) &&
    isFinitePositive(result.viewportWidth) &&
    Array.isArray(result.elements)
  );
}

function describe(el: RenderLayoutElement, measure: "width" | "clipped"): string {
  const selector = selectorOf(el);
  if (measure === "width" && isFinitePositive(el.width))
    return `${selector} (${Math.round(el.width)}px wide)`;
  if (measure === "clipped" && isFinitePositive(el.clippedPx) && el.clippedPx > 0) {
    return `${selector} (${Math.round(el.clippedPx)}px clipped)`;
  }
  return selector;
}

function named(elements: RenderLayoutElement[], measure: "width" | "clipped"): string {
  const shown = elements.slice(0, MAX_NAMED).map((el) => describe(el, measure));
  const more = elements.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function details(result: RenderLayoutProbeResult) {
  return {
    scrollWidth: result.scrollWidth,
    viewportWidth: result.viewportWidth,
    elements: result.elements.slice(0, 20).map((el) => ({
      selector: selectorOf(el),
      ...(isFinitePositive(el.width) ? { width: el.width } : {}),
      ...(isFinitePositive(el.clippedPx) ? { clippedPx: el.clippedPx } : {}),
    })),
  };
}

function reflowCheck(result: RenderLayoutProbeResult, url: string): CheckResult {
  const overflow = result.scrollWidth - result.viewportWidth;
  if (overflow <= OVERFLOW_TOLERANCE_PX) {
    return {
      name: REFLOW,
      status: "pass",
      message: `The page fits a ${result.viewportWidth}px wide viewport without horizontal scrolling`,
      details: details(result),
    };
  }
  const who = result.elements.length > 0 ? `: ${named(result.elements, "width")}` : "";
  return {
    name: REFLOW,
    status: "fail",
    message: `At ${result.viewportWidth}px wide the page scrolls horizontally (content is ${Math.round(result.scrollWidth)}px wide, WCAG 1.4.10)${who}`,
    pageUrl: url,
    details: details(result),
  };
}

function clippingCheck(
  name: string,
  result: RenderLayoutProbeResult,
  url: string,
  passMessage: string,
  failPrefix: string,
): CheckResult {
  if (result.elements.length === 0) {
    return { name, status: "pass", message: passMessage, details: details(result) };
  }
  return {
    name,
    status: "fail",
    message: `${failPrefix}: ${named(result.elements, "clipped")}`,
    pageUrl: url,
    details: details(result),
  };
}

function skipped(reason: string, message: string): RuleResult {
  return { checks: [{ name: SKIPPED, status: "skipped", message, skipReason: reason }] };
}

export const renderedLayoutRule: Rule = {
  meta: {
    id: "a11y/rendered-layout",
    name: "Rendered Layout",
    description:
      "Renders the page at 320px wide, with the WCAG text-spacing overrides and with text at 200%, and flags horizontal scrolling and clipped text",
    solution:
      "Make the layout reflow: use relative units and flexible containers so nothing forces horizontal scrolling at 320 CSS px (WCAG 1.4.10), and give text containers room to grow instead of fixed heights with overflow hidden. Text must survive line-height 1.5, paragraph spacing 2em, letter spacing 0.12em and word spacing 0.16em (WCAG 1.4.12), and 200% text size (WCAG 1.4.4). Replace fixed widths and heights on text boxes with min-height, max-width and padding, and let long words and URLs wrap with overflow-wrap.",
    category: "a11y",
    scope: "page",
    // Each page's own layout under its own stylesheet and content.
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    skipOnSoft404: true,
    // `audit_page`: the probe rides the page's own render, never a second billed render. The same
    // spec as ax/content-without-js.
    cloud: { service: "render", unit: "page", creditFeature: "audit_page" },
  },

  run(ctx: RuleContext): RuleResult {
    const envelope = readCloudResult<RenderResultItem>(ctx.cloudResults, "render", ctx.page.url);
    if (!envelope || envelope.status === "skipped") {
      return skipped(
        humanizeCloudSkip(envelope?.skipReason ?? "not-prefetched"),
        "Rendered layout checks skipped: they need a cloud audit",
      );
    }
    const layout = envelope.data?.layout;
    if (!layout) {
      return skipped(
        "The render service returned no layout measurements for this page",
        "Rendered layout checks skipped",
      );
    }

    const url = ctx.page.url;
    const checks: CheckResult[] = [];
    if (usable(layout.reflow)) checks.push(reflowCheck(layout.reflow, url));
    if (usable(layout.textSpacing)) {
      checks.push(
        clippingCheck(
          TEXT_SPACING,
          layout.textSpacing,
          url,
          "No text is clipped or overlapped under the WCAG text-spacing overrides",
          "Text is clipped under the WCAG 1.4.12 text-spacing overrides",
        ),
      );
    }
    if (usable(layout.textResize)) {
      checks.push(
        clippingCheck(
          TEXT_RESIZE,
          layout.textResize,
          url,
          "No text is clipped or overlapped at 200% text size",
          "Content is clipped at 200% text size (WCAG 1.4.4)",
        ),
      );
    }
    if (checks.length === 0) {
      return skipped(
        "The render service returned no usable layout measurements for this page",
        "Rendered layout checks skipped",
      );
    }
    return { checks };
  },
};
