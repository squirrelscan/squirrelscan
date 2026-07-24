// a11y/color-contrast - Color contrast ratio check
// Based on WCAG 2.1 Success Criterion 1.4.3 Contrast (Minimum) (Level AA)

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

// WCAG 2.1 AA contrast requirements
const CONTRAST_RATIO_NORMAL = 4.5; // Normal text
const _CONTRAST_RATIO_LARGE = 3.0; // Large text (18px+, or 14px+ bold) - reserved for future use

// Named colors with their RGB values (CSS Level 4)
const NAMED_COLORS: Record<string, [number, number, number]> = {
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
  transparent: [255, 255, 255], // Treat as white background
};

// Common low-contrast CSS class patterns (framework-agnostic)
const LOW_CONTRAST_CLASS_PATTERNS = [
  // Tailwind-style gray text classes
  /text-gray-[34]\d{2}/,
  /text-slate-[34]\d{2}/,
  /text-zinc-[34]\d{2}/,
  /text-neutral-[34]\d{2}/,
  /text-stone-[34]\d{2}/,
  // Bootstrap-style muted text
  /text-muted/,
  /text-secondary/,
  // Generic patterns
  /text-light/,
  /text-subtle/,
  /text-disabled/,
  /text-placeholder/,
  // Opacity classes that might cause issues
  /opacity-[23]\d/,
  /text-opacity-[23]\d/,
];

export const colorContrastRule: Rule = {
  meta: {
    id: "a11y/color-contrast",
    name: "Color Contrast",
    description: "Checks for color contrast issues in styles and classes",
    solution:
      "Text must have sufficient contrast with its background for readability. WCAG AA requires 4.5:1 for normal text and 3:1 for large text (18px+ or 14px+ bold). Use tools like WebAIM Contrast Checker to verify. Common issues: light gray text, text over images without overlay. Don't rely on color alone to convey information - add icons or text labels.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];
    const inlineContrastIssues: Array<{
      element: string;
      fg: string;
      bg: string;
      ratio: number;
    }> = [];
    const classBasedIssues: Array<{
      element: string;
      classes: string;
      pattern: string;
    }> = [];

    // 1. Check elements with inline color styles
    const elementsWithStyle = doc.querySelectorAll("[style]");

    for (const el of elementsWithStyle) {
      const style = el.getAttribute("style") || "";
      const colors = extractColors(style);

      if (colors.foreground && colors.background) {
        const fgRgb = parseColor(colors.foreground);
        const bgRgb = parseColor(colors.background);

        if (fgRgb && bgRgb) {
          const ratio = calculateContrastRatio(fgRgb, bgRgb);

          // Check against normal text threshold
          if (ratio < CONTRAST_RATIO_NORMAL) {
            const tagName = el.tagName.toLowerCase();
            inlineContrastIssues.push({
              element: tagName,
              fg: colors.foreground,
              bg: colors.background,
              ratio,
            });
          }
        }
      }
    }

    // 2. Check for elements with low-contrast CSS classes
    const elementsWithClass = doc.querySelectorAll("[class]");

    for (const el of elementsWithClass) {
      const className = el.getAttribute("class") || "";
      const tagName = el.tagName.toLowerCase();

      // Check against known low-contrast class patterns
      for (const pattern of LOW_CONTRAST_CLASS_PATTERNS) {
        if (pattern.test(className)) {
          classBasedIssues.push({
            element: tagName,
            classes: className.slice(0, 60),
            pattern: pattern.source,
          });
          break; // Only report one issue per element
        }
      }
    }

    // 3. Parse <style> blocks for color declarations
    const styleBlocks = doc.querySelectorAll("style");
    const cssContrastIssues = analyzeCssColorDeclarations(styleBlocks, doc);

    // 4. Check raw HTML for problematic patterns
    const html = ctx.page.html || "";
    const patternIssues = detectPatternBasedIssues(html);

    // Build reports
    const totalIssueCount =
      inlineContrastIssues.length +
      classBasedIssues.length +
      cssContrastIssues.length +
      patternIssues.length;

    if (totalIssueCount > 0) {
      const allIssueDescriptions: string[] = [];

      // Inline style issues
      for (const issue of inlineContrastIssues) {
        allIssueDescriptions.push(
          `${issue.element}: ${issue.fg} on ${issue.bg} (${issue.ratio.toFixed(2)}:1)`
        );
      }

      // Class-based issues
      for (const issue of classBasedIssues) {
        allIssueDescriptions.push(
          `${issue.element} with class "${issue.classes.slice(0, 30)}..." may have low contrast`
        );
      }

      // CSS-defined issues
      allIssueDescriptions.push(...cssContrastIssues);

      // Pattern-based issues
      allIssueDescriptions.push(...patternIssues);

      // Deduplicate
      const uniqueIssues = [...new Set(allIssueDescriptions)];

      checks.push({
        name: "color-contrast",
        status: "warn",
        message: `${uniqueIssues.length} potential color contrast issue(s)`,
        items: uniqueIssues.slice(0, 10).map((id) => ({ id })),
        details: {
          note: "WCAG AA requires 4.5:1 for normal text, 3:1 for large text",
          inlineIssues: inlineContrastIssues.length,
          classBasedIssues: classBasedIssues.length,
          cssIssues: cssContrastIssues.length,
          patternIssues: patternIssues.length,
          ...(uniqueIssues.length > 10
            ? { additional: uniqueIssues.length - 10 }
            : {}),
        },
      });
    } else if (elementsWithStyle.length > 0 || elementsWithClass.length > 0) {
      checks.push({
        name: "color-contrast",
        status: "pass",
        message: "No obvious contrast issues detected",
        details: {
          note: "Full contrast check requires browser rendering for complete accuracy",
          elementsChecked: elementsWithStyle.length + elementsWithClass.length,
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

/**
 * Extract foreground and background colors from inline style
 */
function extractColors(style: string): {
  foreground?: string;
  background?: string;
} {
  const result: { foreground?: string; background?: string } = {};

  // Match color property (not background-color)
  const colorMatch = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
  if (colorMatch) {
    result.foreground = colorMatch[1].trim();
  }

  // Match background or background-color
  const bgMatch = style.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i);
  if (bgMatch) {
    // Extract just the color part (ignore gradients, images, etc.)
    const bgValue = bgMatch[1].trim();
    const colorPart = bgValue.match(/^(#[0-9a-f]{3,8}|rgba?\([^)]+\)|[a-z]+)/i);
    if (colorPart) {
      result.background = colorPart[1];
    }
  }

  return result;
}

/**
 * Parse a color string into RGB values
 */
function parseColor(color: string): [number, number, number] | null {
  const c = color.toLowerCase().trim();

  // Named color
  if (NAMED_COLORS[c]) {
    return NAMED_COLORS[c];
  }

  // Hex color: #RGB, #RRGGBB, #RRGGBBAA
  if (c.startsWith("#")) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (hex.length >= 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }

  // rgb() or rgba()
  const rgbMatch = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    return [
      parseInt(rgbMatch[1], 10),
      parseInt(rgbMatch[2], 10),
      parseInt(rgbMatch[3], 10),
    ];
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

/**
 * Analyze <style> blocks for potential low-contrast color combinations
 */
function analyzeCssColorDeclarations(
  styleElements: NodeListOf<Element>,
  _doc: Document
): string[] {
  const issues: string[] = [];

  // Known problematic color values (light on assumed white)
  const lowContrastColors = [
    { pattern: /#(?:ccc|ddd|eee|999|aaa|bbb)(?:\b|;)/gi, desc: "light gray" },
    { pattern: /#(?:c0c0c0|d3d3d3|dcdcdc)/gi, desc: "silver/gainsboro" },
    { pattern: /rgb\(\s*(?:1[89]\d|20\d|21\d|22\d)\s*,/gi, desc: "light rgb" },
  ];

  for (const style of styleElements) {
    const css = style.textContent || "";

    // Simple rule extraction (not a full CSS parser)
    const rules = css.match(/[^{}]+\{[^{}]*color\s*:[^;]+;[^{}]*\}/gi) || [];

    for (const rule of rules) {
      // Extract selector
      const selectorMatch = rule.match(/^([^{]+)\{/);
      const selector = selectorMatch ? selectorMatch[1].trim() : "unknown";

      // Check for low-contrast colors in this rule
      for (const { pattern, desc } of lowContrastColors) {
        pattern.lastIndex = 0;
        if (pattern.test(rule)) {
          issues.push(
            `CSS rule "${selector.slice(0, 30)}...": ${desc} text color`
          );
          break;
        }
      }
    }
  }

  return issues.slice(0, 5); // Limit to avoid noise
}

/**
 * Detect common low-contrast patterns via regex (fallback)
 */
function detectPatternBasedIssues(html: string): string[] {
  const issues: string[] = [];

  // Common problematic color combinations
  const problematicPatterns = [
    // Light gray text (likely on white background)
    {
      pattern: /color\s*:\s*#(?:ccc|ddd|eee|999|aaa|bbb)/gi,
      desc: "Light gray text",
    },
    {
      pattern: /color\s*:\s*(?:lightgray|lightgrey|silver)/gi,
      desc: "Light gray text",
    },
    // White/light text without explicit dark background nearby
    {
      pattern: /color\s*:\s*(?:white|#fff)/gi,
      desc: "White text (verify background)",
    },
    // Very light colors
    {
      pattern: /color\s*:\s*#[def][def][def]/gi,
      desc: "Very light text color",
    },
  ];

  for (const { pattern, desc } of problematicPatterns) {
    const matches = html.match(pattern);
    if (matches && matches.length > 0) {
      issues.push(`${desc}: ${matches.length} instance(s)`);
    }
  }

  return issues;
}
