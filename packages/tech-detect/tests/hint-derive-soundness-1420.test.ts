// #1420: a derived search literal must occur in EVERY string its pattern can match, or the sampler
// would skip the one window that holds the match. Substring-of-the-source is not enough (`\x60foobar`
// puts "60foobar" in the source and "`foobar" is what matches), so this builds strings from each
// pattern with a small generator and checks the hint against them.

import { describe, expect, test } from "bun:test";

import { ALL_FINGERPRINTS } from "../src/fingerprints";
import { alternatives, deriveHints } from "../src/hint-derive";

type Node =
  | { t: "lit"; s: string }
  | { t: "set"; chars: string[]; negated: boolean }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; opts: Node[] }
  | { t: "rep"; n: Node; min: number; max: number };

const EMPTY: Node = { t: "lit", s: "" };
const SAFE = [..."abcxyz019_- "];

function hexChar(src: string, at: number, len: number): { s: string; next: number } {
  const digits = src.slice(at, at + len);
  return { s: String.fromCodePoint(Number.parseInt(digits, 16)), next: at + len };
}

/** An escape after the backslash at `i`: its node (or a literal) and the index after it. */
function parseEscape(src: string, i: number, inClass: boolean): { node: Node; next: number } {
  const c = src[i + 1]!;
  let at = i + 2;
  const lit = (s: string): { node: Node; next: number } => ({ node: { t: "lit", s }, next: at });
  switch (c) {
    case "d":
      return lit("7");
    case "D":
    case "S":
    case "W":
      return { node: { t: "lit", s: c === "W" ? "-" : "x" }, next: at };
    case "s":
      return lit(" ");
    case "w":
      return lit("a");
    case "b":
    case "B":
      return inClass ? lit(c === "b" ? "\b" : "B") : { node: EMPTY, next: at };
    case "n":
      return lit("\n");
    case "t":
      return lit("\t");
    case "r":
      return lit("\r");
    case "f":
      return lit("\f");
    case "v":
      return lit("\v");
    case "x": {
      const r = hexChar(src, at, 2);
      return { node: { t: "lit", s: r.s }, next: r.next };
    }
    case "u": {
      if (src[at] === "{") {
        const close = src.indexOf("}", at);
        return { node: { t: "lit", s: String.fromCodePoint(Number.parseInt(src.slice(at + 1, close), 16)) }, next: close + 1 };
      }
      const r = hexChar(src, at, 4);
      return { node: { t: "lit", s: r.s }, next: r.next };
    }
    case "c":
      return { node: { t: "lit", s: String.fromCharCode(src.charCodeAt(at) % 32) }, next: at + 1 };
    case "p":
    case "P": {
      const close = src.indexOf("}", at);
      return { node: { t: "lit", s: "a" }, next: close + 1 };
    }
    case "k": {
      const close = src.indexOf(">", at);
      return { node: EMPTY, next: close + 1 };
    }
    default:
      if (/[0-9]/.test(c)) {
        while (/[0-9]/.test(src[at] ?? "")) at++;
        return { node: EMPTY, next: at };
      }
      return lit(c);
  }
}

function parseClass(src: string, open: number): { node: Node; next: number } {
  let i = open + 1;
  const negated = src[i] === "^";
  if (negated) i++;
  const chars: string[] = [];
  const one = (): string => {
    if (src[i] === "\\") {
      const e = parseEscape(src, i, true);
      i = e.next;
      return e.node.t === "lit" ? e.node.s : "";
    }
    return src[i++]!;
  };
  while (i < src.length && src[i] !== "]") {
    const from = one();
    if (src[i] === "-" && src[i + 1] !== "]" && i + 1 < src.length) {
      i++;
      const to = one();
      const lo = from.codePointAt(0)!;
      const hi = Math.min(to.codePointAt(0)!, lo + 255);
      for (let k = lo; k <= hi; k++) chars.push(String.fromCodePoint(k));
    } else chars.push(from);
  }
  return { node: { t: "set", chars, negated }, next: i + 1 };
}

function parseSeq(src: string, from: number): { node: Node; next: number } {
  const items: Node[] = [];
  let i = from;
  while (i < src.length && src[i] !== "|" && src[i] !== ")") {
    let atom: Node;
    const c = src[i]!;
    if (c === "(") {
      let j = i + 1;
      let look = false;
      if (src[j] === "?") {
        if (src[j + 1] === ":") j += 2;
        else if (src[j + 1] === "=" || src[j + 1] === "!") {
          look = true;
          j += 2;
        } else if (src[j + 1] === "<" && (src[j + 2] === "=" || src[j + 2] === "!")) {
          look = true;
          j += 3;
        } else if (src[j + 1] === "<") j = src.indexOf(">", j) + 1;
      }
      const inner = parseAlt(src, j);
      i = inner.next + 1;
      atom = look ? EMPTY : inner.node;
    } else if (c === "[") {
      const cls = parseClass(src, i);
      atom = cls.node;
      i = cls.next;
    } else if (c === "\\") {
      const e = parseEscape(src, i, false);
      atom = e.node;
      i = e.next;
    } else if (c === "." ) {
      atom = { t: "lit", s: "a" };
      i++;
    } else if (c === "^" || c === "$") {
      atom = EMPTY;
      i++;
    } else {
      atom = { t: "lit", s: c };
      i++;
    }
    // Quantifier.
    const q = src[i];
    let min = 1;
    let max = 1;
    if (q === "*") [min, max, i] = [0, 3, i + 1];
    else if (q === "+") [min, max, i] = [1, 3, i + 1];
    else if (q === "?") [min, max, i] = [0, 1, i + 1];
    else if (q === "{") {
      const close = src.indexOf("}", i);
      const m = /^\{(\d+)(?:(,)(\d*))?\}$/.exec(src.slice(i, close + 1));
      if (m) {
        min = Number(m[1]);
        max = m[2] ? (m[3] ? Number(m[3]) : min + 2) : min;
        i = close + 1;
      }
    }
    if (src[i] === "?" && (q === "*" || q === "+" || q === "}" || q === "?")) i++;
    items.push(min === 1 && max === 1 ? atom : { t: "rep", n: atom, min, max: Math.min(max, min + 2) });
  }
  return { node: { t: "seq", items }, next: i };
}

function parseAlt(src: string, from: number): { node: Node; next: number } {
  const opts: Node[] = [];
  let i = from;
  for (;;) {
    const seq = parseSeq(src, i);
    opts.push(seq.node);
    i = seq.next;
    if (src[i] === "|") i++;
    else break;
  }
  return { node: opts.length === 1 ? opts[0]! : { t: "alt", opts }, next: i };
}

function makeRng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

function generate(node: Node, rng: () => number, ci: boolean): string {
  switch (node.t) {
    case "lit":
      return ci ? [...node.s].map((ch) => (rng() < 0.3 ? (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) : ch)).join("") : node.s;
    case "set": {
      const pool = node.negated ? SAFE.filter((ch) => !node.chars.includes(ch)) : node.chars;
      return pool.length === 0 ? "" : pool[Math.floor(rng() * pool.length)]!;
    }
    case "seq":
      return node.items.map((n) => generate(n, rng, ci)).join("");
    case "alt":
      return generate(node.opts[Math.floor(rng() * node.opts.length)]!, rng, ci);
    case "rep": {
      const count = node.min + Math.floor(rng() * (node.max - node.min + 1));
      let out = "";
      for (let k = 0; k < count; k++) out += generate(node.n, rng, ci);
      return out;
    }
  }
}

/**
 * Strings the pattern matches (generated, then checked with the pattern itself) in which the hint
 * derived for the alternative is missing. Empty when the derivation is sound for the samples tried.
 */
function violations(pattern: RegExp, samples = 40): { checked: number; missing: string[] } {
  const ci = pattern.flags.includes("i");
  const missing: string[] = [];
  let checked = 0;
  for (const alt of alternatives(pattern.source)) {
    const re = new RegExp(alt, pattern.flags.replace(/[gy]/g, ""));
    const { hints } = deriveHints(re);
    if (hints.length === 0) continue;
    const { node } = parseAlt(alt, 0);
    const rng = makeRng(alt.length * 7919 + 17);
    for (let n = 0; n < samples; n++) {
      const sample = generate(node, rng, ci);
      if (!re.test(sample)) continue;
      checked++;
      const haystack = ci ? sample.toLowerCase() : sample;
      if (!hints.some((h) => haystack.includes(h))) missing.push(`${JSON.stringify(sample)} lacks ${JSON.stringify(hints)} (${alt})`);
    }
  }
  return { checked, missing };
}

describe("derived hints are sound against strings the pattern matches", () => {
  test("every script-content pattern: its hint is in every generated match", () => {
    let checked = 0;
    const missing: string[] = [];
    for (const fp of ALL_FINGERPRINTS) {
      for (const d of fp.detectors) {
        if (d.type !== "script-content") continue;
        const result = violations(d.pattern);
        checked += result.checked;
        missing.push(...result.missing.map((m) => `${fp.id}: ${m}`));
      }
    }
    expect(missing).toEqual([]);
    // The generator really produced matches for most patterns.
    expect(checked).toBeGreaterThan(3_000);
  });

  test("escapes with arguments do not leak the argument into the literal", () => {
    expect(deriveHints(/\x60foobar/).hints).toEqual(["foobar"]);
    expect(deriveHints(new RegExp(String.raw`\u0041bcdef`)).hints).toEqual(["bcdef"]);
    expect(deriveHints(new RegExp(String.raw`\u{41}bcdef`, "u")).hints).toEqual(["bcdef"]);
    expect(deriveHints(/ab\cJcdef/).hints).toEqual(["cdef"]);
    expect(deriveHints(/(?<n>x)\k<n>abcdef/).hints).toEqual(["abcdef"]);
    expect(deriveHints(/(a)\12bcde/).hints).toEqual(["bcde"]);
    expect(deriveHints(/\p{L}abcde/u).hints).toEqual(["abcde"]);
    for (const re of [/\x60foobar/, new RegExp(String.raw`\u0041bcdef`), new RegExp(String.raw`\u{41}bcdef`, "u"), /ab\cJcdef/, /\p{L}abcde/u]) {
      const result = violations(re, 20);
      expect(result.missing).toEqual([]);
      expect([re.source, result.checked > 0]).toEqual([re.source, true]);
    }
  });

  test("the check itself catches a literal the match lacks", () => {
    // A hint the pattern's matches do not contain: the generator has to notice.
    const fake = /\x60foobar/;
    const generated = generate(parseAlt(fake.source, 0).node, makeRng(1), false);
    expect(generated).toBe("`foobar");
    expect(generated.includes("60foobar")).toBe(false);
  });
});
