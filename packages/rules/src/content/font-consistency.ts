// content/font-consistency - font sprawl and rogue families across the site
//
// perf/font-delivery and perf/font-loading are about what fonts COST (blocking requests, swap).
// This rule is about whether the site uses ONE coherent set of families: too many distinct
// families site-wide, a family that one page alone uses, and an @font-face family nothing names.
//
// Coverage is partial by design today. The source is `<style>` blocks and `style=` attributes in
// each page's HTML; linked stylesheet bodies are not fetched, so a family declared only in an
// external stylesheet is invisible. Every non-skipped result therefore says "inline styles only"
// and carries `details.coverage = "inline-only"` instead of a bare clean pass.
//
// Only the PRIMARY family of each `font-family` declaration (the first name in the stack) counts:
// fallbacks such as Arial or Helvetica would otherwise inflate every site's total. Generic
// keywords, system-font stacks, `var()` values and icon fonts are not counted.
//
// Both paths feed ONE accumulator and ONE check builder: the streaming path reads the page-time
// signal (`ctx.collectedSignals`), the legacy path derives it with the same extractor.

import { z } from "zod";
import type { Document } from "linkedom";
import type { CheckItem } from "@squirrelscan/core-contracts";
import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** Crawl-wide page floor: below this there is no site norm to judge against. */
export const FONT_MIN_PAGES = 10;

/** Pages that must declare a font family before "used on one page only" means anything. */
export const FONT_MIN_PAGES_WITH_FONTS = 5;

/** Default ceiling on distinct primary families site-wide. */
export const FONT_DEFAULT_MAX_FAMILIES = 4;

const MAX_STYLE_CHARS = 200_000;
const MAX_FAMILIES_PER_PAGE = 50;
const MAX_FACES_PER_PAGE = 50;
const MAX_ITEMS = 10;
const CHECK_NAME = "font-consistency";
const COVERAGE_NOTE = "inline styles only; linked stylesheets are not read";

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
  "-apple-system",
  "blinkmacsystemfont",
]);

/** Icon and symbol fonts are glyph sets, not typography: they never count as text families. */
const ICON_FONT =
  /icon|fontawesome|font awesome|glyph|symbols|dashicons|ionicons|feather|fa-|entypo|linearicons|typicons|octicons|codicon/i;

export const optionsSchema = z.object({
  max_families: z
    .number()
    .int()
    .min(1)
    .default(FONT_DEFAULT_MAX_FAMILIES)
    .describe("Most distinct primary font families the site may use before the rule warns"),
});

/** One `@font-face` rule as declared in an inline style. */
export interface FontFaceDecl {
  family: string;
  weight: string;
  style: string;
}

/** What one page's inline styles say about fonts. All strings lowercase except face labels. */
export interface FontUsageSignal {
  /** Primary family of each distinct `font-family` declaration (icon fonts and generics left out). */
  families: string[];
  /** Every name in any font-family stack, so a fallback use still counts as a reference. */
  referenced: string[];
  /** `@font-face` rules declared inline. */
  faces: FontFaceDecl[];
  /** The page links at least one stylesheet whose body was not read. */
  linkedStylesheets: boolean;
}

export const EMPTY_FONT_USAGE: FontUsageSignal = {
  families: [],
  referenced: [],
  faces: [],
  linkedStylesheets: false,
};

/** CSS with comments removed; indexOf-based so an unclosed comment is linear, not quadratic. */
function stripComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("/*", i);
    if (open === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, open);
    const close = css.indexOf("*/", open + 2);
    if (close === -1) break;
    i = close + 2;
  }
  return out;
}

/** Split a font-family value on top-level commas, honouring quotes and parentheses. */
function splitStack(value: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote = "";
  let depth = 0;
  for (const ch of value) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function cleanName(raw: string): string {
  return raw
    .replace(/!important/i, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isCountable(name: string): boolean {
  return (
    name !== "" &&
    !GENERIC.has(name) &&
    !name.includes("var(") &&
    !name.includes("(") &&
    !ICON_FONT.test(name)
  );
}

const FONT_FACE_BLOCK = /@font-face\s*\{([^}]*)\}/gi;
const FONT_FAMILY_DECL = /(?:^|[;{\s])font-family\s*:\s*([^;}]+)/gi;

function declValue(block: string, prop: string): string | null {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, "i").exec(block);
  return m
    ? m[1]!
        .replace(/!important/i, "")
        .trim()
        .toLowerCase()
    : null;
}

interface Acc {
  families: Set<string>;
  referenced: Set<string>;
  faces: Map<string, FontFaceDecl>;
}

function scanCss(raw: string, acc: Acc): void {
  const css = stripComments(raw.length > MAX_STYLE_CHARS ? raw.slice(0, MAX_STYLE_CHARS) : raw);
  for (const m of css.matchAll(FONT_FACE_BLOCK)) {
    if (acc.faces.size >= MAX_FACES_PER_PAGE) break;
    const body = m[1] ?? "";
    const family = cleanName(declValue(body, "font-family") ?? "");
    if (!family || ICON_FONT.test(family)) continue;
    const weight = declValue(body, "font-weight") ?? "400";
    const style = declValue(body, "font-style") ?? "normal";
    acc.faces.set(`${family}|${weight}|${style}`, { family, weight, style });
  }
  // The @font-face bodies' own font-family is a declaration of the face, not a use of it.
  const usage = css.replace(FONT_FACE_BLOCK, " ");
  for (const m of usage.matchAll(FONT_FAMILY_DECL)) {
    const names = splitStack(m[1] ?? "").map(cleanName);
    for (const n of names)
      if (n && acc.referenced.size < MAX_FAMILIES_PER_PAGE * 4) acc.referenced.add(n);
    const primary = names[0];
    if (primary && isCountable(primary) && acc.families.size < MAX_FAMILIES_PER_PAGE)
      acc.families.add(primary);
  }
}

/** The page's font signal from its live document. Shared by the collector and the legacy path. */
export function extractFontUsage(doc: Document | null | undefined): FontUsageSignal {
  if (!doc) return { ...EMPTY_FONT_USAGE };
  const acc: Acc = { families: new Set(), referenced: new Set(), faces: new Map() };
  for (const style of querySelectorAllOutsideNoscript(doc, "style")) {
    scanCss(style.textContent || "", acc);
  }
  for (const el of querySelectorAllOutsideNoscript(doc, "[style]")) {
    const attr = el.getAttribute("style") || "";
    if (/font-family/i.test(attr)) scanCss(attr, acc);
  }
  let linked = false;
  for (const link of querySelectorAllOutsideNoscript(doc, "link[href]")) {
    if ((link.getAttribute("rel") || "").toLowerCase().split(/\s+/).includes("stylesheet")) {
      linked = true;
      break;
    }
  }
  return {
    families: [...acc.families],
    referenced: [...acc.referenced],
    faces: [...acc.faces.values()],
    linkedStylesheets: linked,
  };
}

interface FontRollup {
  pageCount: number;
  pagesWithFonts: number;
  pagesWithLinkedCss: number;
  /** family -> urls that declare it as a primary family */
  familyPages: Map<string, string[]>;
  referenced: Set<string>;
  /** family -> distinct weight/style labels loaded */
  faces: Map<string, Set<string>>;
}

function emptyRollup(): FontRollup {
  return {
    pageCount: 0,
    pagesWithFonts: 0,
    pagesWithLinkedCss: 0,
    familyPages: new Map(),
    referenced: new Set(),
    faces: new Map(),
  };
}

function accumulate(rollup: FontRollup, url: string, sig: FontUsageSignal): void {
  rollup.pageCount += 1;
  if (sig.linkedStylesheets) rollup.pagesWithLinkedCss += 1;
  if (sig.families.length > 0 || sig.faces.length > 0) rollup.pagesWithFonts += 1;
  for (const f of sig.families) {
    const urls = rollup.familyPages.get(f);
    if (urls) urls.push(url);
    else rollup.familyPages.set(f, [url]);
  }
  for (const r of sig.referenced) rollup.referenced.add(r);
  for (const face of sig.faces) {
    const labels = rollup.faces.get(face.family) ?? new Set<string>();
    labels.add(`${face.weight}${face.style === "normal" ? "" : ` ${face.style}`}`);
    rollup.faces.set(face.family, labels);
  }
}

function skip(message: string, details?: Record<string, unknown>): CheckResult {
  return { name: CHECK_NAME, status: "skipped", message, ...(details ? { details } : {}) };
}

/** Build the checks. `sitePageCount` is the crawl's page count (the norm floor reads it). */
export function buildChecks(
  rollup: FontRollup,
  sitePageCount: number,
  maxFamilies: number,
): CheckResult[] {
  if (sitePageCount < FONT_MIN_PAGES) {
    return [
      skip(
        `Only ${sitePageCount} page(s) crawled; ${FONT_MIN_PAGES} needed to judge font consistency`,
      ),
    ];
  }
  if (rollup.pagesWithFonts === 0) {
    return [
      skip(
        "No font declarations found in inline styles; linked stylesheets are not read, so this is not a clean pass",
        { coverage: "inline-only", pagesWithLinkedStylesheets: rollup.pagesWithLinkedCss },
      ),
    ];
  }

  const families = [...rollup.familyPages.keys()].sort();
  const details: Record<string, unknown> = {
    coverage: "inline-only",
    pagesWithFontDeclarations: rollup.pagesWithFonts,
    pagesWithLinkedStylesheets: rollup.pagesWithLinkedCss,
    families: families.length,
    maxFamilies,
  };
  const checks: CheckResult[] = [];

  if (families.length > maxFamilies) {
    const items: CheckItem[] = families.slice(0, MAX_ITEMS).map((f) => ({
      id: f,
      label: `${f}: used on ${rollup.familyPages.get(f)!.length} page(s)`,
      sourcePages: rollup.familyPages.get(f)!.slice(0, 5),
    }));
    checks.push({
      name: "font-sprawl",
      status: families.length >= maxFamilies * 2 ? "fail" : "warn",
      message: `${families.length} distinct font families in use (limit ${maxFamilies}) (${COVERAGE_NOTE})`,
      value: families.length,
      items,
      details,
    });
  }

  // A family used on exactly one page is only "rogue" once enough pages declare fonts to form a norm.
  if (rollup.pagesWithFonts >= FONT_MIN_PAGES_WITH_FONTS) {
    const rogue = families.filter((f) => rollup.familyPages.get(f)!.length === 1);
    if (rogue.length > 0) {
      checks.push({
        name: "rogue-font-family",
        status: "warn",
        message: `${rogue.length} font family(ies) used on a single page and nowhere else (${COVERAGE_NOTE})`,
        value: rogue.length,
        items: rogue.slice(0, MAX_ITEMS).map((f) => ({
          id: f,
          label: `${f}: only on ${rollup.familyPages.get(f)![0]}`,
          sourcePages: [rollup.familyPages.get(f)![0]!],
        })),
        details,
      });
    }
  }

  const unreferenced = [...rollup.faces.keys()].filter((f) => !rollup.referenced.has(f)).sort();
  if (unreferenced.length > 0) {
    checks.push({
      name: "unreferenced-font-face",
      status: "info",
      message: `${unreferenced.length} @font-face family(ies) loaded but never named in a font-family declaration (${COVERAGE_NOTE}; one may be used by a linked stylesheet)`,
      value: unreferenced.length,
      items: unreferenced.slice(0, MAX_ITEMS).map((f) => ({
        id: f,
        label: `${f}: loads ${[...rollup.faces.get(f)!].sort().join(", ")}`,
      })),
      details,
    });
  }

  if (checks.length === 0) {
    checks.push({
      name: CHECK_NAME,
      status: "pass",
      message: `${families.length} font family(ies) in use, within the limit of ${maxFamilies}, none on a single page (${COVERAGE_NOTE})`,
      value: families.length,
      details,
    });
  }
  return checks;
}

export const fontConsistencyRule: Rule = {
  meta: {
    id: "content/font-consistency",
    name: "Font Consistency",
    description:
      "Finds font sprawl, families used on one page only, and @font-face families nothing uses",
    solution:
      "Too many font families make a site look unfinished and cost bytes. Pick one family for text, optionally one for headings and one for code, and remove the rest. A family used on a single page usually came from a pasted snippet or a one-off template: switch it to a site font. An @font-face family that no font-family names can be deleted along with its files. This rule reads inline styles only, so check linked stylesheets by hand before removing anything. Icon fonts are not counted.",
    category: "content",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 2,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const rollup = emptyRollup();
    let pageCount: number;
    if (ctx.collectedSignals) {
      for (const s of ctx.collectedSignals.pages)
        accumulate(rollup, s.url, s.fontUsage ?? EMPTY_FONT_USAGE);
      pageCount = ctx.siteQuery?.pageCount() ?? rollup.pageCount;
    } else {
      const pages = ctx.site?.pages ?? [];
      if (pages.length === 0) return { checks: [skip("No pages available for analysis")] };
      for (const p of pages) accumulate(rollup, p.url, extractFontUsage(p.parsed?.document));
      pageCount = rollup.pageCount;
    }
    return { checks: buildChecks(rollup, pageCount, opts.max_families) };
  },
};
