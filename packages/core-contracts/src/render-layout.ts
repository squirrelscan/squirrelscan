// Per-page layout payload from a mobile-viewport render (repo#4218, prerequisite for repo#1381).
//
// The render service measures the page at a phone-width viewport and returns this optional, additive
// field on a render result. Every length is CSS px, rounded to integers. A selector is a short CSS path
// (tag, #id, .class, :nth-of-type), at most RENDER_LAYOUT_LIMITS.selectorChars long, root-most first,
// joined with " > ". Renders without the mobile pass carry no `layout` field at all.

/** Element rectangle in CSS px, relative to the document origin. */
export interface RenderLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One reported element: where it is and what is wrong with it. */
export interface RenderLayoutElement {
  selector: string;
  rect: RenderLayoutRect;
}

/** A clipped-text element also says how much of its text is cut off. */
export interface RenderLayoutClippedElement extends RenderLayoutElement {
  /** scrollWidth minus clientWidth, in CSS px (non-negative). */
  clippedPx: number;
}

/** An interactive element that overlaps another one. */
export interface RenderLayoutOverlapElement extends RenderLayoutElement {
  /** Selector of the interactive element it overlaps. */
  overlaps: string;
}

export interface RenderLayout {
  /** Viewport width the page was measured at, in CSS px (390 for the standard mobile pass). */
  viewportWidth: number;
  /** document scrollWidth, in CSS px. Greater than viewportWidth means the page scrolls sideways. */
  documentWidth: number;
  /** Elements that extend past the viewport edge. */
  overflowing: RenderLayoutElement[];
  /** Elements whose text is clipped by their own box. */
  clippedText: RenderLayoutClippedElement[];
  /** Interactive elements overlapping another interactive element. */
  overlapping: RenderLayoutOverlapElement[];
  /** Interactive elements smaller than the tap target minimum on either side. */
  smallTapTargets: RenderLayoutElement[];
  /** True when any list hit its cap and further offenders were dropped. */
  truncated: boolean;
  /** Short text digest of the mobile render's visible text, for desktop-vs-mobile parity. */
  textDigest: string;
}

export const RENDER_LAYOUT_LIMITS = {
  /** Mobile viewport width the pass renders at. */
  viewportWidth: 390,
  /** Tap target minimum, CSS px per side. */
  minTapTarget: 44,
  /** Max entries in each of the four lists. */
  maxPerList: 50,
  /** Max characters in one selector. */
  selectorChars: 200,
  /** Max characters in the text digest. */
  digestChars: 500,
  /** Max serialized size of one page's layout, in bytes. */
  maxBytes: 32 * 1024,
} as const;

const LISTS = ["overflowing", "clippedText", "overlapping", "smallTapTargets"] as const;

const int = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

const cut = (s: unknown, max: number): string => (typeof s === "string" ? s.slice(0, max) : "");

function rect(r: Partial<RenderLayoutRect> | undefined): RenderLayoutRect {
  return { x: int(r?.x), y: int(r?.y), width: int(r?.width), height: int(r?.height) };
}

function clampEntry<T extends RenderLayoutElement>(e: T): T {
  const out: Record<string, unknown> = { selector: cut(e.selector, RENDER_LAYOUT_LIMITS.selectorChars), rect: rect(e.rect) };
  if ("clippedPx" in e) out.clippedPx = int(e.clippedPx);
  if ("overlaps" in e) out.overlaps = cut(e.overlaps, RENDER_LAYOUT_LIMITS.selectorChars);
  return out as unknown as T;
}

/**
 * Enforce the caps on a layout payload and fill in missing lists with empty ones. Never throws: the render
 * service and a client both run it, so an oversized or sloppy payload degrades to a smaller one. Returns
 * undefined only when the input is not an object (so an older result stays free of a `layout` field).
 */
export function normalizeRenderLayout(input: unknown): RenderLayout | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Partial<Record<keyof RenderLayout, unknown>>;
  let truncated = raw.truncated === true;
  const layout: RenderLayout = {
    viewportWidth: int(raw.viewportWidth) || RENDER_LAYOUT_LIMITS.viewportWidth,
    documentWidth: int(raw.documentWidth),
    overflowing: [],
    clippedText: [],
    overlapping: [],
    smallTapTargets: [],
    truncated: false,
    textDigest: cut(raw.textDigest, RENDER_LAYOUT_LIMITS.digestChars),
  };
  for (const key of LISTS) {
    const list = Array.isArray(raw[key]) ? (raw[key] as RenderLayoutElement[]) : [];
    const kept = list.filter((e) => e && typeof e === "object").slice(0, RENDER_LAYOUT_LIMITS.maxPerList);
    if (kept.length < list.length) truncated = true;
    (layout[key] as RenderLayoutElement[]) = kept.map(clampEntry);
  }
  // Byte cap: drop entries from the tail of the longest list until the payload fits.
  while (new TextEncoder().encode(JSON.stringify(layout)).length > RENDER_LAYOUT_LIMITS.maxBytes) {
    const longest = LISTS.reduce((a, b) => (layout[b].length > layout[a].length ? b : a));
    if (layout[longest].length === 0) break;
    layout[longest].pop();
    truncated = true;
  }
  layout.truncated = truncated;
  return layout;
}
