// A one-pass prefilter that answers "can this regex match this text at all?"
// without running it (#1864).
//
// The rules that hurt on a script-heavy page run a LIST of patterns over the same
// megabyte: security/leaked-secrets runs 70, perf/js-libraries runs 62 inline
// signatures. Each pass costs the same whether it finds anything or not, so the
// cost is the pass COUNT, not the work each pass finds.
//
// Merging the list into one alternation per flag group and using that as a gate
// is much worse, not better, and the measurement is worth keeping because the
// intuition points the other way. Over the 58 bodies of text on one real 1.1 MB
// page (medians of seven):
//
//   every pattern, no prefilter                      38.9 ms
//   this gram index, then the survivors              18.0 ms
//   alternation gate, then every pattern on a hit    89.0 ms
//
// The gate loses twice: an alternation of 59 patterns gives up the per-pattern
// literal-prefix search that makes each one fast on its own, and it still admits
// the page (it matched 5 of the 58 bodies), so the 70 passes happen anyway.
//
// So: make one pass, record which 4-grams the text contains in a bitmap, and use
// that to skip every pattern whose mandatory literal is provably absent. On that
// page it skips 34 of the 70 secret patterns and 17 of the 17 keyword scans per
// body, for the price of a single pass (5.4 ms across all 58).
//
// Soundness is the whole point, since a false negative silently deletes a
// finding. Two invariants carry it:
//
//   1. Every 4-gram of the text sets its bit, so a needle that IS present has
//      every one of its 4-grams set. `mayContain` can therefore only err
//      towards "maybe" (hash collisions, or the grams appearing apart). It can
//      never say "no" about a needle that is present.
//   2. `mandatoryLiterals` only ever returns literals that EVERY match of the
//      pattern must contain, and returns nothing at all when it cannot prove
//      that. A pattern with no proven literal is simply always run.

/** Roughly 32 bits of table per character of content. Below ~10% population a
 *  four-character literal is filtered on merit rather than on luck. */
const BITS_PER_CHAR = 32;

/** Below this the pass to build the index costs more than the scans it saves.
 *  Low, deliberately: a 1 KB inline script still pays 70 regex invocations in
 *  security/leaked-secrets, and a page can carry sixty of them. */
const MIN_INDEXED_LENGTH = 256;

/** The window width, and so the shortest literal that can be filtered at all: a
 *  shorter literal proves nothing and its pattern always runs. Four is what a
 *  20-bit window buys at 5 bits a character, and 20 bits is the widest table a
 *  32-bit shift-and-xor hash addresses without the window leaking (see
 *  WINDOW_MASK). Narrowing to 3 would admit `sk-`, `re_` and `AC`, at the cost of
 *  a 15-bit window and a table that saturates on a megabyte. */
const GRAM = 4;
const MIN_LITERAL_LENGTH = GRAM;

/** How many variants an optional element may expand a literal run into. */
const MAX_VARIANTS = 32;

/**
 * One text's 4-gram presence bitmap. ASCII case is folded on both sides, so
 * needles are matched case-insensitively — sound for a case-SENSITIVE pattern
 * too, since folding only widens what the filter admits.
 */
export interface GramIndex {
  readonly bits: Uint8Array;
  readonly mask: number;
  /**
   * True when the text contains a character whose `toLowerCase()` INTRODUCES an
   * ASCII character that the text itself does not have.
   *
   * The index folds ASCII case and nothing else, which is a sound
   * over-approximation of the text — but not of `text.toLowerCase()`. A caller
   * that searches a lowercased copy (security/leaked-secrets locates its context
   * keywords that way) can find a keyword the index will swear is absent:
   * `LINKEDIN` lowercases to `linkedin`, and the index, which leaves
   * U+212A alone, has no `linkedin` in it. Exactly two characters do this in the
   * whole of Unicode, so the flag costs one comparison per non-ASCII character
   * and lets such a caller fall back instead of being silently wrong.
   */
  readonly lowercaseAddsAscii: boolean;
}

// U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE lowercases to "i" + U+0307, and
// U+212A KELVIN SIGN lowercases to "k". Enumerated over every code point, they
// are the only two whose lowercase introduces an ASCII character.
const LOWERCASE_ADDS_ASCII_I = 0x0130;
const LOWERCASE_ADDS_ASCII_K = 0x212a;

// Each character contributes 5 bits of the window hash, so the window is exactly
// GRAM * SHIFT = 20 bits wide and `WINDOW_MASK` is what drops the character that
// falls off the front.
//
// Masking with the TABLE's mask instead is the bug this constant exists to
// prevent, and it is silent and severe. A 21-bit table keeps bit 20, which is
// where the low bit of the character BEFORE the window lands, so the text's hash
// for a window and the needle's hash for the same four characters disagree
// whenever the preceding character is odd. `mayContain` then returns FALSE about
// a needle that is present — the one direction that deletes findings. Measured on
// a 40 KB text (the size that first reaches the widest table): 8 of 16 present
// needles denied, one per odd predecessor. Nothing failed; the soundness test
// happened to size every fixture below the widest table.
const SHIFT = 5;
const WINDOW_MASK = (1 << (GRAM * SHIFT)) - 1;

/** Ceiling on the table: the widest a 20-bit window hash can address, 2^20 bits
 *  = 128 KB. A 1.1 MB serialised page sets 5.9% of it, and the population is
 *  what decides how often a literal survives on a collision rather than on being
 *  present. */
const GRAM_BYTES = (WINDOW_MASK + 1) >> 3;

/**
 * Index `text`'s 4-grams, or return null when the text is too short to be worth
 * indexing (the caller then runs every pattern, exactly as before).
 *
 * The bitmap is allocated per call rather than shared. A shared scratch buffer
 * would be faster by a hair and would alias the moment two scans overlapped, and
 * an index that silently belongs to someone else's text is a wrong answer in the
 * one direction that deletes findings.
 */
export function buildGramIndex(text: string): GramIndex | null {
  if (text.length < MIN_INDEXED_LENGTH) return null;
  // Size the table to the content: a 5 KB script does not need 128 KB of bitmap,
  // and a smaller table is both cheaper to allocate and no less sound.
  let bytes = 1 << 7; // 2^10 bits
  while (bytes < GRAM_BYTES && bytes * 8 < text.length * BITS_PER_CHAR) bytes <<= 1;
  const mask = bytes * 8 - 1;
  const bits = new Uint8Array(bytes);
  let h = 0;
  let lowercaseAddsAscii = false;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      c += 32; // fold ASCII case
    } else if (c > 0x7f && (c === LOWERCASE_ADDS_ASCII_I || c === LOWERCASE_ADDS_ASCII_K)) {
      lowercaseAddsAscii = true;
    }
    // Four characters of 5 bits each fill the window exactly, so the fifth
    // character back falls off the top. WINDOW_MASK, not `mask`, is what makes
    // it fall off: see the note on WINDOW_MASK.
    h = ((h << SHIFT) ^ c) & WINDOW_MASK;
    if (i >= GRAM - 1) {
      const slot = h & mask;
      bits[slot >> 3]! |= 1 << (slot & 7);
    }
  }
  return { bits, mask, lowercaseAddsAscii };
}

/**
 * True when `needle` MAY appear in the indexed text. False is a proof of absence
 * for any ASCII needle; true is a maybe. ASCII case is folded here exactly as it
 * is in `buildGramIndex`, so the caller does not have to pre-lowercase.
 */
export function mayContain(index: GramIndex, needle: string): boolean {
  if (needle.length < GRAM) return true;
  const { bits, mask } = index;
  let h = 0;
  for (let i = 0; i < needle.length; i++) {
    let c = needle.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    h = ((h << SHIFT) ^ c) & WINDOW_MASK;
    if (i >= GRAM - 1) {
      const slot = h & mask;
      if ((bits[slot >> 3]! & (1 << (slot & 7))) === 0) return false;
    }
  }
  return true;
}

/**
 * A conjunction of any-of sets: EVERY entry has at least one member that every
 * match of the pattern contains. An empty array means "nothing proven".
 */
export type MandatoryLiterals = readonly (readonly string[])[];

/**
 * True when the pattern behind `literals` may match the indexed text. An empty
 * `literals` (nothing proven) always returns true.
 */
export function mayMatch(index: GramIndex | null, literals: MandatoryLiterals): boolean {
  if (!index || literals.length === 0) return true;
  for (const anyOf of literals) {
    let possible = false;
    for (const lit of anyOf) {
      if (mayContain(index, lit)) {
        possible = true;
        break;
      }
    }
    if (!possible) return false;
  }
  return true;
}

// ── mandatory-literal extraction ────────────────────────────────────────────

const META = new Set([".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "^", "$", "\\"]);
// Escapes that stand for a literal character rather than a class.
const LITERAL_ESCAPE = new Set([
  ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "^", "$", "\\", "/", "-", "@", "#", "&",
  "=", ":", ";", ",", "<", ">", "'", '"', "`", "~", "!", "%", "_",
]);

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}

/**
 * The escape starting at `src[i] === "\\"`: the single character it denotes, or
 * null when it denotes a CLASS (`\\d`, `\\w`, `\\b`) rather than a character.
 *
 * `end` matters as much as `char`. Reading `\\u0275cmp` as a two-character escape
 * leaves `0275cmp` behind as literal text, and a literal the pattern cannot
 * actually contain is exactly the filter answer that deletes a finding — this was
 * a live bug caught by the soundness test, on Angular's `\\["\u0275cmp"\\]`.
 */
function readEscape(src: string, i: number): { char: string | null; end: number } {
  const n = src[i + 1];
  if (n === undefined) return { char: null, end: i + 1 };
  if (n === "u") {
    // `\u{...}` is a code point only under the `u` flag; without it the same
    // source is the letter `u` repeated. The two readings share no characters,
    // so neither is claimed. Consume only `\u` and let the main loop meet the
    // brace: SEARCHING for the closing `}` is what lands inside somebody else's
    // structure, since in legacy mode `\u{[abcd}efgh]` has its `}` inside a
    // character class and skipping to it leaves `efgh]` behind as literal text.
    if (src[i + 2] === "{") return { char: null, end: i + 2 };
    const hex = src.slice(i + 2, i + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { char: null, end: i + 2 };
    return { char: String.fromCharCode(Number.parseInt(hex, 16)), end: i + 6 };
  }
  if (n === "x") {
    const hex = src.slice(i + 2, i + 4);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return { char: null, end: i + 2 };
    return { char: String.fromCharCode(Number.parseInt(hex, 16)), end: i + 4 };
  }
  if (n === "c") return { char: null, end: i + 3 };
  if (n === "n") return { char: "\n", end: i + 2 };
  if (n === "t") return { char: "\t", end: i + 2 };
  if (n === "r") return { char: "\r", end: i + 2 };
  if (n === "f") return { char: "\f", end: i + 2 };
  if (n === "v") return { char: "\v", end: i + 2 };
  if (LITERAL_ESCAPE.has(n)) return { char: n, end: i + 2 };
  // \d \w \s \D \W \S \b \B \p{..} \1 … — a class or an assertion, not a
  // character. Everything but the two-character form is skipped wholesale.
  // `\p{...}` is a property escape only under the `u` flag; in legacy mode it is
  // the letter `p` and the brace belongs to whatever follows. Consume two
  // characters either way, for the same reason as `\u{` above.
  if (n === "p" || n === "P") return { char: null, end: i + 2 };
  // `\k<name>` is a named backreference, and stopping after `\k` would leave
  // `<name>` behind as literal text the match never contains.
  if (n === "k" && src[i + 2] === "<") {
    const close = src.indexOf(">", i + 3);
    return { char: null, end: close === -1 ? i + 2 : close + 1 };
  }
  // A backreference or octal escape runs to the end of its digits. Consuming
  // only two characters leaves `\12`'s `2` behind as literal text, and what
  // group 12 matched is not the digit 2.
  if (n >= "0" && n <= "9") {
    let end = i + 2;
    while (end < src.length && src[end]! >= "0" && src[end]! <= "9") end += 1;
    return { char: null, end };
  }
  return { char: null, end: i + 2 };
}

/**
 * The quantifier starting at `i`, or null. `min0` means it can match zero times;
 * `max1` means it can match at most once.
 *
 * `max1` is load-bearing and was missing. A literal run is only a run because its
 * characters are ADJACENT, so an element that can repeat inserts characters the
 * variants do not have: expanding `abcdz{0,3}efgh` to {`abcdefgh`, `abcdzefgh`}
 * denies `abcdzzefgh`, which the pattern matches. Every element that can repeat
 * therefore ends the run instead of expanding it.
 */
function readQuantifier(
  src: string,
  i: number
): { end: number; min0: boolean; max1: boolean } | null {
  const c = src[i];
  if (c === "?") {
    return { end: src[i + 1] === "?" ? i + 2 : i + 1, min0: true, max1: true };
  }
  if (c === "*") {
    return { end: src[i + 1] === "?" ? i + 2 : i + 1, min0: true, max1: false };
  }
  if (c === "+") {
    return { end: src[i + 1] === "?" ? i + 2 : i + 1, min0: false, max1: false };
  }
  if (c === "{") {
    const close = src.indexOf("}", i);
    if (close === -1) return null;
    const body = src.slice(i + 1, close);
    if (!/^\d+(,\d*)?$/.test(body)) return null;
    const [minText, maxText] = body.split(",");
    const min = Number(minText);
    // `{n}` is exactly n; `{n,}` is unbounded; `{n,m}` is at most m.
    const max = maxText === undefined ? min : maxText === "" ? Number.POSITIVE_INFINITY : Number(maxText);
    return {
      end: src[close + 1] === "?" ? close + 2 : close + 1,
      min0: min === 0,
      max1: max <= 1,
    };
  }
  return null;
}

/** The characters a single-character class `[abc]` can match, or null. */
function simpleClassChars(body: string): string[] | null {
  if (body.startsWith("^")) return null;
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\") {
      const esc = readEscape(body, i);
      if (esc.char === null) return null;
      out.push(esc.char);
      i = esc.end - 1;
      continue;
    }
    if (c === "-" && i > 0 && i < body.length - 1) return null; // a range, not a set
    out.push(c);
  }
  return out.length > 0 && out.length <= 4 ? out : null;
}

/** Index of the `)` closing the group that opens at `open`, or -1. */
function matchingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "[") {
      const close = closeClass(src, i);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Index of the `]` closing the class that opens at `open`, or -1.
 *
 * JavaScript has no Perl `[]]`: `[]` is an EMPTY class that matches nothing and
 * ends at its first `]`. Treating that `]` as literal walks the scan past the
 * class and into whatever follows — `/abcd[]|efgh/` then looks like one branch
 * rather than two, and `abcd` gets proved for a pattern that matches `efgh`.
 * `[^]` is the one case where the first `]` is not at `open + 1`.
 */
function closeClass(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "]") return i;
  }
  return -1;
}

/** Split a group body on its TOP-LEVEL `|`. */
function splitAlternatives(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "[") {
      const close = closeClass(src, i);
      if (close === -1) break;
      i = close;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "|" && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

/** Strip a group's `(?:` / `(?<name>` / `(` prefix, returning the body. */
function groupBody(inner: string): string | null {
  if (inner.startsWith("?:")) return inner.slice(2);
  if (inner.startsWith("?<") && !inner.startsWith("?<=") && !inner.startsWith("?<!")) {
    const close = inner.indexOf(">");
    return close === -1 ? null : inner.slice(close + 1);
  }
  if (inner.startsWith("?")) return null; // lookaround, flags — no mandatory content
  return inner;
}

function cross(variants: string[], suffixes: string[]): string[] | null {
  const out: string[] = [];
  for (const v of variants) {
    for (const s of suffixes) {
      out.push(v + s);
      if (out.length > MAX_VARIANTS) return null;
    }
  }
  return out;
}

/**
 * Extract literals that every match of `source` must contain.
 *
 * Conservative by construction: anything it cannot reason about ends the current
 * literal run and contributes nothing, so the worst case is an empty result and
 * the pattern running exactly as it does today.
 */
export function mandatoryLiterals(pattern: RegExp): MandatoryLiterals {
  // Unicode mode changes both halves of the reasoning below and is declined
  // whole. Under `u`/`v` the `i` flag uses simple case folding, so `/secret/iu`
  // matches `ſecret` and `/mark/iu` matches `marK` — neither subject contains
  // the ASCII literal, and the index only folds ASCII. `v` additionally nests
  // character classes, which the class scanner does not parse. Every pattern the
  // rules ship today is legacy; one that is not simply runs unfiltered.
  if (pattern.unicode || pattern.unicodeSets) return [];
  const out: string[][] = [];
  extractInto(pattern.source, out, 0);
  return out;
}

function extractInto(source: string, out: string[][], depth: number): void {
  if (depth > 4) return;

  const branches = splitAlternatives(source);
  if (branches.length > 1) {
    // A match takes exactly one branch, so one literal per branch forms an
    // any-of set. If ANY branch proves nothing, the alternation proves nothing.
    const anyOf: string[] = [];
    for (const branch of branches) {
      const sub: string[][] = [];
      extractInto(branch, sub, depth + 1);
      // A match down this branch has at least one member of each of the branch's
      // proven sets. Take the set whose WEAKEST member is longest and union it in:
      // whichever branch runs, one of the union's members is present.
      let best: string[] | null = null;
      for (const set of sub) {
        const weakest = Math.min(...set.map((s) => s.length));
        if (best === null || weakest > Math.min(...best.map((s) => s.length))) best = set;
      }
      if (best === null) return;
      anyOf.push(...best);
    }
    if (anyOf.length > 0) out.push(anyOf);
    return;
  }

  let variants: string[] = [""];
  const flush = () => {
    const usable = variants.filter((v) => v.length >= MIN_LITERAL_LENGTH && isAscii(v));
    if (usable.length === variants.length && usable.length > 0) {
      out.push(usable.map((v) => v.toLowerCase()));
    }
    variants = [""];
  };

  /**
   * Extend the run under construction by one element, which matches any of
   * `members`, under quantifier `q` (null meaning exactly once).
   *
   * The run's whole value is that its characters are ADJACENT in the subject, so
   * the only elements that can extend it are the ones that contribute a bounded,
   * known number of characters. Anything that can repeat ends the run: what comes
   * after it is no longer adjacent to what came before.
   */
  const append = (members: string[], q: { min0: boolean; max1: boolean } | null): void => {
    if (!q || q.max1) {
      // Exactly once, or none-or-once: every possibility is still one run.
      const next = cross(variants, q?.min0 ? ["", ...members] : members);
      if (next) variants = next;
      else flush();
      return;
    }
    if (!q.min0) {
      // At least once and possibly more: the run reaches through exactly one
      // occurrence and stops there.
      variants = cross(variants, members) ?? variants;
      flush();
      return;
    }
    // Zero or more: nothing is guaranteed and nothing after it is adjacent.
    flush();
  };

  for (let i = 0; i < source.length; ) {
    const c = source[i]!;

    // escape
    if (c === "\\") {
      const esc = readEscape(source, i);
      const lit = esc.char;
      if (lit === null || !isAscii(lit)) {
        // The atom proves nothing, but its QUANTIFIER still has to be consumed:
        // leaving `\d{1000}` half-read hands `1000` to the main loop as four
        // literal characters, and a match of `abcd\d{1000}efgh` contains no
        // `1000` at all.
        const unprovableQ = readQuantifier(source, esc.end);
        flush();
        i = unprovableQ ? unprovableQ.end : esc.end;
        continue;
      }
      const q = readQuantifier(source, esc.end);
      append([lit], q);
      i = q ? q.end : esc.end;
      continue;
    }

    // character class
    if (c === "[") {
      const close = closeClass(source, i);
      if (close === -1) {
        flush();
        break;
      }
      const q = readQuantifier(source, close + 1);
      const chars = simpleClassChars(source.slice(i + 1, close));
      if (chars) append(chars, q);
      else flush();
      i = q ? q.end : close + 1;
      continue;
    }

    // group
    if (c === "(") {
      const close = matchingParen(source, i);
      if (close === -1) {
        flush();
        break;
      }
      const q = readQuantifier(source, close + 1);
      const body = groupBody(source.slice(i + 1, close));
      const alts = body === null ? null : splitAlternatives(body);
      const pureLiterals =
        // Every character here must mean ITSELF. `.` is a wildcard, so
        // `/(abcd.efgh)/` proved `abcd.efgh` and denied `abcdXefgh`, which it
        // matches. Groups holding anything else fall through to extractInto,
        // which reads the regex properly.
        alts && alts.every((a) => a.length > 0 && /^[A-Za-z0-9_@#/:\-]+$/.test(a)) ? alts : null;
      if (pureLiterals) {
        append(pureLiterals, q);
      } else {
        flush();
        // The group's own mandatory literals hold only if the group is certain
        // to run: `(?:…)?` and `(?:…)*` prove nothing about the subject.
        if (body !== null && !q?.min0) extractInto(body, out, depth + 1);
      }
      i = q ? q.end : close + 1;
      continue;
    }

    // anchors and dot
    if (c === "^" || c === "$" || c === ".") {
      const q = c === "." ? readQuantifier(source, i + 1) : null;
      flush();
      i = q ? q.end : i + 1;
      continue;
    }

    if (META.has(c)) {
      // A `{n,m}` that reaches here quantifies something already flushed, so its
      // digits are not literal text to be collected. Skipping the whole brace
      // costs precision in the one case where it really is literal (`^{2}abc`
      // matches `{2}abc` in legacy mode) and never invents a literal.
      const braceQ = c === "{" ? readQuantifier(source, i) : null;
      flush();
      i = braceQ ? braceQ.end : i + 1;
      continue;
    }

    // plain literal character
    const q = readQuantifier(source, i + 1);
    append([c], q);
    i = q ? q.end : i + 1;
  }
  flush();
}

/**
 * Pair a pattern with the literals it must contain, computed once at module
 * load. `mandatoryLiterals` walks the regex SOURCE, so doing it per page would
 * be its own per-page cost.
 */
export function withPrefilter<T extends { pattern: RegExp }>(
  entries: readonly T[]
): Array<T & { literals: MandatoryLiterals }> {
  return entries.map((e) => ({ ...e, literals: mandatoryLiterals(e.pattern) }));
}
