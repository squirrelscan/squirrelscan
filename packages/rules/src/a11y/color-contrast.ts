// a11y/color-contrast - Color contrast ratio check
// Based on WCAG 2.1 Success Criterion 1.4.3 Contrast (Minimum) (Level AA)

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

type Rgb = [number, number, number];

// WCAG 2.1 AA contrast requirements
const CONTRAST_RATIO_NORMAL = 4.5; // Normal text
const _CONTRAST_RATIO_LARGE = 3.0; // Large text (18px+, or 14px+ bold) - reserved for future use

// Named colors with their RGB values (CSS Level 4)
const NAMED_COLORS: Record<string, Rgb> = {
  // Basic colors
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  // Grays
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  gainsboro: [220, 220, 220],
  whitesmoke: [245, 245, 245],
  slategray: [112, 128, 144],
  slategrey: [112, 128, 144],
  // Other named colors
  navy: [0, 0, 128],
  teal: [0, 128, 128],
  maroon: [128, 0, 0],
  olive: [128, 128, 0],
  purple: [128, 0, 128],
  fuchsia: [255, 0, 255],
  aqua: [0, 255, 255],
  lime: [0, 255, 0],
  yellow: [255, 255, 0],
  orange: [255, 165, 0],
  pink: [255, 192, 203],
  coral: [255, 127, 80],
  tomato: [255, 99, 71],
};

export const colorContrastRule: Rule = {
  meta: {
    id: "a11y/color-contrast",
    name: "Color Contrast",
    description: "Measures the contrast of text whose color and background are both set inline",
    solution:
      "Text must have sufficient contrast with its background for readability. WCAG AA requires 4.5:1 for normal text and 3:1 for large text (18pt+, or 14pt+ bold). Darken the text or lighten the background until the pair clears the ratio, and check the pair, not the color alone. squirrel only measures pairs it can resolve from the markup; verify colors set in stylesheets with browser DevTools or a contrast checker. Don't rely on color alone to convey information - add icons or text labels.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];
    const lowContrast: Array<{ element: string; fg: string; bg: string; ratio: number }> = [];
    let measuredPairs = 0;

    // Only a pair the markup fully determines is measured: an element that
    // sets both its text color and an opaque background color inline, and has
    // text to read. Colors from stylesheets, class names or ancestors cannot be
    // resolved without rendering, and an unresolved pair is not a violation
    // (axe reports it as "incomplete", not as a failure).
    const elementsWithStyle = doc.querySelectorAll("[style]");

    for (const el of elementsWithStyle) {
      const colors = resolveInlineColors(el.getAttribute("style") || "");
      if (!colors) continue;
      if (!el.textContent?.trim()) continue;
      const { fg, bg, fgRgb, bgRgb } = colors;

      measuredPairs++;
      const ratio = calculateContrastRatio(fgRgb, bgRgb);
      if (ratio < CONTRAST_RATIO_NORMAL) {
        lowContrast.push({
          element: el.tagName.toLowerCase(),
          fg,
          bg,
          ratio,
        });
      }
    }

    const elementsWithClass = doc.querySelectorAll("[class]");

    if (lowContrast.length > 0) {
      const uniqueIssues = [
        ...new Set(
          lowContrast.map(
            (issue) => `${issue.element}: ${issue.fg} on ${issue.bg} (${issue.ratio.toFixed(2)}:1)`
          )
        ),
      ];

      checks.push({
        name: "color-contrast",
        status: "warn",
        message: `${uniqueIssues.length} color contrast issue(s) below 4.5:1`,
        items: uniqueIssues.slice(0, 10).map((id) => ({ id })),
        details: {
          note: "WCAG AA requires 4.5:1 for normal text, 3:1 for large text",
          measuredPairs,
          ...(uniqueIssues.length > 10 ? { additional: uniqueIssues.length - 10 } : {}),
        },
      });
    } else if (elementsWithStyle.length > 0 || elementsWithClass.length > 0) {
      checks.push({
        name: "color-contrast",
        status: "pass",
        message: "No obvious contrast issues detected",
        details: {
          note: "Full contrast check requires browser rendering for complete accuracy",
          measuredPairs,
        },
      });
    } else {
      checks.push({
        name: "color-contrast",
        status: "info",
        message: "Limited contrast analysis available",
        value: "Use browser DevTools or WebAIM Contrast Checker for full audit",
      });
    }

    return { checks };
  },
};

interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

/**
 * Split a style attribute into declarations on the `;`s that end one: not
 * inside a quoted string, parentheses or an escape. A comment becomes a space,
 * so it still separates tokens. One linear pass, since the value is
 * site-controlled.
 */
function splitDeclarations(style: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (let i = 0; i < style.length; i++) {
    const ch = style[i]!;
    if (ch === "\\") {
      current += style.slice(i, i + 2);
      i++;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && style[i + 1] === "*") {
      const end = style.indexOf("*/", i + 2);
      if (end < 0) break;
      // A comment separates tokens: `#c/**/cc` is not `#ccc`.
      current += " ";
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if (ch === ";" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** The declarations of an inline `style` attribute, in source order, with `!important` split off. */
function parseDeclarations(style: string): Declaration[] {
  const declarations: Declaration[] = [];
  for (const part of splitDeclarations(style)) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    let important = false;
    if (value.toLowerCase().endsWith("important")) {
      const head = value.slice(0, -"important".length).trimEnd();
      if (head.endsWith("!")) {
        important = true;
        value = head.slice(0, -1).trim();
      }
    }
    if (property && value) declarations.push({ property, value, important });
  }
  return declarations;
}

/** The declaration the cascade applies among `candidates`: `!important` first, then the last one. */
function winner(candidates: Declaration[]): Declaration | undefined {
  let best: Declaration | undefined;
  for (const d of candidates) {
    if (!best || d.important || !best.important) best = d;
  }
  return best;
}

/**
 * The text color and background color an inline `style` attribute settles on,
 * when both are opaque colors it fully determines, or null. The `background`
 * shorthand counts only when its whole value is one color; any other shorthand,
 * and any `background-image` other than `none`, leaves the color behind the
 * text unknown.
 */
function resolveInlineColors(
  style: string
): { fg: string; bg: string; fgRgb: Rgb; bgRgb: Rgb } | null {
  const declarations = parseDeclarations(style);

  const color = winner(declarations.filter((d) => d.property === "color"));
  const fgRgb = color ? parseColor(color.value) : null;
  if (!color || !fgRgb) return null;

  const background = winner(
    declarations.filter((d) => d.property === "background" || d.property === "background-color")
  );
  const bgRgb = background ? parseColor(background.value) : null;
  if (!background || !bgRgb) return null;

  const image = winner(
    declarations.filter((d) => d.property === "background" || d.property === "background-image")
  );
  // A one-color `background` shorthand resets the image to none; any other
  // shorthand may set one.
  if (image) {
    const noImage =
      image.property === "background-image"
        ? image.value.toLowerCase() === "none"
        : parseColor(image.value) !== null;
    if (!noImage) return null;
  }

  return { fg: color.value, bg: background.value, fgRgb, bgRgb };
}

const HEX_COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const RGB_COLOR =
  /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d+(?:\.\d+)?%?|\.\d+%?)\s*)?\)$/;

/**
 * Parse an opaque color into RGB, or null when the value cannot be resolved
 * from itself: `transparent` or any color with alpha below 1 blends with what
 * is behind it, and keywords such as `inherit` or `currentcolor` and unknown
 * syntax name a color that is not in the value.
 */
function parseColor(color: string): Rgb | null {
  const c = color.toLowerCase().trim();

  if (Object.hasOwn(NAMED_COLORS, c)) return NAMED_COLORS[c]!;

  const hex = HEX_COLOR.exec(c)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((d) => d + d).join("") : hex;
    if (full.length === 8 && full.slice(6) !== "ff") return null;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }

  const rgb = RGB_COLOR.exec(c);
  if (rgb) {
    const channels = [rgb[1], rgb[2], rgb[3]].map((v) => Number.parseInt(v!, 10));
    if (channels.some((v) => v > 255)) return null;
    const alpha = rgb[4];
    if (alpha !== undefined) {
      const value = alpha.endsWith("%") ? Number.parseFloat(alpha) / 100 : Number.parseFloat(alpha);
      if (!(value >= 1)) return null;
    }
    return channels as Rgb;
  }

  return null;
}

/**
 * Calculate relative luminance per WCAG 2.1
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Calculate contrast ratio per WCAG 2.1
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
function calculateContrastRatio(
  fg: [number, number, number],
  bg: [number, number, number]
): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
