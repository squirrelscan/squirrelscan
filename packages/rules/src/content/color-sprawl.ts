// content/color-sprawl - near-duplicate colors and palette outliers across the site
//
// Collects color literals (hex, rgb(), hsl(), oklch(), named) from `<style>` blocks and `style=`
// attributes, converts each to OKLab and clusters by perceptual distance. A cluster holding more
// than one distinct literal is a near-duplicate ("31 grays, 9 visually indistinguishable"). A color
// cluster that exactly one page uses is a palette outlier.
//
// Custom properties are attributed before counting: a literal on the right-hand side of a
// `--token: <color>` definition is the design system DEFINING its scale, not using it, so it never
// enters the count. Only literals in ordinary declarations do, and `var(--x)` references are
// counted separately. A token-driven site therefore scores well however many tokens it defines.
//
// Near-duplicates are counted from inline styles only. Linked same-site stylesheet bodies the asset
// phase read (`ctx.site.stylesheets`, repo#1374) define the palette: a color a read stylesheet uses or
// defines is never a one-page outlier, however few pages carry it inline. With no stylesheet read the
// result says "inline styles only" and carries `details.coverage = "inline-only"`.
// Alpha is ignored: rgba(0,0,0,.5) and #000 are the same hue and are clustered as one color.
//
// Both paths feed ONE accumulator and ONE check builder: the streaming path reads the page-time
// signal (`ctx.collectedSignals`), the legacy path derives it with the same extractor.

import type { CheckItem } from "@squirrelscan/core-contracts";
import type { Document } from "linkedom";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";
import { z } from "zod";

import type {
  CheckResult,
  Rule,
  RuleContext,
  RuleResult,
  StylesheetContentData,
} from "../types";

/** Crawl-wide page floor: below this there is no site norm to judge against. */
export const COLOR_MIN_PAGES = 10;

/** Pages that must declare colors before "used on one page only" means anything. */
export const COLOR_MIN_PAGES_WITH_COLORS = 5;

/** Default count of near-duplicate colors (literals beyond one per cluster) before the rule warns. */
export const COLOR_DEFAULT_MAX_REDUNDANT = 6;

/** OKLab distance under which two colors read as the same color (about one just-noticeable difference). */
export const COLOR_CLUSTER_DISTANCE = 0.02;

/** OKLCH chroma under which a color counts as a gray. */
const GRAY_CHROMA = 0.03;
/** OKLCH chroma over which a lone one-page color is worth calling an outlier. */
const OUTLIER_CHROMA = 0.05;

const MAX_STYLE_CHARS = 200_000;
const MAX_COLORS_PER_PAGE = 200;
const MAX_ITEMS = 10;
const CHECK_NAME = "color-sprawl";
const OUTLIER_CHECK_NAME = "palette-outlier";
/** Most distinct colors kept from all read stylesheets together (the palette outliers are checked against). */
const MAX_STYLESHEET_PALETTE = 2_000;

export const optionsSchema = z.object({
  max_redundant: z
    .number()
    .int()
    .min(1)
    .default(COLOR_DEFAULT_MAX_REDUNDANT)
    .describe(
      "Most near-duplicate colors (beyond one per cluster) the site may carry before the rule warns"
    ),
});

/** What one page's inline styles say about color. */
export interface ColorUsageSignal {
  /** Distinct `#rrggbb` colors used in ordinary declarations (token definitions excluded). */
  colors: string[];
  /** Distinct colors defined on the right-hand side of `--custom-property` declarations. */
  tokenColors: number;
  /** `var(--x)` references found in color-bearing declarations. */
  varRefs: number;
  /** The page links at least one stylesheet whose body was not read. */
  linkedStylesheets: boolean;
}

export const EMPTY_COLOR_USAGE: ColorUsageSignal = {
  colors: [],
  tokenColors: 0,
  varRefs: 0,
  linkedStylesheets: false,
};

const NAMED: Record<string, string> = {
  aliceblue: "f0f8ff",
  antiquewhite: "faebd7",
  aqua: "00ffff",
  aquamarine: "7fffd4",
  azure: "f0ffff",
  beige: "f5f5dc",
  bisque: "ffe4c4",
  black: "000000",
  blanchedalmond: "ffebcd",
  blue: "0000ff",
  blueviolet: "8a2be2",
  brown: "a52a2a",
  burlywood: "deb887",
  cadetblue: "5f9ea0",
  chartreuse: "7fff00",
  chocolate: "d2691e",
  coral: "ff7f50",
  cornflowerblue: "6495ed",
  cornsilk: "fff8dc",
  crimson: "dc143c",
  cyan: "00ffff",
  darkblue: "00008b",
  darkcyan: "008b8b",
  darkgoldenrod: "b8860b",
  darkgray: "a9a9a9",
  darkgreen: "006400",
  darkgrey: "a9a9a9",
  darkkhaki: "bdb76b",
  darkmagenta: "8b008b",
  darkolivegreen: "556b2f",
  darkorange: "ff8c00",
  darkorchid: "9932cc",
  darkred: "8b0000",
  darksalmon: "e9967a",
  darkseagreen: "8fbc8f",
  darkslateblue: "483d8b",
  darkslategray: "2f4f4f",
  darkslategrey: "2f4f4f",
  darkturquoise: "00ced1",
  darkviolet: "9400d3",
  deeppink: "ff1493",
  deepskyblue: "00bfff",
  dimgray: "696969",
  dimgrey: "696969",
  dodgerblue: "1e90ff",
  firebrick: "b22222",
  floralwhite: "fffaf0",
  forestgreen: "228b22",
  fuchsia: "ff00ff",
  gainsboro: "dcdcdc",
  ghostwhite: "f8f8ff",
  gold: "ffd700",
  goldenrod: "daa520",
  gray: "808080",
  green: "008000",
  greenyellow: "adff2f",
  grey: "808080",
  honeydew: "f0fff0",
  hotpink: "ff69b4",
  indianred: "cd5c5c",
  indigo: "4b0082",
  ivory: "fffff0",
  khaki: "f0e68c",
  lavender: "e6e6fa",
  lavenderblush: "fff0f5",
  lawngreen: "7cfc00",
  lemonchiffon: "fffacd",
  lightblue: "add8e6",
  lightcoral: "f08080",
  lightcyan: "e0ffff",
  lightgoldenrodyellow: "fafad2",
  lightgray: "d3d3d3",
  lightgreen: "90ee90",
  lightgrey: "d3d3d3",
  lightpink: "ffb6c1",
  lightsalmon: "ffa07a",
  lightseagreen: "20b2aa",
  lightskyblue: "87cefa",
  lightslategray: "778899",
  lightslategrey: "778899",
  lightsteelblue: "b0c4de",
  lightyellow: "ffffe0",
  lime: "00ff00",
  limegreen: "32cd32",
  linen: "faf0e6",
  magenta: "ff00ff",
  maroon: "800000",
  mediumaquamarine: "66cdaa",
  mediumblue: "0000cd",
  mediumorchid: "ba55d3",
  mediumpurple: "9370db",
  mediumseagreen: "3cb371",
  mediumslateblue: "7b68ee",
  mediumspringgreen: "00fa9a",
  mediumturquoise: "48d1cc",
  mediumvioletred: "c71585",
  midnightblue: "191970",
  mintcream: "f5fffa",
  mistyrose: "ffe4e1",
  moccasin: "ffe4b5",
  navajowhite: "ffdead",
  navy: "000080",
  oldlace: "fdf5e6",
  olive: "808000",
  olivedrab: "6b8e23",
  orange: "ffa500",
  orangered: "ff4500",
  orchid: "da70d6",
  palegoldenrod: "eee8aa",
  palegreen: "98fb98",
  paleturquoise: "afeeee",
  palevioletred: "db7093",
  papayawhip: "ffefd5",
  peachpuff: "ffdab9",
  peru: "cd853f",
  pink: "ffc0cb",
  plum: "dda0dd",
  powderblue: "b0e0e6",
  purple: "800080",
  rebeccapurple: "663399",
  red: "ff0000",
  rosybrown: "bc8f8f",
  royalblue: "4169e1",
  saddlebrown: "8b4513",
  salmon: "fa8072",
  sandybrown: "f4a460",
  seagreen: "2e8b57",
  seashell: "fff5ee",
  sienna: "a0522d",
  silver: "c0c0c0",
  skyblue: "87ceeb",
  slateblue: "6a5acd",
  slategray: "708090",
  slategrey: "708090",
  snow: "fffafa",
  springgreen: "00ff7f",
  steelblue: "4682b4",
  tan: "d2b48c",
  teal: "008080",
  thistle: "d8bfd8",
  tomato: "ff6347",
  turquoise: "40e0d0",
  violet: "ee82ee",
  wheat: "f5deb3",
  white: "ffffff",
  whitesmoke: "f5f5f5",
  yellow: "ffff00",
  yellowgreen: "9acd32",
};

type Rgb = [number, number, number];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const toHex = (rgb: Rgb) =>
  "#" +
  rgb
    .map((c) =>
      Math.round(clamp01(c) * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("");

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

/** sRGB (0..1 channels) to OKLab. */
export function rgbToOklab([r, g, b]: Rgb): [number, number, number] {
  const lr = srgbToLinear(r),
    lg = srgbToLinear(g),
    lb = srgbToLinear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  );
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(
      clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
    ),
    linearToSrgb(
      clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
    ),
    linearToSrgb(
      clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    ),
  ];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    const x = (t + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)];
}

/** Parse one numeric channel: "50%", "0.5", "120deg", "none". `pctScale` is the value 100% maps to. */
function num(token: string, pctScale: number): number | null {
  const t = token.trim().toLowerCase();
  if (t === "none") return 0;
  const m =
    /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|rad|grad|turn)?$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  switch (m[2]) {
    case "%":
      return (v / 100) * pctScale;
    case "turn":
      return v * 360;
    case "rad":
      return (v * 180) / Math.PI;
    case "grad":
      return v * 0.9;
    default:
      return v;
  }
}

/** Split function arguments on commas, spaces and the alpha slash. Returns channels and alpha. */
function fnArgs(inner: string): { chans: string[]; alpha: string | null } {
  const [body = "", alpha = null] = inner.split("/");
  return {
    chans: body.split(/[\s,]+/).filter(Boolean),
    alpha: alpha === null ? null : alpha.trim(),
  };
}

/** Parse a CSS color literal to a `#rrggbb` string, or null when it is not one (or fully transparent). */
export function parseColor(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v.startsWith("#")) {
    const h = v.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && h[3] === "0") return null;
      return "#" + h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
    }
    if (h.length === 6 || h.length === 8) {
      if (h.length === 8 && h.slice(6) === "00") return null;
      return "#" + h.slice(0, 6);
    }
    return null;
  }
  const fn = /^(rgba?|hsla?|oklch|oklab)\(\s*([^()]*)\)$/.exec(v);
  if (fn) {
    const { chans, alpha } = fnArgs(fn[2]!);
    const alphaChan = alpha ?? (chans.length === 4 ? chans[3]! : null);
    if (alphaChan !== null) {
      const a = num(alphaChan, 1);
      if (a === null) return null;
      if (a <= 0) return null;
    }
    if (chans.length < 3) return null;
    const [c1, c2, c3] = chans as [string, string, string];
    switch (fn[1]) {
      case "rgb":
      case "rgba": {
        const r = num(c1, 255),
          g = num(c2, 255),
          b = num(c3, 255);
        if (r === null || g === null || b === null) return null;
        return toHex([r / 255, g / 255, b / 255]);
      }
      case "hsl":
      case "hsla": {
        const h = num(c1, 360),
          s = num(c2, 1),
          l = num(c3, 1);
        if (h === null || s === null || l === null) return null;
        // Bare numbers for s/l in legacy syntax are written with %, so they arrive already scaled.
        return toHex(hslToRgb(h, clamp01(s), clamp01(l)));
      }
      case "oklch": {
        const L = num(c1, 1),
          C = num(c2, 0.4),
          h = num(c3, 360);
        if (L === null || C === null || h === null) return null;
        const rad = (h * Math.PI) / 180;
        return toHex(oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad)));
      }
      default: {
        const L = num(c1, 1),
          a = num(c2, 0.4),
          b = num(c3, 0.4);
        if (L === null || a === null || b === null) return null;
        return toHex(oklabToRgb(L, a, b));
      }
    }
  }
  const named = NAMED[v];
  return named ? "#" + named : null;
}

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

/** Properties whose values are colors. Named colors are only read from these. */
const COLOR_PROP =
  /^(?:color|background|background-color|background-image|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|text-decoration|text-decoration-color|caret-color|accent-color|column-rule(?:-color)?)$/;

// The lookbehind keeps a match from starting mid-name, so `--x1color: red` is never read as `color`.
const DECL = /(?<![\w-])(-{0,2}[a-z][a-z-]*)\s*:\s*([^;{}]+)/gi;
const COLOR_TOKEN =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\([^()]*\)|[a-z]+/gi;

/** Every color literal in one declaration value, `url()` and `var()` bodies excluded (`var(--gray)` is not the color gray). */
function literalsIn(value: string): string[] {
  const out: string[] = [];
  const cleaned = value
    .replace(/(?:url|var)\([^)]*\)/gi, " ")
    .replace(/!important/gi, " ");
  for (const m of cleaned.matchAll(COLOR_TOKEN)) {
    const c = parseColor(m[0]);
    if (c) out.push(c);
  }
  return out;
}

interface Acc {
  colors: Set<string>;
  tokens: Set<string>;
  varRefs: number;
}

function scanCss(
  raw: string,
  acc: Acc,
  maxChars = MAX_STYLE_CHARS,
  maxColors = MAX_COLORS_PER_PAGE
): void {
  const css = stripComments(
    raw.length > maxChars ? raw.slice(0, maxChars) : raw
  );
  for (const m of css.matchAll(DECL)) {
    const prop = m[1]!.toLowerCase();
    const value = m[2] ?? "";
    if (prop.startsWith("--")) continue;
    if (!COLOR_PROP.test(prop)) continue;
    if (/var\(\s*--/i.test(value))
      acc.varRefs += (value.match(/var\(\s*--/gi) ?? []).length;
    for (const c of literalsIn(value)) {
      if (acc.colors.size < maxColors) acc.colors.add(c);
    }
  }
  // Token definitions are read on their own so they can be reported but never counted as use.
  for (const m of css.matchAll(/--[\w-]+\s*:\s*([^;{}]+)/g)) {
    for (const c of literalsIn(m[1] ?? "")) {
      if (acc.tokens.size < maxColors) acc.tokens.add(c);
    }
  }
}

/** The page's color signal from its live document. Shared by the collector and the legacy path. */
export function extractColorUsage(
  doc: Document | null | undefined
): ColorUsageSignal {
  if (!doc) return { ...EMPTY_COLOR_USAGE };
  const acc: Acc = { colors: new Set(), tokens: new Set(), varRefs: 0 };
  for (const style of querySelectorAllOutsideNoscript(doc, "style")) {
    scanCss(style.textContent || "", acc);
  }
  for (const el of querySelectorAllOutsideNoscript(doc, "[style]")) {
    const attr = el.getAttribute("style") || "";
    if (attr) scanCss(attr, acc);
  }
  let linked = false;
  for (const link of querySelectorAllOutsideNoscript(doc, "link[href]")) {
    if (
      (link.getAttribute("rel") || "")
        .toLowerCase()
        .split(/\s+/)
        .includes("stylesheet")
    ) {
      linked = true;
      break;
    }
  }
  return {
    colors: [...acc.colors],
    tokenColors: acc.tokens.size,
    varRefs: acc.varRefs,
    linkedStylesheets: linked,
  };
}

/** What the read linked stylesheets say about the palette. */
export interface StylesheetPalette {
  /** Stylesheets whose body was read. */
  read: number;
  /** Stylesheets requested but not read (cap, size, error, non-CSS). */
  notRead: number;
  /** Distinct `#rrggbb` colors the read stylesheets use or define as tokens. */
  colors: string[];
}

export const EMPTY_STYLESHEET_PALETTE: StylesheetPalette = {
  read: 0,
  notRead: 0,
  colors: [],
};

/** The palette the read stylesheet bodies define: every color they use or define as a token. */
export function stylesheetPalette(
  sheets: readonly StylesheetContentData[] | undefined
): StylesheetPalette {
  if (!sheets || sheets.length === 0) return EMPTY_STYLESHEET_PALETTE;
  const palette = new Set<string>();
  let read = 0;
  for (const sheet of sheets) {
    if (typeof sheet.content !== "string") continue;
    read += 1;
    const acc: Acc = { colors: new Set(), tokens: new Set(), varRefs: 0 };
    scanCss(sheet.content, acc, sheet.content.length, MAX_STYLESHEET_PALETTE);
    for (const c of [...acc.colors, ...acc.tokens]) {
      if (palette.size < MAX_STYLESHEET_PALETTE) palette.add(c);
    }
  }
  return { read, notRead: sheets.length - read, colors: [...palette].sort() };
}

function coverageNote(sheets: StylesheetPalette): string {
  if (sheets.read === 0)
    return "inline styles only; linked stylesheets are not read";
  const unread = sheets.notRead > 0 ? `, ${sheets.notRead} not read` : "";
  return `inline styles counted; ${sheets.read} linked stylesheet(s) read for the palette${unread}`;
}

interface ColorRollup {
  pageCount: number;
  pagesWithColors: number;
  pagesWithLinkedCss: number;
  tokenColors: number;
  varRefs: number;
  /** `#rrggbb` -> urls that use it */
  colorPages: Map<string, string[]>;
}

function emptyRollup(): ColorRollup {
  return {
    pageCount: 0,
    pagesWithColors: 0,
    pagesWithLinkedCss: 0,
    tokenColors: 0,
    varRefs: 0,
    colorPages: new Map(),
  };
}

function accumulate(
  rollup: ColorRollup,
  url: string,
  sig: ColorUsageSignal
): void {
  rollup.pageCount += 1;
  if (sig.linkedStylesheets) rollup.pagesWithLinkedCss += 1;
  if (sig.colors.length > 0 || sig.varRefs > 0) rollup.pagesWithColors += 1;
  rollup.tokenColors += sig.tokenColors;
  rollup.varRefs += sig.varRefs;
  for (const c of sig.colors) {
    const urls = rollup.colorPages.get(c);
    if (urls) urls.push(url);
    else rollup.colorPages.set(c, [url]);
  }
}

interface Cluster {
  /** Most-used member, the cluster's name. */
  seed: string;
  members: string[];
  pages: Set<string>;
  chroma: number;
}

function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}

/** Greedy perceptual clustering, most-used colors first so each cluster is named by its dominant member. */
export function clusterColors(colorPages: Map<string, string[]>): Cluster[] {
  const ordered = [...colorPages.keys()].sort(
    (a, b) =>
      colorPages.get(b)!.length - colorPages.get(a)!.length ||
      a.localeCompare(b)
  );
  const clusters: (Cluster & { lab: [number, number, number] })[] = [];
  for (const hex of ordered) {
    const lab = rgbToOklab(hexToRgb(hex));
    let home: (typeof clusters)[number] | undefined;
    for (const c of clusters) {
      const d = Math.hypot(
        lab[0] - c.lab[0],
        lab[1] - c.lab[1],
        lab[2] - c.lab[2]
      );
      if (d < COLOR_CLUSTER_DISTANCE) {
        home = c;
        break;
      }
    }
    if (!home) {
      home = {
        seed: hex,
        members: [],
        pages: new Set(),
        chroma: Math.hypot(lab[1], lab[2]),
        lab,
      };
      clusters.push(home);
    }
    home.members.push(hex);
    for (const u of colorPages.get(hex)!) home.pages.add(u);
  }
  return clusters;
}

function skip(message: string, details?: Record<string, unknown>): CheckResult {
  return {
    name: CHECK_NAME,
    status: "skipped",
    message,
    ...(details ? { details } : {}),
  };
}

/** Build the checks. `sitePageCount` is the crawl's page count (the norm floor reads it). */
export function buildChecks(
  rollup: ColorRollup,
  sitePageCount: number,
  maxRedundant: number,
  sheets: StylesheetPalette = EMPTY_STYLESHEET_PALETTE
): CheckResult[] {
  const note = coverageNote(sheets);
  const coverage =
    sheets.read > 0 ? "inline-plus-stylesheet-palette" : "inline-only";
  if (sitePageCount < COLOR_MIN_PAGES) {
    return [
      skip(
        `Only ${sitePageCount} page(s) crawled; ${COLOR_MIN_PAGES} needed to judge color consistency`
      ),
    ];
  }
  if (rollup.pagesWithColors === 0) {
    return [
      skip(
        `No color declarations found in inline styles on ${rollup.pageCount} page(s), so this is not a clean pass (${note})`,
        {
          coverage,
          pagesWithLinkedStylesheets: rollup.pagesWithLinkedCss,
          stylesheetsRead: sheets.read,
          stylesheetsNotRead: sheets.notRead,
        }
      ),
    ];
  }

  const clusters = clusterColors(rollup.colorPages);
  const distinct = rollup.colorPages.size;
  const redundant = distinct - clusters.length;
  const grays = clusters.filter((c) => c.chroma < GRAY_CHROMA);
  const grayLiterals = grays.reduce((n, c) => n + c.members.length, 0);
  const grayRedundant = grayLiterals - grays.length;
  const details: Record<string, unknown> = {
    coverage,
    stylesheetsRead: sheets.read,
    stylesheetsNotRead: sheets.notRead,
    stylesheetPaletteColors: sheets.colors.length,
    pagesWithColorDeclarations: rollup.pagesWithColors,
    pagesWithLinkedStylesheets: rollup.pagesWithLinkedCss,
    distinctColors: distinct,
    perceptualClusters: clusters.length,
    nearDuplicates: redundant,
    tokenColorsDefined: rollup.tokenColors,
    varReferences: rollup.varRefs,
    maxRedundant,
  };
  const checks: CheckResult[] = [];

  if (redundant > maxRedundant) {
    const items: CheckItem[] = clusters
      .filter((c) => c.members.length > 1)
      .sort(
        (a, b) =>
          b.members.length - a.members.length || a.seed.localeCompare(b.seed)
      )
      .slice(0, MAX_ITEMS)
      .map((c) => ({
        id: c.seed,
        label: `${c.members.length} visually indistinguishable: ${c.members.slice(0, 6).join(", ")}`,
        sourcePages: [...c.pages].slice(0, 5),
      }));
    const grayPart =
      grayLiterals > 0
        ? `${grayLiterals} gray(s), ${grayRedundant} visually indistinguishable; `
        : "";
    checks.push({
      name: CHECK_NAME,
      status: redundant >= maxRedundant * 3 ? "fail" : "warn",
      message: `${distinct} distinct colors in use, ${redundant} visually indistinguishable from another (${grayPart}limit ${maxRedundant}) (${note})`,
      value: redundant,
      items,
      details,
    });
  }

  // A color used on exactly one page is only an outlier once enough pages declare colors to form a palette,
  // and never when a read stylesheet uses or defines it (or a color indistinguishable from it).
  if (rollup.pagesWithColors >= COLOR_MIN_PAGES_WITH_COLORS) {
    const paletteLabs = sheets.colors.map((hex) => rgbToOklab(hexToRgb(hex)));
    const inStylesheets = (c: Cluster) =>
      c.members.some((hex) => {
        const [L, a, b] = rgbToOklab(hexToRgb(hex));
        return paletteLabs.some(
          (p) =>
            Math.hypot(L - p[0], a - p[1], b - p[2]) < COLOR_CLUSTER_DISTANCE
        );
      });
    const outliers = clusters.filter(
      (c) =>
        c.pages.size === 1 && c.chroma >= OUTLIER_CHROMA && !inStylesheets(c)
    );
    if (outliers.length > 0) {
      const where = sheets.read > 0 ? " and in no read stylesheet" : "";
      checks.push({
        name: OUTLIER_CHECK_NAME,
        status: "warn",
        message: `${outliers.length} color(s) used inline on only one page${where} (${note})`,
        value: outliers.length,
        items: outliers.slice(0, MAX_ITEMS).map((c) => {
          const page = [...c.pages][0]!;
          return {
            id: c.seed,
            label: `${c.seed}: only on ${page}`,
            sourcePages: [page],
          };
        }),
        details,
      });
    }
  }

  if (checks.length === 0) {
    const tokens =
      rollup.varRefs > 0
        ? `, ${rollup.varRefs} var() reference(s) (token definitions are not counted)`
        : "";
    checks.push({
      name: CHECK_NAME,
      status: "pass",
      message: `${distinct} distinct color(s) in use, ${redundant} near-duplicate(s), within the limit of ${maxRedundant}${tokens} (${note})`,
      value: redundant,
      details,
    });
  }
  return checks;
}

export const colorSprawlRule: Rule = {
  meta: {
    id: "content/color-sprawl",
    name: "Color Sprawl",
    description:
      "Finds near-duplicate colors and palette outliers across the site's inline styles",
    solution:
      "Near-identical colors (a gray at #333 on one page and #343434 on another) are almost always drift, not design. Collapse each cluster to one value and define it once as a custom property such as --gray-700, then reference it with var(). A color that only one page uses usually came from a pasted snippet or a one-off template: switch it to a palette color. Token definitions in :root are not counted, so a design system that defines a full scale and references it through var() stays clean. Near-duplicates are counted from inline styles only. Linked same-site stylesheets the audit read define the palette, so a color one of them uses is never called an outlier; check any stylesheet the result reports as not read by hand before deleting anything. Alpha is ignored.",
    category: "content",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 2,
    optionsSchema,
    checks: [
      { name: CHECK_NAME, outcome: "problem" },
      { name: OUTLIER_CHECK_NAME, outcome: "problem" },
      {
        name: CHECK_NAME,
        outcome: "clean",
        clears: [CHECK_NAME, OUTLIER_CHECK_NAME],
      },
      { name: CHECK_NAME, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const rollup = emptyRollup();
    let pageCount: number;
    if (ctx.collectedSignals) {
      for (const s of ctx.collectedSignals.pages)
        accumulate(rollup, s.url, s.colorUsage ?? EMPTY_COLOR_USAGE);
      pageCount = ctx.siteQuery?.pageCount() ?? rollup.pageCount;
    } else {
      const pages = ctx.site?.pages ?? [];
      if (pages.length === 0)
        return { checks: [skip("No pages available for analysis")] };
      for (const p of pages) {
        // A bodiless 4xx/5xx page joins site.pages as EMPTY_PARSED_PAGE (no document). The streaming
        // path's page count (page_features) leaves it out, so this one does too.
        if (!p.parsed?.document) continue;
        accumulate(rollup, p.url, extractColorUsage(p.parsed.document));
      }
      pageCount = rollup.pageCount;
    }
    return {
      checks: buildChecks(
        rollup,
        pageCount,
        opts.max_redundant,
        stylesheetPalette(ctx.site?.stylesheets)
      ),
    };
  },
};
