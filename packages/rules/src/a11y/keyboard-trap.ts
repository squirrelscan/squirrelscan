// a11y/keyboard-trap - Focus enters a region and Tab cannot leave it
// Based on WCAG 2.1.2 No Keyboard Trap (Level A)

import type { Rule, RuleContext, RuleResult } from "../types";
import { focusItem, readFocusSnapshot } from "./rendered-focus";

const CHECK = "keyboard-trap";

export const keyboardTrapRule: Rule = {
  meta: {
    id: "a11y/keyboard-trap",
    name: "Keyboard Trap",
    description:
      "Runs a scripted Tab pass over a rendered page and flags a region that keeps focus and does not release it, while accepting a modal that releases on Escape",
    solution:
      "A keyboard user must be able to leave every component with the keyboard. A modal dialog may hold focus while it is open, but it must release it: Escape has to close it and return focus to the control that opened it. Widgets that cycle focus (embedded players, editors, custom menus) need a documented key that exits, and a focus handler must never move focus back to the element the user just left. squirrel measures this in a browser render, so it needs the cloud render and is skipped without it.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 7,
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
    const { trap, stops } = read.snapshot;

    if (!trap) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `Tab left every region it entered across ${stops.length} focus stop(s)`,
            details: { stops: stops.length },
          },
        ],
      };
    }
    const where = trap.container ?? trap.selector;
    if (trap.releasedByEscape) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `Focus is held in ${where} but Escape releases it`,
            details: { container: where, inDialog: trap.inDialog, tabPresses: trap.tabPresses },
          },
        ],
      };
    }
    return {
      checks: [
        {
          name: CHECK,
          status: "fail",
          message: `Keyboard focus is trapped in ${where}: Tab cycled after ${trap.tabPresses} press(es) and Escape did not release it`,
          items: [
            focusItem(
              where,
              `Focus last seen on ${trap.selector}; ${trap.tabPresses} Tab press(es) before the cycle repeated${trap.inDialog ? "; the region is a dialog" : ""}; Escape did not release it`,
            ),
          ],
          details: {
            container: trap.container ?? null,
            focused: trap.selector,
            tabPresses: trap.tabPresses,
            inDialog: trap.inDialog,
            releasedByEscape: false,
            note: "WCAG 2.1.2: focus can be moved away from a component using the keyboard alone",
          },
        },
      ],
    };
  },
};
