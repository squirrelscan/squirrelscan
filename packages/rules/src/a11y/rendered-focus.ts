// Shared reader for the rendered keyboard rules (a11y/focus-order, keyboard-trap,
// focus-not-obscured, focus-indicator).
//
// A static rule cannot tell whether an element is reachable or visible while it holds keyboard
// focus. The cloud render service runs a scripted Tab pass over the rendered page and returns a
// `RenderFocusSnapshot` on the page's render result; these rules judge that snapshot. They read the
// same render `ax/content-without-js` reads, so they add no charge beyond the page's audit.

import type {
  FocusIndicatorStyle,
  FocusRect,
  FocusStop,
  RenderFocusSnapshot,
  RenderResultItem,
} from "@squirrelscan/core-contracts";

import type { CheckItem } from "@squirrelscan/core-contracts";

import { humanizeCloudSkip, readCloudResult } from "../cloud";
import type { CheckResult, RuleContext } from "../types";

/** The most items a finding lists. */
export const MAX_FOCUS_ITEMS = 10;

export type FocusRead =
  | { kind: "snapshot"; snapshot: RenderFocusSnapshot }
  | { kind: "skipped"; check: CheckResult };

/**
 * The page's focus snapshot, or the one skipped check that says why there is none: a run without
 * the cloud (offline, logged out, render disabled, out of credits) or a render that carried no
 * keyboard pass. `skipReason` is the humanized cloud sentence when the cloud is the cause, so the
 * report's locked-rules and render-disabled handling keep matching it.
 */
export function readFocusSnapshot(ctx: RuleContext, checkName: string): FocusRead {
  const message = "Rendered keyboard check skipped";
  const envelope = readCloudResult<RenderResultItem>(ctx.cloudResults, "render", ctx.page.url);
  if (!envelope || envelope.status === "skipped") {
    return {
      kind: "skipped",
      check: {
        name: checkName,
        status: "skipped",
        message,
        skipReason: humanizeCloudSkip(envelope?.skipReason ?? "not-prefetched"),
      },
    };
  }
  const snapshot = envelope.data?.focus;
  if (!snapshot) {
    return {
      kind: "skipped",
      check: {
        name: checkName,
        status: "skipped",
        message,
        skipReason: envelope.data?.html
          ? "The render did not include a keyboard pass for this page"
          : humanizeCloudSkip("render-failed"),
      },
    };
  }
  return { kind: "snapshot", snapshot };
}

function round(n: number): number {
  return Math.round(n);
}

/** `x,y WxH` in CSS pixels from the document origin. */
export function describeRect(r: FocusRect): string {
  return `${round(r.x)},${round(r.y)} ${round(r.width)}x${round(r.height)}`;
}

export function focusItem(selector: string, label: string): CheckItem {
  return { id: selector, label, selector };
}

const NO_OUTLINE_STYLES = new Set(["none", "hidden"]);

/** A CSS color that paints nothing (`transparent`, or any rgba/hsla with alpha 0). */
function isTransparent(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (c === "transparent") return true;
  const m = /^(?:rgba|hsla)\(.*[,/]\s*0(?:\.0+)?%?\s*\)$/.exec(c);
  return m !== null;
}

/** Whether the computed outline paints something. */
export function hasVisibleOutline(s: FocusIndicatorStyle): boolean {
  return (
    !NO_OUTLINE_STYLES.has(s.outlineStyle.trim().toLowerCase()) &&
    s.outlineWidthPx > 0 &&
    !isTransparent(s.outlineColor)
  );
}

function hasShadow(s: FocusIndicatorStyle): boolean {
  const v = s.boxShadow.trim().toLowerCase();
  return v !== "" && v !== "none";
}

/**
 * The computed ways a focused element shows focus, read from the styles measured in the browser:
 * an outline that paints, or a box-shadow, border color, background color or text decoration that
 * differs from the unfocused element. Empty when nothing on screen changes.
 */
export function focusIndicators(stop: FocusStop): string[] {
  const { focused: f, unfocused: u } = stop;
  const found: string[] = [];
  if (hasVisibleOutline(f)) {
    found.push(`outline ${f.outlineStyle} ${f.outlineWidthPx}px ${f.outlineColor}`);
  }
  if (hasShadow(f) && f.boxShadow !== u.boxShadow) found.push(`box-shadow ${f.boxShadow}`);
  if (f.borderColor !== u.borderColor) found.push(`border-color ${u.borderColor} to ${f.borderColor}`);
  if (f.backgroundColor !== u.backgroundColor) {
    found.push(`background-color ${u.backgroundColor} to ${f.backgroundColor}`);
  }
  if (f.textDecoration !== u.textDecoration) {
    found.push(`text-decoration ${u.textDecoration} to ${f.textDecoration}`);
  }
  return found;
}
