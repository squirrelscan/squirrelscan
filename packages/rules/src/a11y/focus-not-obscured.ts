// a11y/focus-not-obscured - A sticky or fixed element hides the focused control
// Based on WCAG 2.2 Focus Not Obscured (Minimum) 2.4.11 (Level AA)

import type { CheckItem } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult } from "../types";
import {
  MAX_FOCUS_ITEMS,
  describeRect,
  focusItem,
  readFocusSnapshot,
} from "./rendered-focus";

const CHECK = "focus-not-obscured";

export const focusNotObscuredRule: Rule = {
  meta: {
    id: "a11y/focus-not-obscured",
    name: "Focus Not Obscured",
    description:
      "Flags a focusable element that a sticky header, fixed banner or cookie bar covers completely while it holds keyboard focus (WCAG 2.2, 2.4.11)",
    solution:
      "When Tab lands on a control, at least part of it must stay visible. A sticky header or a fixed banner that sits over the scrolled-to control hides it from the keyboard user. Add scroll-padding-top (or scroll-margin on the controls) equal to the height of the fixed element so the browser scrolls focus clear of it, and keep cookie bars and chat widgets from covering the end of the page. squirrel measures this in a browser render, so it needs the cloud render and is skipped without it.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    skipOnSoft404: true,
    cloud: { service: "render", unit: "page", creditFeature: "audit_page" },
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CHECK, outcome: "clean", clears: [CHECK] },
      { name: CHECK, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const read = readFocusSnapshot(ctx, CHECK);
    if (read.kind === "skipped") return { checks: [read.check] };
    const { stops } = read.snapshot;

    // Only an author-positioned (fixed or sticky) cover is a finding: a stop with no
    // measured cover is hidden for another reason this rule does not judge.
    const hidden = stops.filter((s) => s.obscuredBy && s.visibleFraction <= 0);
    if (hidden.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `No focused element was fully covered across ${stops.length} focus stop(s)`,
            details: { stops: stops.length },
          },
        ],
      };
    }
    const items: CheckItem[] = hidden.slice(0, MAX_FOCUS_ITEMS).map((s) =>
      focusItem(
        s.selector,
        `${s.selector} (${describeRect(s.rect)}) is fully covered by ${s.obscuredBy?.position} ${s.obscuredBy?.selector} (${describeRect(s.obscuredBy!.rect)}) while focused`,
      ),
    );
    return {
      checks: [
        {
          name: CHECK,
          status: "warn",
          message: `${hidden.length} focused element(s) are entirely hidden by a sticky or fixed element`,
          items,
          details: {
            hidden: hidden.length,
            stops: stops.length,
            note: "WCAG 2.4.11 (2.2 AA): the focused component is not entirely hidden by author-created content",
          },
        },
      ],
    };
  },
};
