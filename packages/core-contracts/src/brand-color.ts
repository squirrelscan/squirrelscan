// Report brand colour (squirrelscan/repo#3130): normalisation, WCAG 2.x
// contrast maths and the AA validation an org's brand colour must pass
// before a report applies it.

export const BRAND_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** Minimum contrast for the text drawn on the brand colour (WCAG 1.4.3 AA, normal text). */
export const BRAND_TEXT_MIN_CONTRAST = 4.5;
/** Minimum contrast of the brand colour against the white page (WCAG 1.4.11 UI components). */
export const BRAND_UI_MIN_CONTRAST = 3;

const WHITE = "#ffffff";
const BLACK = "#000000";

/** `#RRGGBB` (any case, surrounding space ignored) to lowercase `#rrggbb`, or null. */
export function normalizeBrandColor(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  return BRAND_COLOR_PATTERN.test(value) ? value : null;
}

function channel(hex: string, start: number): number {
  const c = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a `#rrggbb` colour (0 black to 1 white). */
export function relativeLuminance(color: string): number {
  const hex = normalizeBrandColor(color);
  if (!hex) throw new RangeError(`Invalid colour: ${color}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever has the higher contrast on `color`. */
export function pickTextOn(color: string): "#000000" | "#ffffff" {
  return contrastRatio(color, BLACK) >= contrastRatio(color, WHITE) ? BLACK : WHITE;
}

export type BrandColorValidation =
  | {
      ok: true;
      color: string;
      textColor: "#000000" | "#ffffff";
      textContrast: number;
      pageContrast: number;
    }
  | {
      ok: false;
      reason: "invalid-format" | "text-contrast" | "page-contrast";
      message: string;
      textContrast?: number;
      pageContrast?: number;
    };

export function validateBrandColor(input: unknown): BrandColorValidation {
  const color = normalizeBrandColor(input);
  if (!color) {
    return {
      ok: false,
      reason: "invalid-format",
      message: "Brand colour must be a #rrggbb hex value.",
    };
  }
  const textColor = pickTextOn(color);
  const textContrast = contrastRatio(color, textColor);
  const pageContrast = contrastRatio(color, WHITE);
  if (textContrast < BRAND_TEXT_MIN_CONTRAST) {
    return {
      ok: false,
      reason: "text-contrast",
      message: `Text on this colour reaches ${textContrast.toFixed(2)}:1; WCAG AA needs ${BRAND_TEXT_MIN_CONTRAST}:1.`,
      textContrast,
      pageContrast,
    };
  }
  if (pageContrast < BRAND_UI_MIN_CONTRAST) {
    return {
      ok: false,
      reason: "page-contrast",
      message: `This colour reaches ${pageContrast.toFixed(2)}:1 against a white page; WCAG needs ${BRAND_UI_MIN_CONTRAST}:1.`,
      textContrast,
      pageContrast,
    };
  }
  return { ok: true, color, textColor, textContrast, pageContrast };
}
