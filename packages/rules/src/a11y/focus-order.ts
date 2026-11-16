// a11y/focus-order - Tab order contradicts the visual order
// Based on WCAG 2.4.3 Focus Order (Level A)

import type { FocusStop } from "@squirrelscan/core-contracts";

import type { CheckItem } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult } from "../types";
import {
  MAX_FOCUS_ITEMS,
  describeRect,
  focusItem,
  readFocusSnapshot,
} from "./rendered-focus";

const CHECK = "focus-order";

/** Share of the smaller box's height two boxes must overlap vertically to count as the same row. */
const SAME_ROW_OVERLAP = 0.5;

function sameRow(a: FocusStop, b: FocusStop): boolean {
  const top = Math.max(a.rect.y, b.rect.y);
  const bottom = Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height);
  const smaller = Math.min(a.rect.height, b.rect.height);
  return smaller > 0 && bottom - top >= smaller * SAME_ROW_OVERLAP;
}

/**
 * Whether Tab moved from `a` to `b` against the reading direction: `b` sits wholly above `a`, or on
 * the same row but wholly before it (to the left in left to right text, to the right in right to left).
 */
export function isBackwardJump(a: FocusStop, b: FocusStop, rtl: boolean): boolean {
  if (a.rect.width <= 0 || a.rect.height <= 0 || b.rect.width <= 0 || b.rect.height <= 0) {
    return false;
  }
  if (sameRow(a, b)) {
    return rtl
      ? b.rect.x >= a.rect.x + a.rect.width
      : b.rect.x + b.rect.width <= a.rect.x;
  }
  return b.rect.y + b.rect.height <= a.rect.y;
}

export const focusOrderRule: Rule = {
  meta: {
    id: "a11y/focus-order",
    name: "Focus Order",
    description:
      "Compares the order Tab visits focusable elements in a rendered page with their visual order, and flags a stop that jumps backward",
    solution:
      "Keyboard users move through a page with Tab, and the order must match what they see: left to right and top to bottom (reversed in right to left text). Fix it by reordering the DOM so it matches the layout, instead of repositioning boxes with CSS order, flex-direction: row-reverse, grid placement or absolute positioning, and avoid positive tabindex values, which pull elements to the front of the order. squirrel measures this in a browser render with a scripted Tab pass, so it needs the cloud render and is skipped without it.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
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
    const { stops, rtl = false } = read.snapshot;

    const items: CheckItem[] = [];
    let jumps = 0;
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1];
      const b = stops[i];
      if (!a || !b || !isBackwardJump(a, b, rtl)) continue;
      jumps++;
      if (items.length < MAX_FOCUS_ITEMS) {
        items.push(
          focusItem(
            b.selector,
            `Tab ${i} goes from ${a.selector} (${describeRect(a.rect)}) to ${b.selector} (${describeRect(b.rect)}), which is before it on screen`,
          ),
        );
      }
    }

    if (jumps === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `Tab order follows the visual order across ${stops.length} focus stop(s)`,
            details: { stops: stops.length, truncated: read.snapshot.truncated ?? false },
          },
        ],
      };
    }
    return {
      checks: [
        {
          name: CHECK,
          status: "warn",
          message: `${jumps} Tab step(s) jump backward against the visual order`,
          items,
          details: {
            jumps,
            stops: stops.length,
            direction: rtl ? "rtl" : "ltr",
            note: "WCAG 2.4.3: focus order must preserve meaning and operability",
          },
        },
      ],
    };
  },
};
