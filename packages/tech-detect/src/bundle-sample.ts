import { ALL_FINGERPRINTS } from "./fingerprints";
import { scanJs, SEGMENT_SEPARATOR, skipEnd, skipStart } from "./js-scan";

/** Chars kept before a hint hit: the longest key, URL or call prefix a detector reads. */
const WINDOW_BEFORE = 160;
/** Chars kept after a hint hit: the longest value a detector reads (a URL's key literal). */
const WINDOW_AFTER = 256;
/** Hits kept per hint, so a bundle that repeats one literal cannot fill the sample. */
const MAX_HITS_PER_HINT = 48;
/** Hits examined per hint, kept or not: a hit that yields no window (a long string) does not use up the kept ones. */
const MAX_HIT_SCANS_PER_HINT = 256;
/** A string longer than this past a window's end is cut before it, not carried to its close. */
const MAX_STRING_CARRY = 512;
/** Longest body the scan classifies: past a script fetch cap, so every fetched body fits. */
const MAX_SCAN_CHARS = 6 * 1024 * 1024;

let hints: string[] | null = null;

/**
 * The literals the `inCode` bundle detectors need present before they can match
 * (`hint` on a `script-content` detector). The app's own code sits at the END or
 * in the middle of a bundled SPA, after the framework it ships with, so a
 * head-only slice misses it: these literals tell {@link sampleBundleExtras}
 * where to look in a body that is too big to send whole.
 */
export function bundleHints(): string[] {
  if (hints) return hints;
  const found = new Set<string>();
  for (const fp of ALL_FINGERPRINTS) {
    for (const d of fp.detectors) {
      if (d.type !== "script-content") continue;
      if (d.hint) found.add(d.hint);
      for (const h of d.also?.hints ?? []) found.add(h);
    }
  }
  hints = [...found];
  return hints;
}

/**
 * The parts of `content` past its first `headChars` that matter to detection: a
 * window around each hint hit (first few per hint), then the tail, joined with
 * {@link SEGMENT_SEPARATOR} and capped at `maxChars`.
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

  const lower = Math.max(0, headChars - WINDOW_BEFORE);
  const spans: Array<[number, number]> = [];
  for (const hint of bundleHints()) {
    let from = lower;
    let kept = 0;
    for (let n = 0; n < MAX_HIT_SCANS_PER_HINT && kept < MAX_HITS_PER_HINT; n++) {
      const at = content.indexOf(hint, from);
      if (at === -1 || at >= limit) break;
      from = at + hint.length;
      const start = codeAfter(Math.max(lower, at - WINDOW_BEFORE));
      if (start > at) {
        // The hit sits in a string that opened before the window: keep a short one
        // whole (a library's own notice is a string), skip a long one.
        const open = skipStart(skips, at);
        const close = skipEnd(skips, at);
        if (open === -1 || close - open > MAX_STRING_CARRY) continue;
        const end = codeBefore(Math.min(limit, at + hint.length + WINDOW_AFTER), at);
        if (end > open) {
          spans.push([open, end]);
          kept++;
        }
        continue;
      }
      const end = codeBefore(Math.min(limit, at + hint.length + WINDOW_AFTER), at);
      if (end > start) {
        spans.push([start, end]);
        kept++;
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  let used = 0;
  const parts: string[] = [];
  for (const [start, end] of merged) {
    const room = maxChars - used;
    if (room <= 0) break;
    // A window past the room is cut at a code boundary too, or dropped.
    const stop = end - start <= room ? end : codeBefore(start + room, start);
    if (stop > start) {
      parts.push(content.slice(start, stop));
      used += stop - start + SEGMENT_SEPARATOR.length;
    }
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
