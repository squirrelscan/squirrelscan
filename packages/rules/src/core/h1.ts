// core/h1 - Validates H1 tag presence and uniqueness

import { UNCONFIRMED_CHECK_SUFFIX } from "@squirrelscan/core-contracts/resolution";

import { createStaticVisibility } from "../shared/static-hidden";
import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

/** On the details when some H1s are hidden or may be: the audit reads markup, not rendered CSS. */
const RENDERING_NOTE =
  "visibility is read from the HTML, inline styles and <style> blocks; an HTTP-only audit cannot resolve visibility set by external stylesheets or scripts";

/** The same limit, short enough for the message, which the report groups across pages. */
const RENDERING_LIMIT = "an HTTP-only audit cannot resolve CSS or script visibility";

/** How many of the page's H1s are exposed, hidden, or hidden by a style squirrel cannot settle. */
interface H1Exposure {
  /** Every `<h1>` in the HTML, as search engines that do not render read it. */
  raw: number;
  exposed: number;
  hidden: number;
  unconfirmed: number;
  /** Texts of the H1s that are exposed or unconfirmed, in document order. */
  visibleTexts: string[];
}

/**
 * Sorts the page's H1s by static visibility (#1636): the `hidden` attribute, an
 * inline `display:none` or `visibility:hidden`, a closed `<dialog>`, or a
 * `<style>` rule squirrel can decide. (`<template>` content never reaches the
 * count: the parser keeps it out of the document.) `aria-hidden` is not
 * read: it hides a heading from assistive technology, not from the page.
 * Null when the parsed texts do not line up with the document's H1s.
 */
function h1Exposure(ctx: RuleContext): H1Exposure | null {
  const doc = ctx.parsed.document;
  const { h1 } = ctx.parsed;
  if (!doc) return null;
  const elements = Array.from(doc.querySelectorAll("h1"));
  if (elements.length !== h1.count || h1.texts.length !== h1.count) return null;

  const visibility = createStaticVisibility({ ariaHidden: false });
  const result: H1Exposure = {
    raw: h1.count,
    exposed: 0,
    hidden: 0,
    unconfirmed: 0,
    visibleTexts: [],
  };
  for (const [i, el] of elements.entries()) {
    const seen = visibility.visibility(el);
    if (seen.state === "hidden") {
      result.hidden++;
      continue;
    }
    if (seen.state === "unknown") result.unconfirmed++;
    else result.exposed++;
    result.visibleTexts.push(h1.texts[i] ?? "");
  }
  return result;
}

export const h1Rule: Rule = {
  meta: {
    id: "core/h1",
    name: "H1 Tag",
    description: "Validates H1 tag presence and uniqueness",
    solution:
      "Each page should have exactly one H1 tag that clearly describes the main topic. The H1 is the primary heading users and search engines see, and it should align with the page title while being more detailed. If missing, add an H1 at the top of your main content. If you have multiple H1s, demote extras to H2 or lower. Ensure the H1 is descriptive and contains relevant keywords naturally. When a page has several H1s and only one is shown (the others carry the hidden attribute or display:none), it still warns, because crawlers that do not render the page read every H1, and the message gives the shown count beside the count in the HTML.",
    category: "core",
    scope: "page",
    verdictScope: "page",
    // Search-result presentation only: skipped on noindex pages (pub#457).
    skipOnNoindex: true,
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const { h1 } = ctx.parsed;
    const checks: CheckResult[] = [];

    if (h1.count === 0) {
      checks.push({
        name: "h1",
        status: "fail",
        message: "No H1 tag found",
        value: 0,
        expected: 1,
      });
      return { checks };
    }

    let h1Text = h1.texts[0];
    // Set when a page has several H1s but only one is exposed (#1636).
    let exposureDetails: Record<string, unknown> | undefined;

    if (h1.count > 1) {
      const seen = h1Exposure(ctx);
      const details = seen
        ? {
            rawCount: seen.raw,
            exposedCount: seen.exposed,
            hiddenCount: seen.hidden,
            ...(seen.unconfirmed > 0 ? { unconfirmedCount: seen.unconfirmed } : {}),
            ...(seen.hidden + seen.unconfirmed > 0 ? { note: RENDERING_NOTE } : {}),
          }
        : undefined;

      if (!seen || seen.hidden + seen.unconfirmed === 0 || seen.exposed + seen.unconfirmed === 0) {
        // Every H1 is exposed, or every one is hidden: the raw count is the
        // finding, as before.
        checks.push({
          name: "h1",
          status: "warn",
          message: `Multiple H1 tags found (${h1.count})`,
          value: h1.count,
          expected: 1,
          ...(details && seen && seen.hidden > 0 ? { details } : {}),
        });
        return { checks };
      }

      if (seen.exposed > 1) {
        checks.push({
          name: "h1",
          status: "warn",
          message: `Multiple H1 tags found (${seen.exposed} exposed, ${seen.raw} in the HTML; ${RENDERING_LIMIT})`,
          value: seen.exposed,
          expected: 1,
          details,
        });
        return { checks };
      }

      if (seen.exposed + seen.unconfirmed > 1) {
        checks.push({
          name: `h1${UNCONFIRMED_CHECK_SUFFIX}`,
          status: "warn",
          message: `Multiple H1 tags found (${seen.raw} in the HTML), ${seen.unconfirmed} may be hidden by a style (unconfirmed; ${RENDERING_LIMIT})`,
          value: seen.exposed + seen.unconfirmed,
          expected: 1,
          details,
        });
        return { checks };
      }

      // One H1 is left and the rest are hidden. Crawlers that do not render the
      // page still read every H1, so this warns on the raw count, with the
      // exposed count beside it; an empty one left warns as empty below. When
      // the one left may itself be hidden by a style (unconfirmed), the message
      // says so.
      h1Text = seen.visibleTexts[0];
      exposureDetails = details;
      if (h1Text && h1Text.length > 0) {
        const maybe =
          seen.unconfirmed > 0
            ? `, ${seen.unconfirmed} may be hidden by a style (unconfirmed)`
            : "";
        checks.push({
          name: "h1",
          status: "warn",
          message: `Multiple H1 tags found (${seen.exposed} exposed, ${seen.raw} in the HTML${maybe}; ${RENDERING_LIMIT})`,
          value: seen.raw,
          expected: 1,
          details,
        });
        return { checks };
      }
    }

    // Check if H1 is empty
    if (!h1Text || h1Text.length === 0) {
      checks.push({
        name: "h1",
        status: "warn",
        message: "H1 tag is empty",
        value: "",
        ...(exposureDetails ? { details: exposureDetails } : {}),
      });
      return { checks };
    }

    checks.push({
      name: "h1",
      status: "pass",
      message: "Single H1 tag present",
      value: h1Text,
    });

    return { checks };
  },
};
