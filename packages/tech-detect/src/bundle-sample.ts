import { ALL_FINGERPRINTS } from "./fingerprints";
import { deriveHints } from "./hint-derive";
import { scanJs, SEGMENT_SEPARATOR, skipEnd, skipStart } from "./js-scan";

/** Chars kept before a hint hit: the longest key, URL or call prefix a detector reads. */
const WINDOW_BEFORE = 160;
/** Chars kept after a hint hit: the longest value a detector reads (a URL's key literal). */
const WINDOW_AFTER = 256;
/**
 * Windows kept per hint. A detector needs one window that matches; a few more cover a first hit
 * that sits in a string or comment, which an `inCode` detector rejects. Windows are then shared out
 * round by round across hints (see {@link sampleBundleExtras}), so one literal that repeats cannot
 * take the sample from the others.
 */
const MAX_KEPT_PER_HINT = 8;
/**
 * Share of the extras budget the windows may not touch, kept for the tail of the file: the
 * detectors that have no literal to search for (a pattern made of classes and quantifiers) can only
 * match there. At most this many chars, and never more than a quarter of the budget.
 */
const TAIL_RESERVE_CHARS = 6 * 1024;
/** Hits examined per hint, kept or not: a hit that yields no window (a long string) or fails its detectors' patterns does not use up the kept ones. */
const MAX_HIT_SCANS_PER_HINT = 512;
/** A string longer than this past a window's end is cut before it, not carried to its close. */
const MAX_STRING_CARRY = 512;
/** Longest body the scan classifies: past the largest `[tech_detect] bundle_bytes`, so every body a caller can hand over fits. */
const MAX_SCAN_CHARS = 32 * 1024 * 1024;

/** One literal the sampler searches a bundle for, with the detector patterns that decide whether a hit is worth a window. */
interface HintSpec {
  text: string;
  /** Searched in a lower-cased copy of the body (the detector pattern is case-insensitive). */
  ci: boolean;
  patterns: RegExp[];
  /** Declared by the fingerprint (`hint`, `also.hints`) rather than derived from its pattern. */
  declared: boolean;
}

let specs: HintSpec[] | null = null;

/**
 * Every hint the sampler looks for: the ones fingerprints declare (`hint`, `also.hints`) and, for a
 * `script-content` detector that declares none, the literals its pattern requires
 * ({@link deriveHints}), so Sentry, React, PostHog and the rest are searched for past the head of a
 * bundle and do not depend on what the tail happens to hold (#1420). Each hint carries the patterns
 * of the detectors that use it, so a hit whose window matches none of them is not kept.
 */
function hintSpecs(): HintSpec[] {
  if (specs) return specs;
  const map = new Map<string, HintSpec>();
  const add = (text: string, ci: boolean, re: RegExp, declared: boolean): void => {
    const key = `${ci ? "i" : "s"}:${text}`;
    const own = new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
    const known = map.get(key);
    if (known) {
      known.patterns.push(own);
      known.declared ||= declared;
    } else map.set(key, { text, ci, patterns: [own], declared });
  };
  for (const fp of ALL_FINGERPRINTS) {
    for (const d of fp.detectors) {
      if (d.type !== "script-content") continue;
      if (d.hint) add(d.hint, false, d.pattern, true);
      if (d.also) for (const h of d.also.hints) add(h, false, d.also.pattern, true);
      if (!d.hint) {
        const derived = deriveHints(d.pattern);
        for (const text of derived.hints) add(text, derived.caseInsensitive, d.pattern, false);
      }
    }
  }
  specs = [...map.values()];
  return specs;
}

/**
 * The literals the bundle detectors need present before they can match: the `hint` a fingerprint
 * declares on a `script-content` detector, and the literal derived from a detector's pattern when it
 * declares none. The app's own code sits at the END or in the middle of a bundled SPA, after the
 * framework it ships with, so a head-only slice misses it: these literals tell
 * {@link sampleBundleExtras} where to look in a body that is too big to send whole.
 */
export function bundleHints(): string[] {
  return [...new Set(hintSpecs().map((spec) => spec.text))];
}

/** Spans sorted and merged where they touch or overlap. */
function mergeSpans(spans: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** Chars the spans take once merged, each with its separator. */
function mergedCost(spans: ReadonlyArray<[number, number]>): number {
  let total = 0;
  for (const [start, end] of mergeSpans(spans)) total += end - start + SEGMENT_SEPARATOR.length;
  return total;
}

/**
 * The parts of `content` past its first `headChars` that matter to detection: windows around
 * hint hits, then the tail, joined with {@link SEGMENT_SEPARATOR} and capped at `maxChars`.
 * Every detector has a hint (declared, or derived from its pattern), the windows are shared out
 * across hints one round at a time (each hint's first window before any hint's second), and the
 * tail keeps a reserve the windows cannot take (#1420).
 *
 * Every window starts and ends in CODE state of the whole file, classified once
 * over the whole body (the scan is linear): a window cut inside a string would
 * make the scan of the window read its closing quote as an opening one and
 * misclassify everything after it (an `https://` inside a string read as a `//`
 * comment). The separator then ends any string or comment still open at a
 * segment's end, so segments, and the head before them, scan independently.
 * Empty when the body fits in the head.
 */
export function sampleBundleExtras(content: string, headChars: number, maxChars: number): string {
  if (content.length <= headChars || maxChars <= 0) return "";
  const limit = Math.min(content.length, MAX_SCAN_CHARS);
  const { skips } = scanJs(content.slice(0, limit));
  /** First position at or after `p` that is not inside a string, regex literal or comment. */
  const codeAfter = (p: number): number => {
    const end = skipEnd(skips, p);
    return end === -1 ? p : end + 1;
  };
  /** `p`, or the nearest boundary that does not split a string, regex literal or comment. */
  const codeBefore = (p: number, floor: number): number => {
    const end = skipEnd(skips, p);
    if (end === -1) return p;
    if (end + 1 - p <= MAX_STRING_CARRY) return end + 1;
    // Walk back to the start of the range holding p.
    let lo = floor;
    let hi = p;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (skipEnd(skips, mid) === end) hi = mid;
      else lo = mid + 1;
    }
    return Math.max(floor, lo - 1);
  };

  const floor = Math.max(0, headChars - WINDOW_BEFORE);
  // A lower-cased copy, only when a case-insensitive hint needs it and the indices still line up.
  let lowered: string | null | undefined;
  const lowerContent = (): string | null => {
    if (lowered === undefined) {
      const copy = content.toLowerCase();
      lowered = copy.length === content.length ? copy : null;
    }
    return lowered;
  };

  // Qualified windows per hint, declared hints first: a window is kept only if a detector pattern
  // that uses the hint matches it, so a placeholder or an unrelated mention of the literal costs
  // nothing and takes no budget from a real match.
  const perHint: Array<Array<[number, number]>> = [];
  const ordered = [...hintSpecs()].sort((x, y) => Number(y.declared) - Number(x.declared));
  for (const spec of ordered) {
    const haystack = spec.ci ? lowerContent() : content;
    if (haystack === null) continue;
    const seen = new Set<string>();
    const windows: Array<[number, number]> = [];
    let from = floor;
    for (let n = 0; n < MAX_HIT_SCANS_PER_HINT && windows.length < MAX_KEPT_PER_HINT; n++) {
      const at = haystack.indexOf(spec.text, from);
      if (at === -1 || at >= limit) break;
      from = at + spec.text.length;
      let start = codeAfter(Math.max(floor, at - WINDOW_BEFORE));
      if (start > at) {
        // The hit sits in a string that opened before the window: keep a short one
        // whole (a library's own notice is a string), skip a long one.
        const open = skipStart(skips, at);
        const close = skipEnd(skips, at);
        if (open === -1 || close - open > MAX_STRING_CARRY) continue;
        start = open;
      }
      const end = codeBefore(Math.min(limit, at + spec.text.length + WINDOW_AFTER), at);
      if (end <= start) continue;
      const text = content.slice(start, end);
      if (seen.has(text) || !spec.patterns.some((re) => re.test(text))) continue;
      seen.add(text);
      windows.push([start, end]);
    }
    if (windows.length > 0) perHint.push(windows);
  }

  // Shared out round by round: every hint's first window, then every hint's second, until the
  // window budget is spent. The budget leaves the tail its reserve, so what the windows take can
  // never push out what only the tail can match (#1420).
  const tailReserve = Math.min(TAIL_RESERVE_CHARS, Math.floor(maxChars / 4));
  const windowBudget = maxChars - tailReserve;
  const chosen: Array<[number, number]> = [];
  for (let round = 0; round < MAX_KEPT_PER_HINT; round++) {
    for (const windows of perHint) {
      const window = windows[round];
      if (!window) continue;
      if (mergedCost([...chosen, window]) <= windowBudget) chosen.push(window);
    }
  }
  const merged = mergeSpans(chosen);
  let used = 0;
  const parts: string[] = [];
  for (const [start, end] of merged) {
    parts.push(content.slice(start, end));
    used += end - start + SEGMENT_SEPARATOR.length;
  }
  // The tail takes what the windows left, never re-sending a window's text.
  const tailRoom = maxChars - used - (parts.length > 0 ? SEGMENT_SEPARATOR.length : 0);
  if (tailRoom > 0 && limit === content.length) {
    const last = merged[merged.length - 1];
    const start = codeAfter(Math.max(content.length - tailRoom, headChars, last ? last[1] : 0));
    if (start < content.length) parts.push(content.slice(start));
  }
  return parts.join(SEGMENT_SEPARATOR);
}
