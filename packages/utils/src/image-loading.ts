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

/** A `px` or `vw` length as reference-viewport pixels; null for `calc()`, `em` and anything else. */
function lengthPx(value: string): number | null {
  const match = /^(\d{1,6}(?:\.\d{1,4})?)(px|vw)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const n = Number(match[1]);
  return match[2].toLowerCase() === "vw" ? (n * REFERENCE_VIEWPORT_WIDTH) / 100 : n;
}

/** Whether every term of a media condition holds at the reference viewport; unknown terms do not. */
function mediaMatches(condition: string): boolean {
  const terms = condition.split(/\band\b/i);
  if (terms.length > 8) return false;
  for (const raw of terms) {
    const term = /^\s*\(\s*(min|max)-width\s*:\s*(\d{1,6}(?:\.\d{1,4})?)px\s*\)\s*$/i.exec(raw);
    if (!term?.[1] || !term[2]) return false;
    const limit = Number(term[2]);
    const min = term[1].toLowerCase() === "min";
    if (min ? REFERENCE_VIEWPORT_WIDTH < limit : REFERENCE_VIEWPORT_WIDTH > limit) return false;
  }
  return true;
}

/**
 * The CSS width a `sizes` attribute resolves to at the reference viewport, as a
 * browser reads it (first entry whose media condition holds). No `sizes` means
 * `100vw`. Null when the matching entry is a length this model cannot read
 * (`calc()`, `em`): the caller then has no width to select against.
 */
export function sourceSizePx(sizes: string | null | undefined): number | null {
  if (!sizes || !sizes.trim()) return REFERENCE_VIEWPORT_WIDTH;
  for (const entry of splitSizes(sizes)) {
    const text = entry.trim();
    if (!text) continue;
    const withMedia = /^(\(.{0,200}\))\s+(\S{1,40})$/s.exec(text);
    if (withMedia?.[1] && withMedia[2]) {
      if (mediaMatches(withMedia[1])) return lengthPx(withMedia[2]);
      continue;
    }
    // No media condition: the default entry, used when no earlier one matched.
    return lengthPx(text);
  }
  return REFERENCE_VIEWPORT_WIDTH;
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
