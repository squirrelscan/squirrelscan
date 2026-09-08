// The prefilter behind #1864 decides, from a one-pass 3-gram index, that a
// pattern CANNOT match a page and skips running it. A wrong answer in that
// direction silently deletes a security finding, so the tests here are about
// one property and nothing else: `mandatoryLiterals` must only ever return
// literals that every match of the pattern really does contain.
//
// Proving that by inspection does not scale to 70 secret patterns and 130
// library patterns, so the main test GENERATES strings from each pattern's own
// source, keeps the ones the pattern actually matches, and asserts the filter
// admits every one of them. A regression in the extractor — treating an optional
// group as mandatory, walking into a lookahead, mishandling `{0,3}` — shows up
// as an admitted string the filter rejects.

import { describe, expect, test } from "bun:test";

import {
  buildGramIndex,
  mandatoryLiterals,
  mayContain,
  mayMatch,
} from "../src/shared/literal-prefilter";
import { CONTEXT_PATTERNS, FAST_PATTERNS } from "../src/security/leaked-secrets";
import { LIBRARY_INLINE_PATTERNS } from "../src/performance/js-libraries";

// ── a tiny generator: build strings FROM a regex source ─────────────────────
// Supports the syntax the rule tables actually use: literals, escapes, classes
// with ranges and negation, `\d \w \s \S \w`, the four quantifier forms, groups,
// and alternation. Anything else throws, which fails the test loudly rather than
// quietly generating a string that does not exercise the pattern.

let seed = 0x2f6e2b1;
function rnd(n: number): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
}
const SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function expandClass(body: string): string {
  let negated = false;
  let i = 0;
  if (body[0] === "^") {
    negated = true;
    i = 1;
  }
  const chars: string[] = [];
  for (; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\") {
      const n = body[++i]!;
      if (n === "d") chars.push(..."0123456789");
      else if (n === "w") chars.push(..."abcxyzABCXYZ0189_");
      else if (n === "s") chars.push(" ");
      else chars.push(n);
      continue;
    }
    if (body[i + 1] === "-" && i + 2 < body.length && body[i + 2] !== "]") {
      const from = body.charCodeAt(i);
      const to = body.charCodeAt(i + 2);
      for (let c2 = from; c2 <= to && c2 - from < 64; c2++) chars.push(String.fromCharCode(c2));
      i += 2;
      continue;
    }
    chars.push(c);
  }
  if (!negated) return chars.join("");
  const banned = new Set(chars);
  return [...SAFE].filter((c) => !banned.has(c)).join("");
}

function closeAt(src: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[" && openCh !== "[") {
      i = closeAt(src, i, "[", "]");
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${openCh} in ${src}`);
}

function splitTop(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      i = closeAt(src, i, "[", "]");
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

function generate(src: string, depth = 0): string {
  if (depth > 6) return "";
  const alts = splitTop(src);
  if (alts.length > 1) return generate(alts[rnd(alts.length)]!, depth + 1);

  let out = "";
  for (let i = 0; i < src.length; ) {
    let unit: string[] | null = null; // the characters this unit may emit
    let literal: string | null = null;

    const c = src[i]!;
    if (c === "\\") {
      const n = src[i + 1]!;
      // Every branch here MUST advance `i`. A class escape that set `unit` and
      // left `i` alone appended its character forever, which is how this whole
      // file came to have never run.
      if (n === "d") {
        unit = [..."0123456789"];
        i += 2;
      } else if (n === "w") {
        unit = [..."abcxyzABCXYZ0189_"];
        i += 2;
      } else if (n === "s") {
        unit = [" "];
        i += 2;
      } else if (n === "S") {
        unit = [..."abcXYZ019"];
        i += 2;
      } else if (n === "D") {
        unit = [..."abcXYZ_-"];
        i += 2;
      } else if (n === "b" || n === "B") {
        i += 2;
        continue;
      } else if (n === "u" && src[i + 2] === "{") {
        const close = src.indexOf("}", i + 3);
        literal = String.fromCodePoint(Number.parseInt(src.slice(i + 3, close), 16));
        i = close + 1;
        // fall through to the quantifier read below
        const q0 = src[i];
        if (q0 === undefined) {
          out += literal;
          continue;
        }
      } else if (n === "u") {
        literal = String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 6), 16));
        i += 6;
      } else if (n === "x") {
        literal = String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 4), 16));
        i += 4;
      } else if (n === "n") {
        literal = "\n";
        i += 2;
      } else if (n === "t") {
        literal = "\t";
        i += 2;
      } else if (n === "r") {
        literal = "\r";
        i += 2;
      } else {
        literal = n;
        i += 2;
      }
    } else if (c === "[") {
      const close = closeAt(src, i, "[", "]");
      unit = [...expandClass(src.slice(i + 1, close))];
      i = close + 1;
    } else if (c === "(") {
      const close = closeAt(src, i, "(", ")");
      let inner = src.slice(i + 1, close);
      i = close + 1;
      if (inner.startsWith("?=") || inner.startsWith("?!")) continue;
      if (inner.startsWith("?:")) inner = inner.slice(2);
      else if (inner.startsWith("?<") && !inner.startsWith("?<=") && !inner.startsWith("?<!"))
        inner = inner.slice(inner.indexOf(">") + 1);
      literal = generate(inner, depth + 1);
    } else if (c === "." ) {
      unit = [..."abcXYZ019-_."];
      i += 1;
    } else if (c === "^" || c === "$") {
      i += 1;
      continue;
    } else if (c === "*" || c === "+" || c === "?" || c === "{" || c === ")" || c === "]") {
      throw new Error(`dangling ${c} in ${src}`);
    } else {
      literal = c;
      i += 1;
    }

    // quantifier
    let lo = 1;
    let hi = 1;
    const q = src[i];
    if (q === "?") {
      lo = 0;
      hi = 1;
      i += 1;
    } else if (q === "*") {
      lo = 0;
      hi = 3;
      i += 1;
    } else if (q === "+") {
      lo = 1;
      hi = 3;
      i += 1;
    } else if (q === "{") {
      const close = src.indexOf("}", i);
      const body = src.slice(i + 1, close);
      const [a, b] = body.split(",");
      lo = Number(a);
      hi = b === undefined ? lo : b === "" ? lo + 2 : Number(b);
      i = close + 1;
    }
    if (src[i] === "?") i += 1; // lazy

    const times = lo + rnd(Math.max(1, Math.min(hi, lo + 3) - lo + 1));
    for (let k = 0; k < times; k++) {
      out += unit ? unit[rnd(unit.length)] : literal;
    }
  }
  return out;
}

// Filler that contains no 3-gram of any pattern literal by construction: a long
// run of one character has exactly one 3-gram.
const FILLER = "\u0007".repeat(8000);

function admits(pattern: RegExp, sample: string): boolean {
  const text = `${FILLER}${sample}${FILLER}`;
  return mayMatch(buildGramIndex(text), mandatoryLiterals(pattern));
}

const ALL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  ...FAST_PATTERNS.map((p) => ({ label: `secret/${p.name}`, pattern: p.pattern })),
  ...CONTEXT_PATTERNS.map((p) => ({ label: `context/${p.name}`, pattern: p.pattern })),
  ...LIBRARY_INLINE_PATTERNS.map((p, i) => ({ label: `lib/${i}:${p.source}`, pattern: p })),
];

describe("mandatoryLiterals is sound on every pattern the rules ship", () => {
  test("every generated match is admitted by the prefilter", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const { label, pattern } of ALL_PATTERNS) {
      const probe = new RegExp(pattern.source, pattern.flags.replace("g", ""));
      let admittedAny = false;
      for (let n = 0; n < 60; n++) {
        let sample: string;
        try {
          sample = generate(pattern.source);
        } catch (e) {
          failures.push(`${label}: generator: ${(e as Error).message}`);
          break;
        }
        // Only samples the pattern really matches say anything about soundness.
        if (!probe.test(sample)) continue;
        admittedAny = true;
        checked += 1;
        if (!admits(pattern, sample)) {
          failures.push(`${label}: filter REJECTED a real match: ${JSON.stringify(sample.slice(0, 120))}`);
          break;
        }
      }
      if (!admittedAny) failures.push(`${label}: generator produced no matching sample`);
    }
    expect(failures).toEqual([]);
    // Guard against the loop silently doing nothing.
    expect(checked).toBeGreaterThan(ALL_PATTERNS.length * 10);
  });
});

describe("the gram index", () => {
  test("never denies a substring that is present", () => {
    const text = `${"x".repeat(5000)}AKIAIOSFODNN7EXAMPLE${"y".repeat(5000)}`;
    const index = buildGramIndex(text)!;
    expect(index).not.toBeNull();
    for (let len = 3; len <= 12; len++) {
      for (let start = 0; start + len <= text.length; start += 97) {
        const needle = text.slice(start, start + len).toLowerCase();
        expect(mayContain(index, needle)).toBe(true);
      }
    }
  });

  // The table doubles with the content until it hits its ceiling, and only the
  // widest table exercised the window mask. Every fixture above sits below it,
  // which is why the leak went unnoticed; a script-heavy page reaches it on its
  // first 40 KB bundle.
  test("never denies a present substring in text wide enough for the largest table", () => {
    const needle = "akiaiosfodnn7example";
    const denied: string[] = [];
    // The leak was the low bit of the character BEFORE the window, so the
    // predecessor has to be varied: with the bug this denied every odd one.
    for (const prev of [..."abcdefghxyz0123456789"]) {
      const text = `${"q".repeat(40_000)}${prev}AKIAIOSFODNN7EXAMPLE${"w".repeat(40_000)}`;
      const index = buildGramIndex(text)!;
      if (!mayContain(index, needle)) denied.push(prev);
    }
    expect(denied).toEqual([]);
  });

  test("folds ASCII case on the needle as well, so an uppercase literal is found", () => {
    const index = buildGramIndex(`${"q".repeat(40_000)}akiaiosfodnn7example`)!;
    expect(mayContain(index, "AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  test("denies literals that are absent", () => {
    const index = buildGramIndex("z".repeat(9000))!;
    expect(mayContain(index, "akia")).toBe(false);
    expect(mayContain(index, "-----begin rsa private key-----")).toBe(false);
  });

  test("folds ASCII case so a lowercase needle finds uppercase text", () => {
    const index = buildGramIndex(`${"q".repeat(6000)}AKIAIOSFODNN7EXAMPLE`)!;
    expect(mayContain(index, "akiaiosfodnn7example")).toBe(true);
  });

  test("is skipped below the size floor, and a null index admits everything", () => {
    expect(buildGramIndex("short")).toBeNull();
    expect(mayMatch(null, [["definitely-absent"]])).toBe(true);
  });
});

describe("mandatoryLiterals extraction", () => {
  const cases: Array<[RegExp, string[][]]> = [
    [/AKIA[A-Z0-9]{16}/, [["akia"]]],
    // a literal shorter than the four-character window proves nothing, so only
    // the second run survives here
    [/sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}/, [["t3blbkfj"]]],
    // an optional group contributes nothing and must not glue the runs together
    [/mongodb(\+srv)?:\/\/[^\s"'<>]+/i, [["mongodb"]]],
    // a top-level alternation yields one any-of set
    [/redis(s)?:\/\//i, [["redis://", "rediss://"]]],
    // an optional single-character class expands into variants
    [/apikeys?[_-]?value/i, [["apikeyvalue", "apikey_value", "apikey-value", "apikeysvalue", "apikeys_value", "apikeys-value"]]],
    // a `+` keeps its own character but ends the run after it
    [/abcde+fghij/, [["abcde"], ["fghij"]]],
    // `{0,3}` can repeat, so it ENDS the run: gluing the two sides would deny
    // `abcdzzefgh`, which the pattern matches
    [/abcdz{0,3}efgh/, [["abcd"], ["efgh"]]],
    // `{0,1}` cannot repeat, so it expands in place
    [/abcdz{0,1}efgh/, [["abcdefgh", "abcdzefgh"]]],
    // a lookahead proves nothing
    [/(?=foo)barbaz/, [["barbaz"]]],
    // a literal shorter than the floor proves nothing
    [/AC[0-9a-f]{32}/, []],
    // a \uXXXX escape is ONE character, so the run restarts AFTER it and its hex
    // digits never become literal text: `0275cmp` here would be a literal no
    // match can contain. Angular's real signature, and the case that first
    // proved readEscape has to consume all six characters.
    [/\["\u0275cmp"\]/, [['cmp"]']]],
    // the same signature written with the character itself: non-ASCII ends the
    // run and the run is discarded, so nothing is proven
    [new RegExp(`\\["${String.fromCharCode(0x0275)}cmp"\\]`), []],
    [/prefix\u0041\u0042suffix/, [["prefixabsuffix"]]],
  ];
  for (const [re, expected] of cases) {
    test(`${re.source} → ${JSON.stringify(expected)}`, () => {
      expect(mandatoryLiterals(re).map((s) => [...s])).toEqual(expected);
    });
  }

  // Both cases below are regressions, and both were silent: the filter denied a
  // literal that was present, and nothing failed.
  test("an element that can REPEAT ends the run instead of gluing it", () => {
    // Each subject is one the pattern really matches, with the repeatable
    // element appearing more than once — which is exactly what a glued run
    // (`abcd` + `z` + `efgh`) is not a substring of.
    const cases: Array<[RegExp, string]> = [
      [/abcdz{0,3}efgh/, "abcdzzefgh"],
      [/abcdz*efgh/, "abcdzzzefgh"],
      [/abcd[xy]*efgh/, "abcdxyefgh"],
      [/abcd[xy]{0,4}efgh/, "abcdxxefgh"],
      [/abcd(?:xy)*efgh/, "abcdxyxyefgh"],
      [/abcd(?:xy)+efgh/, "abcdxyxyefgh"],
      [/abcdz+efgh/, "abcdzzefgh"],
      [/abcd\.{0,2}efgh/, "abcd..efgh"],
    ];
    const failures: string[] = [];
    for (const [pattern, subject] of cases) {
      if (!pattern.test(subject)) {
        failures.push(`${pattern.source}: fixture does not match ${subject}`);
        continue;
      }
      if (!admits(pattern, subject)) {
        failures.push(`${pattern.source}: filter REJECTED ${subject}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // An escape read as shorter than it is leaves its own tail behind as "literal
  // text", and that text is exactly what no match contains. All three of these
  // denied a real match.
  test("an escape whose length is misread does not invent a literal", () => {
    const cases: Array<[RegExp, string]> = [
      // `\12` is a backreference to group 12, not `\1` followed by the digit 2.
      [/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)wxyz\12abcd/, "abcdefghijklwxyzlabcd"],
      // `\k<x>` is a named backreference, not `\k` followed by `<x>`.
      [/(?<x>zz)wxyz\k<x>abcd/, "zzwxyzzzabcd"],
      // Without the `u` flag `\u{41}` is the letter `u` repeated 41 times, not
      // the code point 0x41 — and the two readings share no characters, so
      // neither may be claimed.
      [/wxyz\u{41}abcd/, `wxyz${"u".repeat(41)}abcd`],
    ];
    const failures: string[] = [];
    for (const [pattern, subject] of cases) {
      if (!pattern.test(subject)) {
        failures.push(`${pattern.source}: fixture does not match`);
        continue;
      }
      if (!admits(pattern, subject)) failures.push(`${pattern.source}: filter REJECTED a real match`);
    }
    expect(failures).toEqual([]);
  });

  test("an unproven pattern is always run", () => {
    const index = buildGramIndex("z".repeat(9000))!;
    expect(mayMatch(index, mandatoryLiterals(/[0-9]{8,10}:[a-zA-Z0-9_-]{35}/))).toBe(true);
  });
});
