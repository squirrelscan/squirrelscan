// a11y/color-contrast-rendered - measured contrast from the browser's computed styles (repo#3088)
//
// The static `a11y/color-contrast` only sees inline colors. This cloud rule reads the computed text
// styles the render service measured, so it judges the colors a visitor sees: the real foreground
// against the effective background (alpha composited), with the large-text threshold applied.
// WCAG 1.4.3 (AA) and 1.4.6 (AAA) are separate checks, so AAA findings never dilute the AA result.

import type { RenderResultItem, RenderedTextStyle } from "@squirrelscan/core-contracts";

import { humanizeCloudSkip, readCloudResult } from "../cloud";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

type Rgba = [number, number, number, number];

/** WCAG contrast thresholds by tier and text size. */
export const CONTRAST_THRESHOLDS = {
  AA: { normal: 4.5, large: 3 },
  AAA: { normal: 7, large: 4.5 },
} as const;

/** 18pt (24px) and up is large text; 14pt (18.66px) and up is large when bold (WCAG 1.4.3). */
const LARGE_TEXT_PX = 24;
const LARGE_BOLD_TEXT_PX = 18.66;
const BOLD_WEIGHT = 700;

/** Elements judged per page and findings listed per check. */
const MAX_SAMPLES = 2000;
const MAX_ITEMS = 10;

const AA = "color-contrast-rendered";
const AAA = "color-contrast-rendered-aaa";
const UNCONFIRMED = "color-contrast-rendered-unconfirmed";

export const colorContrastRenderedRule: Rule = {
  meta: {
    id: "a11y/color-contrast-rendered",
    name: "Color Contrast (Rendered)",
    description:
      "Measures text contrast from the browser's computed styles against WCAG AA (4.5:1, 3:1 for large text) and, as a separate lower-severity check, AAA (7:1, 4.5:1); backgrounds it cannot resolve are reported as unconfirmed",
    solution:
      "Darken the text or lighten its background until the pair clears the ratio shown for each element: 4.5:1 for normal text and 3:1 for large text (AA), or 7:1 and 4.5:1 for AAA. Large text is 24px and up, or 18.66px and up when bold. Check the pair the browser actually paints, including any transparency, not the color token alone. Text over an image or gradient is listed as unconfirmed: check it by hand with browser DevTools, or put a solid scrim behind the text.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    // `audit_page` (#2290): the render runs inside the audit and is billed as the page's own audit
    // charge, never as a render on top of it. The same spec as ax/content-without-js.
    cloud: { service: "render", unit: "page", creditFeature: "audit_page" },
    checks: [
      { name: AA, outcome: "problem" },
      { name: AA, outcome: "clean", clears: [AA] },
      { name: AA, outcome: "skipped" },
      { name: AAA, outcome: "problem" },
      { name: AAA, outcome: "clean", clears: [AAA] },
      { name: UNCONFIRMED, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    if (ctx.page.rendered) {
      return skipped(
        "The crawl browser-rendered this page and the computed styles were not kept: run an audit that renders pages in the cloud to measure rendered contrast",
      );
    }

    const envelope = readCloudResult<RenderResultItem>(ctx.cloudResults, "render", ctx.page.url);
    if (!envelope || envelope.status === "skipped") {
      return skipped(humanizeCloudSkip(envelope?.skipReason ?? "not-prefetched"));
    }
    if (!envelope.data?.html) {
      return skipped(humanizeCloudSkip("render-failed"));
    }
    const samples = envelope.data.textStyles;
    if (!samples) {
      return skipped("The render service did not return computed text styles for this page");
    }

    const aaFails: Measured[] = [];
    const aaaFails: Measured[] = [];
    const unconfirmed: Array<{ selector: string; reason: string }> = [];
    let measured = 0;

    for (const sample of samples.slice(0, MAX_SAMPLES)) {
      const result = measure(sample);
      if (result.kind === "unconfirmed") {
        unconfirmed.push({ selector: sample.selector, reason: result.reason });
        continue;
      }
      measured++;
      const m = result.measurement;
      if (m.ratio < m.requiredAA) aaFails.push(m);
      else if (m.ratio < m.requiredAAA) aaaFails.push(m);
    }

    const checks: CheckResult[] = [];
    const truncated = samples.length > MAX_SAMPLES ? samples.length - MAX_SAMPLES : 0;

    if (aaFails.length > 0) {
      checks.push({
        name: AA,
        status: "warn",
        message: `${aaFails.length} text element(s) below WCAG AA contrast (4.5:1, or 3:1 for large text)`,
        items: aaFails.slice(0, MAX_ITEMS).map((m) => ({ id: describe(m, m.requiredAA) })),
        details: {
          measured,
          elements: aaFails.slice(0, MAX_ITEMS).map((m) => detail(m, m.requiredAA)),
          ...(aaFails.length > MAX_ITEMS ? { additional: aaFails.length - MAX_ITEMS } : {}),
        },
      });
    } else {
      checks.push({
        name: AA,
        status: "pass",
        message: "Measured text meets WCAG AA contrast",
        details: { measured, ...(truncated ? { notJudged: truncated } : {}) },
      });
    }

    // AAA is its own check at info status, so an AA score is never diluted by it. Elements that already
    // fail AA are listed under AA only.
    if (aaaFails.length > 0) {
      checks.push({
        name: AAA,
        status: "info",
        message: `${aaaFails.length} text element(s) meet AA but not WCAG AAA contrast (7:1, or 4.5:1 for large text)`,
        items: aaaFails.slice(0, MAX_ITEMS).map((m) => ({ id: describe(m, m.requiredAAA) })),
        details: {
          measured,
          elements: aaaFails.slice(0, MAX_ITEMS).map((m) => detail(m, m.requiredAAA)),
          ...(aaaFails.length > MAX_ITEMS ? { additional: aaaFails.length - MAX_ITEMS } : {}),
        },
      });
    } else {
      checks.push({
        name: AAA,
        status: "pass",
        message: "Measured text meets WCAG AAA contrast",
        details: { measured },
      });
    }

    if (unconfirmed.length > 0) {
      const reasons: Record<string, number> = {};
      for (const u of unconfirmed) reasons[u.reason] = (reasons[u.reason] ?? 0) + 1;
      checks.push({
        name: UNCONFIRMED,
        status: "info",
        message: `${unconfirmed.length} text element(s) could not be measured: ${Object.keys(reasons).join("; ")}`,
        items: unconfirmed.slice(0, MAX_ITEMS).map((u) => ({ id: `${u.selector} (${u.reason})` })),
        details: {
          inconclusive: true,
          unconfirmed: unconfirmed.length,
          reasons,
          ...(unconfirmed.length > MAX_ITEMS ? { additional: unconfirmed.length - MAX_ITEMS } : {}),
        },
        value: "Check these with browser DevTools or the WebAIM Contrast Checker",
      });
    }

    return { checks };
  },
};

function skipped(reason: string): RuleResult {
  return {
    checks: [
      {
        name: AA,
        status: "skipped",
        message: "Rendered contrast check skipped",
        skipReason: reason,
      },
    ],
  };
}

interface Measured {
  selector: string;
  ratio: number;
  large: boolean;
  requiredAA: number;
  requiredAAA: number;
  foreground: string;
  background: string;
}

type Measurement =
  | { kind: "measured"; measurement: Measured }
  | { kind: "unconfirmed"; reason: string };

const UNREADABLE = "a color the browser reported could not be read";

/** Judge one sample, or say why the pair cannot be confirmed. Never throws on hostile input. */
function measure(sample: RenderedTextStyle): Measurement {
  if (sample.backgroundImage) {
    return {
      kind: "unconfirmed",
      reason:
        sample.backgroundImage === "gradient"
          ? "a gradient sits behind the text"
          : "a background image sits behind the text",
    };
  }
  const fg = parseComputedColor(sample.color);
  if (!fg || !Array.isArray(sample.backgroundLayers) || !Number.isFinite(sample.fontSizePx)) {
    return { kind: "unconfirmed", reason: UNREADABLE };
  }
  // Composite from the farthest layer to the nearest over the white canvas.
  let bg: [number, number, number] = [255, 255, 255];
  for (let i = sample.backgroundLayers.length - 1; i >= 0; i--) {
    const layer = parseComputedColor(sample.backgroundLayers[i]!);
    if (!layer) return { kind: "unconfirmed", reason: UNREADABLE };
    bg = blend(layer, bg);
  }
  const fgOpaque = blend(fg, bg);
  const large =
    sample.fontSizePx >= LARGE_TEXT_PX ||
    (sample.fontWeight >= BOLD_WEIGHT && sample.fontSizePx >= LARGE_BOLD_TEXT_PX);
  const tier = (t: { normal: number; large: number }): number => (large ? t.large : t.normal);
  return {
    kind: "measured",
    measurement: {
      selector: sample.selector,
      ratio: contrastRatio(fgOpaque, bg),
      large,
      requiredAA: tier(CONTRAST_THRESHOLDS.AA),
      requiredAAA: tier(CONTRAST_THRESHOLDS.AAA),
      foreground: toHex(fgOpaque),
      background: toHex(bg),
    },
  };
}

function describe(m: Measured, required: number): string {
  return `${m.selector}: ${m.foreground} on ${m.background} (${m.ratio.toFixed(2)}:1, needs ${required}:1${m.large ? ", large text" : ""})`;
}

function detail(m: Measured, required: number) {
  return {
    selector: m.selector,
    ratio: Math.round(m.ratio * 100) / 100,
    required,
    large: m.large,
    foreground: m.foreground,
    background: m.background,
  };
}

const COMPUTED_COLOR =
  /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)(?:\s*[,/]\s*(\d*\.?\d+%?))?\s*\)$/i;

/** Parse the browser's computed `rgb()`/`rgba()` string (comma or space syntax). Null when unreadable. */
function parseComputedColor(value: string): Rgba | null {
  if (typeof value !== "string") return null;
  const m = COMPUTED_COLOR.exec(value.trim());
  if (!m) return null;
  const channels = [m[1], m[2], m[3]].map((v) => Number.parseFloat(v!));
  if (channels.some((v) => !(v >= 0 && v <= 255))) return null;
  let alpha = 1;
  if (m[4] !== undefined) {
    alpha = m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]);
    if (!(alpha >= 0 && alpha <= 1)) return null;
  }
  return [channels[0]!, channels[1]!, channels[2]!, alpha];
}

/** Source-over: a color with alpha on an opaque backdrop. */
function blend(top: Rgba, under: [number, number, number]): [number, number, number] {
  const a = top[3];
  return [
    top[0] * a + under[0] * (1 - a),
    top[1] * a + under[1] * (1 - a),
    top[2] * a + under[2] * (1 - a),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Relative luminance, WCAG 2.x. */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
