// a11y/color-contrast - Color contrast ratio check
// Based on WCAG 2.1 Success Criterion 1.4.3 Contrast (Minimum) (Level AA)

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

import type {
  Rule,
  RuleContext,
  RuleResult,
  CheckResult,
  StylesheetBackground,
  StylesheetBackgroundData,
} from "../types";

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
    description:
      "Measures the contrast of text with an inline color against the background the markup determines, and counts the text it could not measure",
    solution:
      "Text must have sufficient contrast with its background for readability. WCAG AA requires 4.5:1 for normal text and 3:1 for large text (18pt+, or 14pt+ bold). Darken the text or lighten the background until the pair clears the ratio, and check the pair, not the color alone. squirrel measures text with an inline color against the nearest inline background, a plain html or body rule in a style block or in a same-site linked stylesheet, or the white browser default; where a stylesheet it could not read (another site, a failed request, an @import) may set the background it lists the text as not measured instead. Verify those with browser DevTools or a contrast checker. Don't rely on color alone to convey information - add icons or text labels.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    // Check names by outcome class (#1741).
    checks: [
      { name: "color-contrast", outcome: "problem" },
      { name: "color-contrast", outcome: "clean", clears: ["color-contrast"] },
      { name: "color-contrast-unresolved", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];
    const lowContrast: Array<{ element: string; fg: string; bg: string; ratio: number }> = [];
    const unresolved: Array<{ id: string; reason: UnresolvedReason }> = [];
    let measuredPairs = 0;

    // An element is measured when its own inline `color` is an opaque color and
    // the markup determines what is behind it: the nearest inline background up
    // the ancestors, a plain `html`/`body`/`:root` rule in a style block, or the
    // browser's white when nothing on the page can set a background. When a
    // stylesheet the audit does not read might set it, the pair is counted as
    // not measured, never reported: axe calls that "incomplete".
    const resolver = createBackgroundResolver(
      doc,
      ctx.page.finalUrl ?? ctx.page.url,
      ctx.site?.stylesheetBackgrounds
    );

    for (const el of doc.querySelectorAll("[style]")) {
      const color = winner(
        parseDeclarations(el.getAttribute("style") || "").filter((d) => d.property === "color")
      );
      if (!color || CSS_WIDE_KEYWORDS.has(color.value.toLowerCase())) continue;
      if (!el.textContent?.trim()) continue;
      const element = el.tagName.toLowerCase();
      const fgRgb = parseColor(color.value);
      if (!fgRgb) {
        unresolved.push({
          id: `${element}: ${color.value} (text color is translucent or not a plain color)`,
          reason: "color",
        });
        continue;
      }

      const bg = resolver.resolve(el);
      if (bg.kind === "unresolved") {
        const ratio = calculateContrastRatio(fgRgb, WHITE);
        unresolved.push({
          id: `${element}: ${color.value} (${ratio.toFixed(2)}:1 against white)`,
          reason: bg.reason,
        });
        continue;
      }

      measuredPairs++;
      const ratio = calculateContrastRatio(fgRgb, bg.rgb);
      if (ratio < CONTRAST_RATIO_NORMAL) {
        lowContrast.push({ element, fg: color.value, bg: bg.raw, ratio });
      }
    }

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
    } else {
      // Also the answer for a page with no inline text color at all: there is
      // nothing on it this rule can measure, which is not a finding. The
      // architecture has no way for a page rule to attach a note to the audited
      // site, so the note stays on the page's own check.
      checks.push({
        name: "color-contrast",
        status: "pass",
        message: "No obvious contrast issues detected",
        details: {
          note:
            measuredPairs > 0
              ? "Colors set in stylesheets are not analysed; full contrast check requires browser rendering for complete accuracy"
              : "No inline text colors to measure; colors set in stylesheets are not analysed",
          measuredPairs,
        },
      });
    }

    if (unresolved.length > 0) {
      const reasons: Partial<Record<UnresolvedReason, number>> = {};
      for (const u of unresolved) reasons[u.reason] = (reasons[u.reason] ?? 0) + 1;
      const why = (Object.keys(reasons) as UnresolvedReason[])
        .map((r) => UNRESOLVED_REASON_TEXT[r])
        .join("; ");
      const ids = [...new Set(unresolved.map((u) => u.id))];
      checks.push({
        name: "color-contrast-unresolved",
        status: "info",
        message: `${unresolved.length} inline-colored text element(s) could not be measured: ${why}`,
        items: ids.slice(0, 10).map((id) => ({ id })),
        details: {
          inconclusive: true,
          unresolved: unresolved.length,
          reasons,
          ...(ids.length > 10 ? { additional: ids.length - 10 } : {}),
        },
        value: "Check these with browser DevTools or the WebAIM Contrast Checker",
      });
    }

    return { checks };
  },
};

const WHITE: Rgb = [255, 255, 255];
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "currentcolor"]);

type UnresolvedReason = "stylesheet" | "image" | "color";

const UNRESOLVED_REASON_TEXT: Record<UnresolvedReason, string> = {
  stylesheet: "the background is set by a stylesheet the audit does not read",
  image: "a background image or gradient sits behind the text",
  color: "the color is transparent, translucent or not a plain color value",
};

type Background =
  | { kind: "none" }
  | { kind: "color"; rgb: Rgb; raw: string }
  | { kind: "unresolved"; reason: UnresolvedReason };

type ResolvedBackground = Exclude<Background, { kind: "none" }>;

const NO_BACKGROUND: Background = { kind: "none" };

/**
 * What a list of declarations (one element's inline style, or the rules that
 * target one element) says about the background behind its text: nothing, one
 * opaque color, or something that cannot be resolved. The `background`
 * shorthand counts only when its whole value is one color; any other
 * shorthand, and any `background-image` other than `none`, leaves the color
 * behind the text unknown.
 */
function backgroundOf(declarations: Declaration[]): Background {
  const background = winner(
    declarations.filter((d) => d.property === "background" || d.property === "background-color")
  );
  const image = winner(
    declarations.filter((d) => d.property === "background" || d.property === "background-image")
  );
  if (!background && !image) return NO_BACKGROUND;
  // A one-color `background` shorthand resets the image to none; any other
  // shorthand may set one.
  if (image) {
    const noImage =
      image.property === "background-image"
        ? image.value.toLowerCase() === "none"
        : parseColor(image.value) !== null;
    if (!noImage) return { kind: "unresolved", reason: "image" };
  }
  if (!background) return NO_BACKGROUND;
  const rgb = parseColor(background.value);
  return rgb
    ? { kind: "color", rgb, raw: background.value }
    : { kind: "unresolved", reason: "color" };
}

/**
 * Background of the `html`/`body`/`:root` rules in the page's `<style>` blocks.
 * Only a selector that is exactly one of those three counts, and an at-rule body
 * (`@media`, `@font-face`) is skipped. Body wins over html, as the canvas shows
 * through only where the body has none. One linear pass: the blocks are
 * site-controlled and can hold hundreds of KB of base64.
 */
/** Selectors with a background kept per stylesheet (#1756); past this the list says "more existed". */
const MAX_BACKGROUND_SELECTORS = 200;

function styleBlockRules(css: string): {
  html: Declaration[];
  body: Declaration[];
  otherBackground: boolean;
  /** An at-rule (`@media`, `@supports`) sets the background of `html`/`body`/`:root`: it can override the plain rule. */
  atRuleRootBackground: boolean;
  /** The selectors, other than html/body/:root, whose rule sets a background (inside an at-rule too), capped. */
  otherSelectors: string[];
  /** More than {@link MAX_BACKGROUND_SELECTORS} such selectors existed: the list is not all of them. */
  otherSelectorsTruncated: boolean;
} {
  const otherSelectors: string[] = [];
  let otherSelectorsTruncated = false;
  const html: Declaration[] = [];
  const body: Declaration[] = [];
  // A background set by any other selector (or inside an at-rule) can sit behind
  // the text, so the page-level answer is no longer provable.
  let otherBackground = false;
  let atRuleRootBackground = false;
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      const ch = css[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    const selector = css.slice(i, open).trim();
    const block = css.slice(open + 1, depth === 0 ? j - 1 : j);
    i = j;
    if (selector.startsWith("@")) {
      if (/background/i.test(block)) otherBackground = true;
      if (/background/i.test(block) && !/^@(font-face|keyframes|-webkit-keyframes|property)\b/i.test(selector) && depth === 0) {
        const inner = styleBlockRules(block);
        for (const s of inner.otherSelectors) {
          if (otherSelectors.length >= MAX_BACKGROUND_SELECTORS) otherSelectorsTruncated = true;
          else otherSelectors.push(s);
        }
        if (inner.otherSelectorsTruncated) otherSelectorsTruncated = true;
      }
      if (!/^@(font-face|keyframes|-webkit-keyframes|property)\b/i.test(selector) && depth === 0) {
        const inner = styleBlockRules(block);
        const sets = (d: Declaration[]): boolean =>
          d.some((x) => /^background(-color|-image)?$/.test(x.property));
        if (sets(inner.html) || sets(inner.body) || inner.atRuleRootBackground) atRuleRootBackground = true;
      }
      continue;
    }
    for (const part of selector.split(",")) {
      const target = part.trim().toLowerCase();
      if (target === "body") body.push(...parseDeclarations(block));
      else if (target === "html" || target === ":root") html.push(...parseDeclarations(block));
      else if (/background/i.test(block)) {
        otherBackground = true;
        if (part.trim()) {
          if (otherSelectors.length >= MAX_BACKGROUND_SELECTORS) otherSelectorsTruncated = true;
          else otherSelectors.push(part.trim());
        }
      }
    }
  }
  return { html, body, otherBackground, atRuleRootBackground, otherSelectors, otherSelectorsTruncated };
}

function stripCssComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const start = css.indexOf("/*", i);
    if (start < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, start) + " ";
    const end = css.indexOf("*/", start + 2);
    if (end < 0) break;
    i = end + 2;
  }
  return out;
}

/**
 * What a linked stylesheet's own text says about the page background (#1756). Only the `html`, `body` and
 * `:root` rules count: a background on any other selector is not read, so a container that paints over the
 * body is not seen. A background image or gradient on those rules, an `@import`, or an at-rule that sets
 * their background (a `prefers-color-scheme` override) is unresolved, never a color.
 */
export function stylesheetBackgroundOf(css: string): StylesheetBackground {
  const text = stripCssComments(css);
  if (/@import/i.test(text)) return { kind: "unresolved" };
  const rules = styleBlockRules(text);
  if (rules.atRuleRootBackground) return { kind: "unresolved" };
  const found = [backgroundOf(rules.body), backgroundOf(rules.html)].find((b) => b.kind !== "none");
  if (!found) return { kind: "none" };
  if (found.kind === "color") return { kind: "color", value: found.raw };
  return { kind: "unresolved" };
}

/**
 * The selectors, other than `html`, `body` and `:root`, that a stylesheet gives a background (#1756): a
 * container such as `.hero { background: #111 }` can paint under text whose own color is light. The
 * resolver does not read their colors; it treats text that sits inside a match as not measurable.
 */
export function stylesheetBackgroundSelectorsOf(css: string): { selectors: string[]; truncated: boolean } {
  const rules = styleBlockRules(stripCssComments(css));
  return { selectors: rules.otherSelectors, truncated: rules.otherSelectorsTruncated };
}

function createBackgroundResolver(
  doc: Document,
  pageUrl: string,
  stylesheets: StylesheetBackgroundData[] | undefined
): { resolve(el: Element): ResolvedBackground } {
  const memo = new Map<Element, ResolvedBackground>();
  let page: ResolvedBackground | null = null;
  // Backgrounds a linked stylesheet gives other selectors (#1756): its html/body rule is read, a container
  // painting under the text is not, so text inside a match is unresolved rather than measured against the page.
  const guard: { selectors: string[]; all: boolean } = { selectors: [], all: false };
  const insideGuardedSelector = (el: Element): boolean => {
    if (guard.all) return true;
    if (guard.selectors.length === 0) return false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      for (const selector of guard.selectors) {
        try {
          if (node.matches(selector)) return true;
        } catch {
          // A selector the DOM cannot evaluate could match: not provable, so not measured.
          return true;
        }
      }
    }
    return false;
  };

  // What is behind everything the element's ancestors leave open. Computed once,
  // and only when an inline-colored element needs it.
  const pageBackground = (): ResolvedBackground => {
    if (page) return page;
    const sheets = Array.from(doc.querySelectorAll("style"), (el) =>
      stripCssComments(el.textContent || "")
    ).join("\n");
    // A stylesheet in <noscript> never loads for a browser running scripts.
    const linkedUrls: string[] = [];
    let linkedUnknown = false;
    for (const link of querySelectorAllOutsideNoscript(doc, 'link[rel~="stylesheet" i]')) {
      const href = link.getAttribute("href");
      try {
        if (!href) throw new Error("no href");
        linkedUrls.push(new URL(href, pageUrl).toString());
      } catch {
        linkedUnknown = true;
      }
    }
    const hasImport = /@import/i.test(sheets);
    const setsBackground = /background/i.test(sheets);
    const rules = styleBlockRules(sheets);
    const fromStyle = [backgroundOf(rules.body), backgroundOf(rules.html)].find(
      (b): b is ResolvedBackground => b.kind !== "none"
    );
    // Another rule's background could override or sit under what an html/body
    // rule says, so only a page whose sole background is that rule is resolved
    // from it.
    if (hasImport || rules.otherBackground || linkedUnknown) {
      return (page = { kind: "unresolved", reason: "stylesheet" });
    }
    // A linked stylesheet is read only when the asset phase fetched it and it
    // said something provable. One that failed to load, or sits on another
    // site, leaves the pair unresolved: white is never assumed (#1756).
    if (fromStyle?.kind === "unresolved") return (page = fromStyle);
    const sources: Array<{ kind: "color"; rgb: Rgb; raw: string }> = [];
    if (fromStyle) sources.push(fromStyle);
    const byUrl = new Map((stylesheets ?? []).map((s) => [s.url, s.background]));
    const dataByUrl = new Map((stylesheets ?? []).map((s) => [s.url, s]));
    for (const url of new Set(linkedUrls)) {
      const data = dataByUrl.get(url);
      if (data?.selectors) guard.selectors.push(...data.selectors);
      if (data?.selectorsTruncated) guard.all = true;
      const read = byUrl.get(url);
      if (!read || read.kind === "unresolved") {
        return (page = { kind: "unresolved", reason: "stylesheet" });
      }
      if (read.kind === "none") continue;
      const rgb = parseColor(read.value);
      if (!rgb) return (page = { kind: "unresolved", reason: "stylesheet" });
      sources.push({ kind: "color", rgb, raw: read.value });
    }
    // Two sources that name different colors depend on the cascade order, which
    // this rule does not model.
    const first = sources[0];
    if (first && sources.some((c) => c.rgb.join() !== first.rgb.join())) {
      return (page = { kind: "unresolved", reason: "stylesheet" });
    }
    if (first) page = first;
    else if (setsBackground) page = { kind: "unresolved", reason: "stylesheet" };
    else page = { kind: "color", rgb: WHITE, raw: "white" };
    return page;
  };

  const own = (el: Element): Background => {
    // A legacy `bgcolor` attribute sets a background this rule does not read.
    if (el.hasAttribute("bgcolor")) return { kind: "unresolved", reason: "color" };
    const style = el.getAttribute("style");
    return style ? backgroundOf(parseDeclarations(style)) : NO_BACKGROUND;
  };

  return {
    resolve(el: Element): ResolvedBackground {
      // Walk up to the first ancestor with an answer, then record it for the
      // whole chain, so siblings share the walk.
      const chain: Element[] = [];
      let node: Element | null = el;
      let found: ResolvedBackground | undefined;
      while (node) {
        const known = memo.get(node);
        if (known) {
          found = known;
          break;
        }
        const state = own(node);
        if (state.kind !== "none") {
          memo.set(node, state);
          found = state;
          break;
        }
        chain.push(node);
        node = node.parentElement;
      }
      let result = found ?? pageBackground();
      // The page background was the answer: a linked stylesheet's container rule may sit under the text.
      if (!found && result.kind === "color" && insideGuardedSelector(el)) {
        result = { kind: "unresolved", reason: "stylesheet" };
      }
      for (const visited of chain) memo.set(visited, result);
      return result;
    },
  };
}

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
