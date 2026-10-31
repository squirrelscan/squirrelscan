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
/** Windows each declared hint is given before any derived hint is given its first. */
const DECLARED_FIRST_WINDOWS = 2;
/** Hits examined per hint, kept or not: a hit that yields no window (a long string) or fails its detectors' patterns does not use up the kept ones. */
const MAX_HIT_SCANS_PER_HINT = 512;
/** Matches of an `inCode` pattern one window is walked through looking for one that starts in code (the matcher's own bound is 64 over a whole script). */
const MAX_QUALIFY_CANDIDATES = 64;
/** Chars a segment may carry beyond its text: an opener of up to 2 characters, and one character backed up so a cut never splits an escape (see `cutAt`). */
const OPENER_SLACK = 3;
/** A string longer than this past a window's end is cut before it, not carried to its close. */
const MAX_STRING_CARRY = 512;
/** Longest body the scan classifies: past the largest `[tech_detect] bundle_bytes`, so every body a caller can hand over fits. */
const MAX_SCAN_CHARS = 32 * 1024 * 1024;

/** A detector pattern that decides whether a window is worth keeping. */
interface HintPattern {
  /** Without the `g` and `y` flags, for a plain `test`. */
  plain: RegExp;
  /** With `g`, walked match by match when the detector is `inCode`; null when it is not. */
  inCode: RegExp | null;
}

/** One literal the sampler searches a bundle for, with the detector patterns that decide whether a hit is worth a window. */
interface HintSpec {
  text: string;
  /** Searched in a lower-cased copy of the body (the detector pattern is case-insensitive). */
  ci: boolean;
  patterns: HintPattern[];
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
  const add = (text: string, ci: boolean, re: RegExp, declared: boolean, inCode: boolean): void => {
    const key = `${ci ? "i" : "s"}:${text}`;
    const flags = re.flags.replace(/[gy]/g, "");
    const own: HintPattern = {
      plain: new RegExp(re.source, flags),
      inCode: inCode ? new RegExp(re.source, `${flags}g`) : null,
    };
    const known = map.get(key);
    if (known) {
      known.patterns.push(own);
      known.declared ||= declared;
    } else map.set(key, { text, ci, patterns: [own], declared });
  };
  for (const fp of ALL_FINGERPRINTS) {
    for (const d of fp.detectors) {
      if (d.type !== "script-content") continue;
      const inCode = d.inCode === true;
      if (d.hint) add(d.hint, false, d.pattern, true, inCode);
      // The `also` pattern is matched anywhere in the body, strings included: not gated to code.
      if (d.also) for (const h of d.also.hints) add(h, false, d.also.pattern, true, false);
      if (!d.hint) {
        const derived = deriveHints(d.pattern);
        for (const text of derived.hints) add(text, derived.caseInsensitive, d.pattern, false, inCode);
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

/** Chars the spans take once merged, each with its separator and room for an opener. */
function mergedCost(spans: ReadonlyArray<[number, number]>): number {
  let total = 0;
  for (const [start, end] of mergeSpans(spans)) total += end - start + SEGMENT_SEPARATOR.length + OPENER_SLACK;
  return total;
}

/**
 * The parts of `content` past its first `headChars` that matter to detection: windows around
 * hint hits, then the tail, joined with {@link SEGMENT_SEPARATOR} and capped at `maxChars`.
 * Nearly every detector has a hint (declared, or derived from its pattern; `adobe-analytics` has
 * none), the windows are shared out across hints one round at a time (each hint's first window
 * before any hint's second, declared hints first), and the tail keeps a reserve the windows cannot
 * take (#1420).
 *
 * Windows are cut in CODE state of the whole file, classified once over the whole body (the scan
 * is linear): a window cut inside a string would make the scan of the window read its closing
 * quote as an opening one and misclassify everything after it (an `https://` inside a string read
 * as a `//` comment). A cut that has to fall inside a string, regex or comment too long to carry
 * (the tracker is a heuristic and can lose track of code, #1433) keeps the cut and puts the
 * characters that opened the span in front of the segment, so the scan of the sent text reads it
 * as the whole file does. The separator ends any string or comment still open at a segment's end,
 * so segments, and the head before them, scan independently.
 * Empty when the body fits in the head.
 */
export function sampleBundleExtras(content: string, headChars: number, maxChars: number): string {
  if (content.length <= headChars || maxChars <= 0) return "";
  const limit = Math.min(content.length, MAX_SCAN_CHARS);
  const { skips } = scanJs(content.slice(0, limit));
  /** The string, regex literal or comment that holds `p` (`start < p <= end`), or null in code. */
  const spanAt = (p: number): { open: number; close: number } | null => {
    const close = skipEnd(skips, p);
    return close === -1 ? null : { open: skipStart(skips, p), close };
  };
  /**
   * Where a segment may begin at `p`. In code, at `p`. Inside a short string, regex or comment, past
   * its end. Inside a long one, at `p` itself, with the characters that opened it put in front of
   * the segment, so the scan of the sent text reads it as the whole file does. The tracker is a
   * heuristic (a regex after `}` or `)`, a template literal with a nested template, a quote in a
   * regex each flip it for the rest of a minified line): jumping to the far end of a long span
   * that is really code drops the region a detector needs (#1433 corpus), and cutting inside it with
   * no opener makes a real string, such as an inlined script, read as code.
   */
  const openerOf = (open: number): string => {
    const first = content.charAt(open);
    return first === "/" && /[/*]/.test(content.charAt(open + 1)) ? content.slice(open, open + 2) : first;
  };
  const cutAt = (p: number): { pos: number; opener: string } => {
    const span = spanAt(p);
    if (!span) return { pos: p, opener: "" };
    if (span.close + 1 - p <= MAX_STRING_CARRY) return { pos: span.close + 1, opener: "" };
    const opener = openerOf(span.open);
    // a regex literal cannot be reopened mid-way (a `/` inside a class): skip past it as before
    if (opener === "/") return { pos: span.close + 1, opener: "" };
    // never cut between a backslash and the character it escapes: that character would read unescaped
    let slashes = 0;
    while (p - 1 - slashes > span.open && content.charAt(p - 1 - slashes) === "\\") slashes++;
    return { pos: slashes % 2 === 1 ? p - 1 : p, opener };
  };
  /** The end of a window cut at `p`: past a short string it ends in, as is inside a long one (the separator ends it). */
  const endAt = (p: number): number => {
    const span = spanAt(p);
    return span && span.close + 1 - p <= MAX_STRING_CARRY ? span.close + 1 : p;
  };
  /** Text in front of a segment that starts at a given offset, when it begins inside a long span. */
  const openers = new Map<number, string>();

  const floor = Math.max(0, headChars - WINDOW_BEFORE);
  // A lower-cased copy, only when a case-insensitive hint needs it and the indices still line up.
  // U+0130 (a dotted capital I, in Turkish locale tables) is the one character whose lower case is
  // longer than itself, and a single one in a body would shift every index: it becomes a plain `I`
  // first, which lower-cases to one character like the rest.
  let lowered: string | null | undefined;
  const lowerContent = (): string | null => {
    if (lowered === undefined) {
      const copy = content.replaceAll("\u0130", "I").toLowerCase();
      lowered = copy.length === content.length ? copy : null;
    }
    return lowered;
  };
  /**
   * Whether the window `[start, end)` holds a match of one of the detector patterns the hint serves.
   * An `inCode` detector rejects a match that starts inside a string, regex literal or comment of the
   * whole file, so a prose or docs mention of the vendor does not qualify a window and cannot use
   * up the windows kept for the real call.
   */
  const qualifies = (spec: HintSpec, text: string, start: number): boolean => {
    for (const { plain, inCode } of spec.patterns) {
      if (!inCode) {
        if (plain.test(text)) return true;
        continue;
      }
      inCode.lastIndex = 0;
      for (let seen = 0; seen < MAX_QUALIFY_CANDIDATES; seen++) {
        const m = inCode.exec(text);
        if (!m) break;
        if (spanAt(start + m.index) === null) return true;
        if (m[0].length === 0) inCode.lastIndex++;
      }
    }
    return false;
  };

  // Qualified windows per hint, declared hints first: a window is kept only if a detector pattern
  // that uses the hint matches it, so a placeholder or an unrelated mention of the literal costs
  // nothing and takes no budget from a real match.
  const perHint: Array<{ windows: Array<[number, number]>; declared: boolean }> = [];
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
      const from160 = Math.max(floor, at - WINDOW_BEFORE);
      let cut = cutAt(from160);
      if (cut.pos > at) {
        // The hit sits in a string that opened before the window: keep a short one whole (a
        // library's own notice is a string); around a long one (prose, data, or code the tracker
        // lost) cut inside it with its opener in front.
        const span = spanAt(at);
        if (!span) continue;
        cut =
          span.close - span.open <= MAX_STRING_CARRY
            ? { pos: span.open, opener: "" }
            : { pos: from160, opener: openerOf(span.open) };
        if (cut.opener === "/") continue;
        if (cut.opener) {
          let k = 0;
          while (cut.pos - 1 - k > span.open && content.charAt(cut.pos - 1 - k) === "\\") k++;
          if (k % 2 === 1) cut = { pos: cut.pos - 1, opener: cut.opener };
        }
      }
      const start = cut.pos;
      const end = endAt(Math.min(limit, at + spec.text.length + WINDOW_AFTER));
      if (end <= start) continue;
      const text = content.slice(start, end);
      if (seen.has(text) || !qualifies(spec, text, start)) continue;
      seen.add(text);
      if (cut.opener) openers.set(start, cut.opener);
      windows.push([start, end]);
    }
    if (windows.length > 0) perHint.push({ windows, declared: spec.declared });
  }

  // Shared out round by round: every hint's first window, then every hint's second, until the
  // window budget is spent. The budget leaves the tail its reserve, so what the windows take can
  // never push out what only the tail can match (#1420). A declared hint (written by hand for a
  // detector that needs a real call, such as a Firebase or Supabase config) gets its first few
  // windows before any derived hint's first: 200 derived literals would otherwise take the whole
  // budget before a declared hint's second window, and its first can be a lookalike.
  const windowBudget = maxChars - Math.min(TAIL_RESERVE_CHARS, Math.floor(maxChars / 4));
  const chosen: Array<[number, number]> = [];
  const take = (window: [number, number] | undefined): void => {
    if (window && mergedCost([...chosen, window]) <= windowBudget) chosen.push(window);
  };
  for (let round = 0; round < DECLARED_FIRST_WINDOWS; round++) {
    for (const { windows, declared } of perHint) if (declared) take(windows[round]);
  }
  for (let round = 0; round < MAX_KEPT_PER_HINT; round++) {
    for (const { windows, declared } of perHint) {
      if (!declared || round >= DECLARED_FIRST_WINDOWS) take(windows[round]);
    }
  }
  const merged = mergeSpans(chosen);
  let used = 0;
  for (const [start, end] of merged) used += end - start + SEGMENT_SEPARATOR.length + OPENER_SLACK;
  // The tail takes what the windows left. It is one more span merged with them, so a window it
  // overlaps is not sent twice and nothing between the windows and the tail is dropped: when the
  // rest of the file fits in the room, the whole rest is kept, as before #1420.
  const tailRoom = maxChars - used - (merged.length > 0 ? SEGMENT_SEPARATOR.length : 0) - OPENER_SLACK;
  let spans = merged;
  if (tailRoom > 0 && limit === content.length) {
    const cut = cutAt(Math.max(content.length - tailRoom, headChars));
    if (cut.pos < content.length) {
      if (cut.opener) openers.set(cut.pos, cut.opener);
      spans = mergeSpans([...merged, [cut.pos, content.length]]);
    }
  }
  return spans.map(([start, end]) => (openers.get(start) ?? "") + content.slice(start, end)).join(SEGMENT_SEPARATOR);
}
