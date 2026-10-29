import { ALL_FINGERPRINTS } from "./fingerprints";

/** Chars kept either side of a hint hit. */
const WINDOW_RADIUS = 384;
/** Hits kept per hint, so a bundle that repeats one literal cannot fill the sample. */
const MAX_HITS_PER_HINT = 6;

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
      if (d.type === "script-content" && d.hint) found.add(d.hint);
    }
  }
  hints = [...found];
  return hints;
}

/**
 * The parts of `content` past its first `headChars` that matter to detection:
 * a window around each hint hit (first few per hint), then the tail, joined with
 * newlines and capped at `maxChars`. A newline ends an unterminated quoted string
 * in the JS scan, so a window cut mid-string cannot flip the string state of the
 * next one. Empty when the body fits in the head.
 */
export function sampleBundleExtras(content: string, headChars: number, maxChars: number): string {
  if (content.length <= headChars || maxChars <= 0) return "";
  const spans: Array<[number, number]> = [];
  for (const hint of bundleHints()) {
    let from = headChars;
    for (let n = 0; n < MAX_HITS_PER_HINT; n++) {
      const at = content.indexOf(hint, from);
      if (at === -1) break;
      spans.push([Math.max(headChars, at - WINDOW_RADIUS), Math.min(content.length, at + hint.length + WINDOW_RADIUS)]);
      from = at + hint.length + WINDOW_RADIUS;
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
    parts.push(content.slice(start, Math.min(end, start + room)));
    used += Math.min(end - start, room) + 1;
  }
  // The tail takes what the windows left, never re-sending a window's text.
  const tailRoom = maxChars - used;
  if (tailRoom > 0) {
    const last = merged[merged.length - 1];
    const start = Math.max(content.length - tailRoom, headChars, last ? last[1] : headChars);
    if (start < content.length) parts.push(content.slice(start));
  }
  return parts.join("\n");
}
