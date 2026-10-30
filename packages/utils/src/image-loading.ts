// Which image file a browser actually loads for an <img>, and whether it is in
// the initial viewport. Shared by the audit engine (which images it measures
// and how it counts page weight) and the image rules, so every one of them
// answers the question the same way (#1250, #1251, #1252).
//
// All of it is a reference model, not a layout: there is no viewport in an HTTP
// audit, so the viewport width, device pixel ratio and above-the-fold budget are
// fixed constants below. Everything here reads attribute STRINGS, never a DOM,
// so it runs on parsed `ImageData` and on live elements alike.

/** Reference viewport width, in CSS pixels, for `sizes` media conditions and `vw` lengths. */
export const REFERENCE_VIEWPORT_WIDTH = 1280;
/** Reference device pixel ratio the selected `srcset` candidate must cover. */
export const REFERENCE_DPR = 2;
/** Images (icons and logos excluded) assumed to sit in the initial viewport. */
export const ABOVE_FOLD_IMAGE_BUDGET = 3;
/** An image declared smaller than this many square pixels (both sides given) is an icon or logo. */
export const ICON_AREA_PX = 20_000;

const MAX_SRCSET_LENGTH = 8_192;
const MAX_SRCSET_CANDIDATES = 64;
const MAX_SIZES_ENTRIES = 32;

export interface SrcsetCandidate {
  url: string;
  /** Width descriptor (`400w`), when present. */
  w?: number;
  /** Pixel density descriptor (`2x`), when present. */
  x?: number;
}

/** The candidates of a `srcset` value, in order. Bounded: a hostile value cannot cost more than its prefix. */
export function parseSrcset(value: string | null | undefined): SrcsetCandidate[] {
  if (!value) return [];
  const text = value.length > MAX_SRCSET_LENGTH ? value.slice(0, MAX_SRCSET_LENGTH) : value;
  const out: SrcsetCandidate[] = [];
  let i = 0;
  while (i < text.length && out.length < MAX_SRCSET_CANDIDATES) {
    while (i < text.length && (text[i] === "," || /\s/.test(text[i] ?? ""))) i++;
    if (i >= text.length) break;
    const urlStart = i;
    while (i < text.length && !/\s/.test(text[i] ?? "")) i++;
    let url = text.slice(urlStart, i);
    let descriptors = "";
    if (url.endsWith(",")) {
      // "a.jpg, b.jpg 2x": the comma ends the candidate, there are no descriptors.
      url = url.replace(/,+$/, "");
    } else {
      const descStart = i;
      while (i < text.length && text[i] !== ",") i++;
      descriptors = text.slice(descStart, i);
    }
    if (!url) continue;
    const candidate: SrcsetCandidate = { url };
    const match = /(\d{1,6}(?:\.\d{1,4})?)\s*([wx])\b/i.exec(descriptors);
    if (match?.[1] && match[2]) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > 0) {
        if (match[2].toLowerCase() === "w") candidate.w = n;
        else candidate.x = n;
      }
    }
    out.push(candidate);
  }
  return out;
}

/** Split a `sizes` list on top-level commas (a comma inside parentheses is part of an entry). */
function splitSizes(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length && parts.length < MAX_SIZES_ENTRIES; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (parts.length < MAX_SIZES_ENTRIES) parts.push(value.slice(start));
  return parts;
}

/** A value in reference-viewport pixels, or a bare number (a scale factor in a `calc()`). */
interface CalcValue {
  v: number;
  unit: "px" | "num";
}

/** `em` and `rem` resolve against the default 16 px font size: there is no stylesheet to read. */
const DEFAULT_FONT_PX = 16;

function unitValue(n: number, unit: string): CalcValue | null {
  switch (unit.toLowerCase()) {
    case "":
      return { v: n, unit: "num" };
    case "px":
      return { v: n, unit: "px" };
    case "vw":
      return { v: (n * REFERENCE_VIEWPORT_WIDTH) / 100, unit: "px" };
    case "em":
    case "rem":
      return { v: n * DEFAULT_FONT_PX, unit: "px" };
    default:
      return null;
  }
}

/**
 * A `<length>` or a simple `calc()` as reference-viewport pixels: `px`, `vw`, `em`
 * and `rem`, with `+`, `-`, `*`, `/` and parentheses. Null for anything else
 * (`min()`, `max()`, `clamp()`, `%`, a unit this model has no value for), and for
 * input past a small size bound. Operators need surrounding spaces, as CSS requires
 * for `+` and `-`, which keeps a negative number apart from a subtraction.
 */
function evaluateLength(source: string): number | null {
  const text = source.trim();
  if (text.length === 0 || text.length > 200) return null;
  const inner = /^calc\((.*)\)$/is.exec(text)?.[1] ?? text;
  const tokens = inner.match(
    /\(|\)|[*/]|\s[+-]\s|-?\d{1,6}(?:\.\d{1,4})?[a-z%]{0,4}|[a-z-]{1,20}\(/gi,
  );
  if (!tokens || tokens.join("").replace(/\s/g, "") !== inner.replace(/\s/g, "")) return null;
  let pos = 0;
  let steps = 0;
  const peek = (): string | undefined => tokens[pos]?.trim();
  const factor = (): CalcValue | null => {
    if (++steps > 200) return null;
    const token = tokens[pos++]?.trim();
    if (token === undefined) return null;
    if (token === "(" || token.toLowerCase() === "calc(") {
      const value = expression();
      if (peek() !== ")") return null;
      pos++;
      return value;
    }
    const match = /^(-?\d{1,6}(?:\.\d{1,4})?)([a-z]{0,4})$/i.exec(token);
    return match?.[1] !== undefined ? unitValue(Number(match[1]), match[2] ?? "") : null;
  };
  const term = (): CalcValue | null => {
    let left = factor();
    while (left && (peek() === "*" || peek() === "/")) {
      const op = tokens[pos++]?.trim();
      const right = factor();
      if (!right) return null;
      if (op === "*") {
        if (left.unit === "px" && right.unit === "px") return null;
        left = {
          v: left.v * right.v,
          unit: left.unit === "px" || right.unit === "px" ? "px" : "num",
        };
      } else {
        if (right.unit !== "num" || right.v === 0) return null;
        left = { v: left.v / right.v, unit: left.unit };
      }
    }
    return left;
  };
  const expression = (): CalcValue | null => {
    let left = term();
    while (left && (peek() === "+" || peek() === "-")) {
      const op = tokens[pos++]?.trim();
      const right = term();
      if (!right || right.unit !== left.unit) return null;
      left = { v: op === "+" ? left.v + right.v : left.v - right.v, unit: left.unit };
    }
    return left;
  };
  const result = expression();
  if (!result || pos !== tokens.length || result.unit !== "px" || !Number.isFinite(result.v))
    return null;
  return result.v;
}

/** Whether every term of a media condition holds at the reference viewport; unknown terms do not. */
function mediaMatches(condition: string): boolean {
  const terms = condition.split(/\band\b/i);
  if (terms.length > 8) return false;
  for (const raw of terms) {
    const term = /^\s*\(\s*(min|max)-width\s*:\s*(\d{1,6}(?:\.\d{1,4})?)(px|em|rem)\s*\)\s*$/i.exec(
      raw,
    );
    if (!term?.[1] || !term[2] || !term[3]) return false;
    const limit =
      term[3].toLowerCase() === "px" ? Number(term[2]) : Number(term[2]) * DEFAULT_FONT_PX;
    const min = term[1].toLowerCase() === "min";
    if (min ? REFERENCE_VIEWPORT_WIDTH < limit : REFERENCE_VIEWPORT_WIDTH > limit) return false;
  }
  return true;
}

/**
 * Split one `sizes` entry into its media condition and its source size, reading the
 * parentheses as balanced groups: the source size is the trailing length or function
 * (`370px`, `calc((100vw - 130px) / 2)`), the condition is whatever precedes it.
 */
function splitSizeEntry(entry: string): { media: string | null; value: string } | null {
  const text = entry.trim();
  if (text.length === 0 || text.length > 400) return null;
  let start = text.length;
  if (text.endsWith(")")) {
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === ")") depth++;
      else if (text[i] === "(") {
        depth--;
        if (depth === 0) {
          start = i;
          break;
        }
      }
    }
    if (depth !== 0) return null;
    // A function name belongs to its value (`calc(`, `min(`).
    while (start > 0 && /[a-z-]/i.test(text[start - 1] ?? "")) start--;
  } else {
    const space = text.search(/\S+$/);
    start = space < 0 ? text.length : space;
  }
  const value = text.slice(start).trim();
  const media = text.slice(0, start).trim();
  if (value === "") return null;
  return { media: media === "" ? null : media, value };
}

/**
 * The CSS width a `sizes` attribute resolves to at the reference viewport, as a
 * browser reads it: the first entry whose media condition holds. No `sizes` means
 * `100vw`. An entry whose media condition this model cannot read is skipped, and so
 * is a matching one whose value it cannot read (`min()`, `clamp()`): the next entry
 * is tried, so a later default still answers. Null when no entry gives a width, and
 * the caller then has nothing to select against.
 */
export function sourceSizePx(sizes: string | null | undefined): number | null {
  if (!sizes || !sizes.trim()) return REFERENCE_VIEWPORT_WIDTH;
  for (const raw of splitSizes(sizes)) {
    const entry = splitSizeEntry(raw);
    if (!entry) continue;
    if (entry.media !== null && !mediaMatches(entry.media)) continue;
    const px = evaluateLength(entry.value);
    if (px !== null && px >= 0) return px;
  }
  return null;
}

/**
 * The URL a browser would download for an `<img>`, at the reference viewport and
 * device pixel ratio: with `srcset` and width descriptors, the smallest candidate
 * covering the `sizes` width at {@link REFERENCE_DPR}, else the largest; with
 * density descriptors, the smallest one at or above that ratio, else the
 * largest. Without `srcset` it is `src`. The URL is returned as written (not
 * resolved). Null when the image names no file at all.
 */
export function selectImageCandidate(img: {
  src?: string | null;
  srcset?: string | null;
  sizes?: string | null;
}): string | null {
  const candidates = parseSrcset(img.srcset);
  if (candidates.length === 0) return img.src || null;

  const widths = candidates.filter((c) => c.w !== undefined);
  if (widths.length > 0) {
    const needed = sourceSizePx(img.sizes);
    const sorted = [...widths].sort((a, b) => (a.w ?? 0) - (b.w ?? 0));
    if (needed === null) return sorted[sorted.length - 1]?.url ?? img.src ?? null;
    const target = needed * REFERENCE_DPR;
    return (sorted.find((c) => (c.w ?? 0) >= target) ?? sorted[sorted.length - 1])?.url ?? null;
  }

  const sorted = [...candidates].sort((a, b) => (a.x ?? 1) - (b.x ?? 1));
  return (
    (sorted.find((c) => (c.x ?? 1) >= REFERENCE_DPR) ?? sorted[sorted.length - 1])?.url ?? null
  );
}

function declaredPx(value: string | null | undefined): number | null {
  const match = /^\s*(\d{1,5})(?:px)?\s*$/i.exec(value ?? "");
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * True for an image declared (both `width` and `height`) at an icon or logo size.
 * Without layout this is the only evidence of size there is; an image with no
 * declared size is never an icon here, so it keeps its place in the budget.
 */
export function isIconSized(img: { width?: string | null; height?: string | null }): boolean {
  const w = declaredPx(img.width);
  const h = declaredPx(img.height);
  if (w === null || h === null) return false;
  return w * h < ICON_AREA_PX;
}

/**
 * For each image in document order, whether it counts as inside the initial
 * viewport: the first `budget` images that are not icon-sized fill it, and icon
 * and logo images neither fill it nor are held to it until it is full (a header
 * of small icons must not push the hero below the fold, #1250).
 */
export function initialViewportFlags(
  images: ReadonlyArray<{ width?: string | null; height?: string | null }>,
  budget: number = ABOVE_FOLD_IMAGE_BUDGET,
): boolean[] {
  let used = 0;
  return images.map((img) => {
    const inside = used < budget;
    if (inside && !isIconSized(img)) used++;
    return inside;
  });
}
