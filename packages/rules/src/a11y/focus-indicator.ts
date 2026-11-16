// a11y/focus-indicator - A focused control shows no change on screen
// Based on WCAG 2.4.7 Focus Visible (Level AA)

import type { CheckItem } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult } from "../types";
import {
  MAX_FOCUS_ITEMS,
  focusIndicators,
  focusItem,
  readFocusSnapshot,
} from "./rendered-focus";

const CHECK = "focus-indicator";

export const focusIndicatorRule: Rule = {
  meta: {
    id: "a11y/focus-indicator",
    name: "Focus Indicator",
    description:
      "Measures the computed styles of each control while it holds keyboard focus and flags those that show no outline, shadow, border, background or underline change",
    solution:
      "Every control Tab reaches needs a visible indicator. Restore the outline (outline: 2px solid with an offset) or add a :focus-visible rule that changes the border, box-shadow or background by at least 3:1 contrast. Do not set outline: none without a replacement. This reads the computed styles in a browser render, so unlike the static a11y/focus-visible heuristic it sees stylesheet and framework rules. It needs the cloud render and is skipped without it, and a11y/focus-visible still runs.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 6,
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

    const bare = stops.filter((s) => focusIndicators(s).length === 0);
    if (bare.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `All ${stops.length} focus stop(s) show a focus indicator`,
            details: { stops: stops.length },
          },
        ],
      };
    }
    const items: CheckItem[] = bare.slice(0, MAX_FOCUS_ITEMS).map((s) =>
      focusItem(
        s.selector,
        `${s.selector}: focused outline ${s.focused.outlineStyle} ${s.focused.outlineWidthPx}px, box-shadow ${s.focused.boxShadow || "none"}; no border, background or underline change`,
      ),
    );
    return {
      checks: [
        {
          name: CHECK,
          status: "warn",
          message: `${bare.length} of ${stops.length} focusable element(s) show no visible focus indicator`,
          items,
          details: {
            missing: bare.length,
            stops: stops.length,
            note: "WCAG 2.4.7: a keyboard focus indicator is visible; measured from computed styles",
          },
        },
      ],
    };
  },
};
