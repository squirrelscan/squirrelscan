// shared/media-widths - the viewport widths a width-only `@media` query covers
// (pub#988).
//
// Narrow on purpose. A query is read only when every part of it is a plain
// width test: `min-width`, `max-width`, `width` (colon or range syntax, one or
// two comparisons), joined by `and`, `,` (or), an optional `only` and a
// `screen` or `all` media type, with px, em or rem lengths (1em = 16px, the
// initial font size a media query always uses). Anything else (`not`,
// orientation, height, `prefers-*`, `hover`, resolution, a container query,
// `calc()`, `vw` units) is null: the caller keeps its "unknown".

/** A run of viewport widths in CSS px; `hi` may be Infinity. */
export interface WidthRange {
  lo: number;
  loOpen: boolean;
  hi: number;
  hiOpen: boolean;
}

/** Sorted, disjoint ranges. */
export type WidthSet = readonly WidthRange[];

/**
 * A gap this narrow between two hiding ranges is not read as a width where the
 * element shows: `min-width: N` with `max-width: N - 0.02px` is the idiom for
 * complementary queries.
 */
export const WIDTH_GAP_TOLERANCE = 0.02;
const EPS = 1e-9;

const ALL: WidthRange = { lo: 0, loOpen: false, hi: Infinity, hiOpen: false };
const EM_PX = 16;

function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** `990px`, `61.875em`, `0`: a non-negative length, in px; null for anything else. */
function readLength(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(px|em|rem)?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === undefined) return n === 0 ? 0 : null;
  return m[2] === "px" ? n : n * EM_PX;
}

function normalize(ranges: WidthRange[]): WidthRange[] {
  const sorted = ranges
    .filter((r) => r.lo < r.hi || (r.lo === r.hi && !r.loOpen && !r.hiOpen))
    .sort((a, b) => a.lo - b.lo || Number(a.loOpen) - Number(b.loOpen));
  const out: WidthRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && (r.lo < last.hi || (r.lo === last.hi && !(r.loOpen && last.hiOpen)))) {
      if (r.hi > last.hi || (r.hi === last.hi && !r.hiOpen)) {
        last.hi = r.hi;
        last.hiOpen = r.hiOpen;
      }
    } else out.push({ ...r });
  }
  return out;
}

export function unionWidths(a: WidthSet, b: WidthSet): WidthSet {
  return normalize([...a.map((r) => ({ ...r })), ...b.map((r) => ({ ...r }))]);
}

export function intersectWidths(a: WidthSet, b: WidthSet): WidthSet {
  const out: WidthRange[] = [];
  for (const x of a) {
    for (const y of b) {
      const lo = Math.max(x.lo, y.lo);
      const loOpen = x.lo === y.lo ? x.loOpen || y.loOpen : x.lo > y.lo ? x.loOpen : y.loOpen;
      const hi = Math.min(x.hi, y.hi);
      const hiOpen = x.hi === y.hi ? x.hiOpen || y.hiOpen : x.hi < y.hi ? x.hiOpen : y.hiOpen;
      out.push({ lo, loOpen, hi, hiOpen });
    }
  }
  return normalize(out);
}

/** Whether the ranges, together, leave no viewport width unhidden (gaps up to the tolerance excepted). */
export function coversAllWidths(set: WidthSet): boolean {
  let pos = 0;
  // Whether the point at `pos` itself is still uncovered.
  let posOpen = false;
  for (const r of set) {
    const gap = r.lo - pos;
    if (gap > WIDTH_GAP_TOLERANCE + EPS) return false;
    // Two ranges meeting at one excluded point leave that width shown.
    if (Math.abs(gap) <= EPS && posOpen && r.loOpen) return false;
    if (r.hi > pos || (r.hi === pos && !r.hiOpen)) {
      pos = r.hi;
      posOpen = r.hiOpen;
    }
    if (pos === Infinity) return true;
  }
  return pos === Infinity;
}

function px(n: number): string {
  return `${Number(n.toFixed(2))}px`;
}

/**
 * Where the ranges leave the element shown, in words ("below 990px"), gaps up
 * to the tolerance left out.
 */
export function describeShownWidths(set: WidthSet): string {
  const pieces: string[] = [];
  const emit = (lo: number, loIncl: boolean, hi: number, hiIncl: boolean): void => {
    if (hi !== Infinity && hi - lo <= WIDTH_GAP_TOLERANCE + EPS) return;
    if (lo === 0 && loIncl) pieces.push(hiIncl ? `at ${px(hi)} and below` : `below ${px(hi)}`);
    else if (hi === Infinity) pieces.push(loIncl ? `at ${px(lo)} and above` : `above ${px(lo)}`);
    else pieces.push(`between ${px(lo)} and ${px(hi)}`);
  };
  let pos = 0;
  // Whether the point at `pos` is still uncovered.
  let free = true;
  for (const r of set) {
    if (r.lo > pos || (r.lo === pos && free && r.loOpen)) emit(pos, free, r.lo, r.loOpen);
    if (r.hi > pos || (r.hi === pos && !r.hiOpen)) {
      pos = r.hi;
      free = r.hiOpen;
    }
    if (pos === Infinity) break;
  }
  if (pos !== Infinity) emit(pos, free, Infinity, false);
  return pieces.length > 0 ? pieces.join(" and ") : "at some widths";
}

type Cmp = "<" | "<=" | ">" | ">=" | "=";

/** The ranges one `width` comparison covers: `width <op> N`. */
function widthCompare(op: Cmp, n: number): WidthRange {
  switch (op) {
    case ">=":
      return { lo: n, loOpen: false, hi: Infinity, hiOpen: false };
    case ">":
      return { lo: n, loOpen: true, hi: Infinity, hiOpen: false };
    case "<=":
      return { lo: 0, loOpen: false, hi: n, hiOpen: false };
    case "<":
      return { lo: 0, loOpen: false, hi: n, hiOpen: true };
    case "=":
      return { lo: n, loOpen: false, hi: n, hiOpen: false };
  }
}

const FLIP: Record<Cmp, Cmp> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=" };

/** One `( … )` feature: the ranges it covers, or null when it is not a plain width test. */
function readFeature(inner: string): WidthSet | null {
  const text = inner.trim();
  const colon = /^(min-width|max-width|width)\s*:\s*([^:]+)$/.exec(text);
  if (colon) {
    const n = readLength(colon[2] as string);
    if (n === null) return null;
    const kind = colon[1];
    return [widthCompare(kind === "min-width" ? ">=" : kind === "max-width" ? "<=" : "=", n)];
  }
  // Range syntax: `width >= 990px`, `990px <= width`, `400px <= width < 990px`.
  const parts = text.split(/(<=|>=|<|>|=)/).map((p) => p.trim());
  if (parts.length === 3) {
    const [a, op, b] = parts as [string, Cmp, string];
    if (a === "width") {
      const n = readLength(b);
      return n === null ? null : [widthCompare(op, n)];
    }
    if (b === "width") {
      const n = readLength(a);
      return n === null ? null : [widthCompare(FLIP[op], n)];
    }
    return null;
  }
  if (parts.length === 5) {
    const [a, op1, mid, op2, b] = parts as [string, Cmp, string, Cmp, string];
    if (mid !== "width" || op1 === "=" || op2 === "=") return null;
    // Both comparisons must point the same way: `a < width < b` or `a > width > b`.
    const lowToHigh = op1.startsWith("<") && op2.startsWith("<");
    const highToLow = op1.startsWith(">") && op2.startsWith(">");
    if (!lowToHigh && !highToLow) return null;
    const x = readLength(a);
    const y = readLength(b);
    if (x === null || y === null) return null;
    const first = widthCompare(FLIP[op1], x);
    const second = widthCompare(op2, y);
    return intersectWidths([first], [second]);
  }
  return null;
}

/** One media query (no commas): the ranges it covers, or null. */
function readQuery(query: string): WidthSet | null {
  let rest = query.trim();
  if (rest === "") return null;
  // `only` is transparent; `not` negates the whole query, which is not read.
  if (/^only\s/.test(rest)) rest = rest.slice(4).trim();
  let result: WidthSet = [ALL];
  const type = /^(screen|all)(?![-\w])\s*/.exec(rest);
  if (type) {
    rest = rest.slice(type[0].length);
    if (rest !== "") {
      const and = /^and\s+(?=\()/.exec(rest);
      if (!and) return null;
      rest = rest.slice(and[0].length);
    }
  }
  if (rest === "" && type) return result;
  // `(a) and (b) and (c)`
  let first = true;
  while (rest !== "") {
    if (!first) {
      const and = /^and\s+(?=\()/.exec(rest);
      if (!and) return null;
      rest = rest.slice(and[0].length);
    }
    first = false;
    if (rest[0] !== "(") return null;
    const close = rest.indexOf(")");
    if (close < 0) return null;
    const inner = rest.slice(1, close);
    // A nested group (`((min-width: 1px) or …)`) is not read.
    if (inner.includes("(")) return null;
    const feature = readFeature(inner);
    if (!feature) return null;
    result = intersectWidths(result, feature);
    rest = rest.slice(close + 1).trim();
  }
  return result;
}

/** Splits on commas outside parentheses. */
function splitQueries(prelude: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (--depth < 0) return null;
    } else if (ch === "," && depth === 0) {
      out.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  out.push(prelude.slice(start));
  return out;
}

/**
 * The widths an `@media` prelude (the text after `@media`) covers, or null when
 * any part of it is not a plain width test.
 */
export function readMediaWidths(prelude: string): WidthSet | null {
  const text = asciiLower(prelude).trim();
  if (text === "" || /[\\{}"';]/.test(text) || text.length > 500) return null;
  const queries = splitQueries(text);
  if (!queries) return null;
  let all: WidthSet = [];
  for (const q of queries) {
    const widths = readQuery(q);
    if (!widths) return null;
    all = unionWidths(all, widths);
  }
  return all;
}

/**
 * The widths where every `@media` in a rule's enclosing at-rule chain applies,
 * or null when the chain holds anything but plain width-only `@media` rules.
 */
export function readAtRuleWidths(chain: readonly string[]): WidthSet | null {
  let widths: WidthSet = [ALL];
  for (const prelude of chain) {
    const m = /^@media(?=[\s(])/i.exec(prelude);
    if (!m) return null;
    const own = readMediaWidths(prelude.slice(m[0].length));
    if (!own) return null;
    widths = intersectWidths(widths, own);
  }
  return widths;
}
