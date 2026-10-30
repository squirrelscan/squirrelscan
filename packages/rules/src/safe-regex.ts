// A linear-time regex engine for `[[ignore]]` matchers (#1262).
//
// Ignore entries run user patterns against untrusted, page-derived strings. A
// backtracking engine cannot be made safe by screening the pattern (`(a|a)*`,
// `\d+\d+`, `(a{1,50}){1,50}`, `(.*)*` all slip past any heuristic), so the
// patterns are never handed to `RegExp`. They are parsed here, rejected when they
// use a feature that needs backtracking (back-references, lookaround), and run on
// a Thompson NFA simulation: O(text x program), no matter the pattern. The parser
// is the validator, so `config validate` and the runtime cannot disagree.
//
// Supported: literals, `.`, classes (`[a-z]`, `[^...]`, `\d\w\s`), anchors `^ $`,
// `\b \B`, groups `(...)` / `(?:...)`, alternation, `* + ? {m} {m,} {m,n}` (lazy
// forms accepted: a boolean test cannot tell them apart), flags `i s m` (`g y d u`
// accepted and ignored). Text is matched by code point.

export const MAX_PATTERN_LENGTH = 200;
/** Instructions after `{m,n}` expansion; a nest like `(a{1,50}){1,50}` is refused here. */
export const MAX_PROGRAM_SIZE = 1500;
/** Ranges in one class after merging and case folding; a test charges for them, so wide classes cannot hide cost. */
export const MAX_SET_RANGES = 64;

type Range = readonly [number, number];

interface CharSet {
  negate: boolean;
  ranges: Range[];
}

type Node =
  | { t: "set"; set: CharSet }
  | { t: "cat"; parts: Node[] }
  | { t: "alt"; options: Node[] }
  | { t: "rep"; node: Node; min: number; max: number }
  | { t: "assert"; kind: "begin" | "end" | "wordb" | "nwordb" }
  | { t: "empty" };

type Inst =
  | { op: "set"; set: CharSet }
  | { op: "split"; a: number; b: number }
  | { op: "jmp"; to: number }
  | { op: "assert"; kind: "begin" | "end" | "wordb" | "nwordb" }
  | { op: "match" };

export interface SafeRegex {
  /** Whether the pattern matches anywhere in `text`; `null` when `budget` steps ran out first. */
  test(text: string, budget: number): { matched: boolean; steps: number } | null;
  readonly programSize: number;
}

class PatternError extends Error {}
/** The table-wide compile budget ran out: a different message from an unsupported feature. */
class BudgetError extends PatternError {}

const DIGIT: Range[] = [[48, 57]];
const WORD: Range[] = [[48, 57], [65, 90], [95, 95], [97, 122]];
const SPACE: Range[] = [[9, 13], [32, 32], [160, 160], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]];

function negated(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  let next = 0;
  for (const [lo, hi] of sorted) {
    if (lo > next) out.push([next, lo - 1]);
    next = Math.max(next, hi + 1);
  }
  if (next <= 0x10ffff) out.push([next, 0x10ffff]);
  return out;
}

interface Flags {
  i: boolean;
  s: boolean;
  m: boolean;
}

function parseFlags(flags: string): Flags {
  const out: Flags = { i: false, s: false, m: false };
  for (const f of flags) {
    if (f === "i" || f === "s" || f === "m") out[f] = true;
    else if (!"gyud".includes(f)) throw new PatternError(`the regex flag "${f}" is not supported`);
  }
  return out;
}

class Parser {
  private pos = 0;
  private readonly chars: string[];
  constructor(
    source: string,
    private readonly flags: Flags,
  ) {
    this.chars = Array.from(source);
  }

  parse(): Node {
    const node = this.alternation(0);
    if (this.pos < this.chars.length) throw new PatternError("unbalanced ) in the regex");
    return node;
  }

  private peek(): string | undefined {
    return this.chars[this.pos];
  }

  private alternation(depth: number): Node {
    if (depth > 20) throw new PatternError("a regex nested more than 20 groups deep");
    const options: Node[] = [this.sequence(depth)];
    while (this.peek() === "|") {
      this.pos++;
      options.push(this.sequence(depth));
    }
    return options.length === 1 ? options[0]! : { t: "alt", options };
  }

  private sequence(depth: number): Node {
    const parts: Node[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === "|" || c === ")") break;
      parts.push(this.quantified(depth));
    }
    if (parts.length === 0) return { t: "empty" };
    return parts.length === 1 ? parts[0]! : { t: "cat", parts };
  }

  private quantified(depth: number): Node {
    const node = this.atom(depth);
    const c = this.peek();
    let bounds: [number, number] | null;
    if (c === "*") bounds = [0, Infinity];
    else if (c === "+") bounds = [1, Infinity];
    else if (c === "?") bounds = [0, 1];
    else if (c === "{") bounds = this.braces();
    else bounds = null;
    if (!bounds) return node; // a literal `{` is read by the next atom
    if (c !== "{") this.pos++;
    if (this.peek() === "?") this.pos++; // lazy: same boolean answer
    if (node.t === "assert") throw new PatternError("a quantifier after an anchor");
    // `a**`, `a+{2}`: a second quantifier on the same atom is an error in JS regexes too.
    const after = this.peek();
    if (after === "*" || after === "+" || after === "?" || (after === "{" && this.braces(true))) throw new PatternError("a quantifier on a quantifier");
    return { t: "rep", node, min: bounds[0], max: bounds[1] };
  }

  private braces(peekOnly = false): [number, number] | null {
    const rest = this.chars.slice(this.pos).join("");
    const m = /^\{(\d{1,4})(?:(,)(\d{0,4}))?\}/.exec(rest);
    if (!m) return null;
    const min = Number(m[1]);
    const max = m[2] ? (m[3] === "" ? Infinity : Number(m[3])) : min;
    if (max < min) throw new PatternError("a quantifier whose maximum is below its minimum");
    if (!peekOnly) this.pos += m[0].length;
    return [min, max];
  }

  private atom(depth: number): Node {
    const c = this.chars[this.pos++]!;
    switch (c) {
      case "(": {
        if (this.peek() === "?") {
          const kind = this.chars.slice(this.pos, this.pos + 3).join("");
          if (kind.startsWith("?:")) this.pos += 2;
          else if (kind.startsWith("?=") || kind.startsWith("?!") || kind.startsWith("?<=") || kind.startsWith("?<!"))
            throw new PatternError("lookahead and lookbehind");
          else if (kind.startsWith("?<")) throw new PatternError("named groups (use a plain group)");
          else throw new PatternError("this group syntax");
        }
        const inner = this.alternation(depth + 1);
        if (this.peek() !== ")") throw new PatternError("an unclosed ( in the regex");
        this.pos++;
        return inner;
      }
      case ")":
        throw new PatternError("unbalanced ) in the regex");
      case "[":
        return { t: "set", set: this.charClass() };
      case ".":
        return { t: "set", set: { negate: !this.flags.s, ranges: this.flags.s ? [[0, 0x10ffff]] : [[10, 10], [13, 13], [0x2028, 0x2029]] } };
      case "^":
        return { t: "assert", kind: "begin" };
      case "$":
        return { t: "assert", kind: "end" };
      case "*":
      case "+":
      case "?":
        throw new PatternError("a quantifier with nothing before it");
      case "\\":
        return this.escape(false);
      default:
        return { t: "set", set: { negate: false, ranges: [[c.codePointAt(0)!, c.codePointAt(0)!]] } };
    }
  }

  /** An escape outside (`inClass` false) or inside a class. */
  private escape(inClass: boolean): Node {
    const c = this.chars[this.pos++];
    if (c === undefined) throw new PatternError("a trailing backslash");
    const set = (ranges: Range[], negate = false): Node => ({ t: "set", set: { negate, ranges } });
    switch (c) {
      case "d": return set(DIGIT);
      case "D": return set(DIGIT, true);
      case "w": return set(WORD);
      case "W": return set(WORD, true);
      case "s": return set(SPACE);
      case "S": return set(SPACE, true);
      case "n": return this.lit(10);
      case "r": return this.lit(13);
      case "t": return this.lit(9);
      case "f": return this.lit(12);
      case "v": return this.lit(11);
      case "0": return this.lit(0);
      case "b":
        return inClass ? this.lit(8) : { t: "assert", kind: "wordb" };
      case "B":
        if (inClass) throw new PatternError("\\B inside a class");
        return { t: "assert", kind: "nwordb" };
      case "x": return this.hex(2);
      case "u": {
        if (this.peek() === "{") {
          const end = this.chars.indexOf("}", this.pos);
          const digits = end < 0 ? "" : this.chars.slice(this.pos + 1, end).join("");
          if (!/^[0-9a-fA-F]{1,6}$/.test(digits) || parseInt(digits, 16) > 0x10ffff) throw new PatternError("a malformed \\u{} escape");
          this.pos = end + 1;
          return this.lit(parseInt(digits, 16));
        }
        return this.hex(4);
      }
      case "k":
      case "p":
      case "P":
        throw new PatternError(c === "k" ? "named back-references" : "unicode property escapes");
      default:
        if (c >= "1" && c <= "9") throw new PatternError("back-references");
        if (/[A-Za-z]/.test(c)) throw new PatternError(`the escape \\${c}`);
        return this.lit(c.codePointAt(0)!);
    }
  }

  private lit(code: number): Node {
    return { t: "set", set: { negate: false, ranges: [[code, code]] } };
  }

  private hex(n: number): Node {
    const digits = this.chars.slice(this.pos, this.pos + n).join("");
    if (digits.length !== n || !/^[0-9a-fA-F]+$/.test(digits)) throw new PatternError("a malformed hex escape");
    this.pos += n;
    return this.lit(parseInt(digits, 16));
  }

  private charClass(): CharSet {
    let negate = false;
    if (this.peek() === "^") {
      negate = true;
      this.pos++;
    }
    const ranges: Range[] = [];
    let first = true;
    for (;;) {
      const c = this.chars[this.pos++];
      if (c === undefined) throw new PatternError("an unclosed [ in the regex");
      if (c === "]" && !first) break;
      first = false;
      const lo = this.classAtom(c, ranges);
      if (lo === null) continue; // a \d-style shorthand, already added
      if (this.peek() === "-" && this.chars[this.pos + 1] !== "]" && this.chars[this.pos + 1] !== undefined) {
        const save = this.pos;
        this.pos++;
        const hiChar = this.chars[this.pos++]!;
        const hi = this.classAtom(hiChar, ranges);
        if (hi === null) {
          this.pos = save; // `a-\d`: the dash is literal
          ranges.push([lo, lo]);
          continue;
        }
        if (hi < lo) throw new PatternError("a class range out of order");
        ranges.push([lo, hi]);
      } else ranges.push([lo, lo]);
    }
    return { negate, ranges };
  }

  /** One class member: its code point, or null after adding a shorthand's ranges. */
  private classAtom(c: string, into: Range[]): number | null {
    if (c !== "\\") return c.codePointAt(0)!;
    const node = this.escape(true);
    if (node.t !== "set") throw new PatternError("an anchor inside a class");
    const { negate, ranges } = node.set;
    const single = ranges.length === 1 && ranges[0]![0] === ranges[0]![1] && !negate;
    if (single) return ranges[0]![0];
    into.push(...(negate ? negated(ranges) : ranges));
    return null;
  }
}

function setMatches(set: CharSet, code: number): boolean {
  let hit = false;
  for (const [lo, hi] of set.ranges) {
    if (code >= lo && code <= hi) {
      hit = true;
      break;
    }
  }
  return hit !== set.negate;
}

/** Compile work shared by the patterns of one table (#1262): units are code points folded plus instructions emitted. */
export interface CompileWork {
  left: number;
}

/** Fold + merge results shared across patterns: the same class folds once per process. Bounded. */
const FOLD_MEMO = new Map<string, CharSet>();
const FOLD_MEMO_MAX = 512;

function charge(work: CompileWork | undefined, units: number): void {
  if (!work) return;
  work.left -= units;
  if (work.left < 0) throw new BudgetError("compile budget exhausted");
}

/** The class as the program holds it: case folded (when asked) and merged, computed once per distinct class. */
function programSet(set: CharSet, ignoreCase: boolean, work?: CompileWork): CharSet {
  const key = `${ignoreCase ? "i" : ""}${set.negate ? "^" : ""}${set.ranges.map(([lo, hi]) => `${lo}-${hi}`).join(",")}`;
  // Charged on a memo hit too: the memo is only a speed cache, so whether a pattern is refused
  // must not depend on what this process compiled before.
  if (ignoreCase) {
    for (const [lo, hi] of set.ranges) if (hi - lo <= 512) charge(work, hi - lo + 1);
  }
  const memo = FOLD_MEMO.get(key);
  if (memo) return memo;
  const extra: Range[] = [];
  if (ignoreCase) {
    // Add the other case of every code point of every range up to 512 wide.
    for (const [lo, hi] of set.ranges) {
      if (hi - lo > 512) continue;
      for (let code = lo; code <= hi; code++) {
        const ch = String.fromCodePoint(code);
        const lower = ch.toLowerCase();
        const upper = ch.toUpperCase();
        if (lower !== ch && Array.from(lower).length === 1) extra.push([lower.codePointAt(0)!, lower.codePointAt(0)!]);
        if (upper !== ch && Array.from(upper).length === 1) extra.push([upper.codePointAt(0)!, upper.codePointAt(0)!]);
      }
    }
  }
  const out: CharSet = { negate: set.negate, ranges: mergeRanges([...set.ranges, ...extra]) };
  if (FOLD_MEMO.size >= FOLD_MEMO_MAX) FOLD_MEMO.clear();
  FOLD_MEMO.set(key, out);
  return out;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function isWordCode(code: number | undefined): boolean {
  return code !== undefined && ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || code === 95 || (code >= 97 && code <= 122));
}

/** Instructions `node` expands to, saturating just above the cap so a hostile nest stays cheap to measure. */
function sizeOf(node: Node, memo: Map<Node, number>): number {
  const cached = memo.get(node);
  if (cached !== undefined) return cached;
  const cap = MAX_PROGRAM_SIZE + 1;
  let size: number;
  switch (node.t) {
    case "empty":
      size = 0;
      break;
    case "set":
    case "assert":
      size = 1;
      break;
    case "cat":
      size = Math.min(cap, node.parts.reduce((sum, part) => sum + sizeOf(part, memo), 0));
      break;
    case "alt":
      size = Math.min(cap, node.options.reduce((sum, option) => sum + sizeOf(option, memo), 0) + 2 * (node.options.length - 1));
      break;
    case "rep": {
      const inner = sizeOf(node.node, memo);
      if (inner === 0) size = 0; // nothing to repeat: the whole repeat emits nothing
      else if (node.max === Infinity) size = Math.min(cap, node.min * inner + inner + 2);
      else size = Math.min(cap, node.min * inner + (node.max - node.min) * (inner + 1));
      break;
    }
  }
  memo.set(node, size);
  return size;
}

function compile(node: Node, flags: Flags, work?: CompileWork): Inst[] {
  const memo = new Map<Node, number>();
  // Measured BEFORE anything is emitted: a nest that expands past the cap (or one
  // that emits nothing and loops 10,000 times per level) never reaches the loops.
  if (sizeOf(node, memo) > MAX_PROGRAM_SIZE) throw new PatternError(`a regex that expands past ${MAX_PROGRAM_SIZE} steps (nested repeats)`);
  const prog: Inst[] = [];
  // Each class is case-folded and merged once, not once per copy a repeat makes of it.
  const sets = new Map<Node, CharSet>();
  const emit = (inst: Inst): number => {
    if (prog.length >= MAX_PROGRAM_SIZE) throw new PatternError(`a regex that expands past ${MAX_PROGRAM_SIZE} steps (nested repeats)`);
    charge(work, 1);
    prog.push(inst);
    return prog.length - 1;
  };
  const gen = (n: Node): void => {
    if (sizeOf(n, memo) === 0) return;
    switch (n.t) {
      case "empty":
        return;
      case "set": {
        let set = sets.get(n);
        if (!set) {
          set = programSet(n.set, flags.i, work);
          if (set.ranges.length > MAX_SET_RANGES) throw new PatternError(`a class with more than ${MAX_SET_RANGES} separate ranges`);
          sets.set(n, set);
        }
        emit({ op: "set", set });
        return;
      }
      case "assert":
        emit({ op: "assert", kind: n.kind });
        return;
      case "cat":
        for (const part of n.parts) gen(part);
        return;
      case "alt": {
        const jumps: number[] = [];
        for (const [i, option] of n.options.entries()) {
          if (i < n.options.length - 1) {
            const split = emit({ op: "split", a: 0, b: 0 });
            (prog[split] as { a: number }).a = prog.length;
            gen(option);
            jumps.push(emit({ op: "jmp", to: 0 }));
            (prog[split] as { b: number }).b = prog.length;
          } else gen(option);
        }
        for (const j of jumps) (prog[j] as { to: number }).to = prog.length;
        return;
      }
      case "rep": {
        for (let i = 0; i < n.min; i++) gen(n.node);
        if (n.max === Infinity) {
          const split = emit({ op: "split", a: 0, b: 0 });
          (prog[split] as { a: number }).a = prog.length;
          gen(n.node);
          emit({ op: "jmp", to: split });
          (prog[split] as { b: number }).b = prog.length;
        } else {
          const splits: number[] = [];
          for (let i = n.min; i < n.max; i++) {
            const split = emit({ op: "split", a: 0, b: 0 });
            (prog[split] as { a: number }).a = prog.length;
            splits.push(split);
            gen(n.node);
          }
          for (const s of splits) (prog[s] as { b: number }).b = prog.length;
        }
      }
    }
  };
  gen(node);
  emit({ op: "match" });
  return prog;
}

/** Compile `source` (with `flags`), or return why it is refused. The one validator for every ignore regex. */
const EMPTY_PROBES = ["", "a", " ", "-", "0"];

export function compileSafeRegex(source: string, flags = "", work?: CompileWork): SafeRegex | string {
  if (source.length > MAX_PATTERN_LENGTH) return `a regex over ${MAX_PATTERN_LENGTH} characters`;
  let prog: Inst[];
  let f: Flags;
  try {
    f = parseFlags(flags);
    prog = compile(new Parser(source, f).parse(), f, work);
  } catch (error) {
    if (error instanceof BudgetError) return "a regex left out because the config's regexes together used up the compile work limit (compile budget exhausted)";
    if (error instanceof PatternError) return `a regex the linear-time matcher cannot run (${error.message}; back-references and lookaround are not supported)`;
    throw error;
  }
  const regex: SafeRegex = { test: (text, budget) => run(prog, f, text, budget), programSize: prog.length };
  // A pattern that matches the empty string wherever it is looked for (`a*`, `(|)`, `a{0}`,
  // `$`, an empty body) matches EVERY text, so an entry using it would waive everything.
  // Anchored ones (`^$`: only the empty text) do not, and are fine.
  if (EMPTY_PROBES.every((probe) => regex.test(probe, 100_000)?.matched === true)) {
    return "a regex that matches the empty string, which means it matches every text (it would waive everything)";
  }
  return regex;
}

function run(prog: Inst[], flags: Flags, text: string, budget: number): { matched: boolean; steps: number } | null {
  const codes = Array.from(text, (ch) => ch.codePointAt(0)!);
  const n = codes.length;
  let steps = 0;
  let current = new Set<number>();
  let next = new Set<number>();
  let stack: number[] = [];
  let over = false;

  const add = (set: Set<number>, start: number, at: number): boolean => {
    stack.push(start);
    while (stack.length > 0) {
      const pc = stack.pop()!;
      if (set.has(pc)) continue;
      set.add(pc);
      if (++steps > budget) {
        over = true;
        stack = [];
        return false;
      }
      const inst = prog[pc]!;
      if (inst.op === "jmp") stack.push(inst.to);
      else if (inst.op === "split") stack.push(inst.b, inst.a);
      else if (inst.op === "assert") {
        const before = at > 0 ? codes[at - 1] : undefined;
        const here = at < n ? codes[at] : undefined;
        const isLineBreak = (code: number | undefined) => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
        let ok: boolean;
        if (inst.kind === "begin") ok = at === 0 || (flags.m && isLineBreak(before));
        else if (inst.kind === "end") ok = at === n || (flags.m && isLineBreak(here));
        else ok = (isWordCode(before) !== isWordCode(here)) === (inst.kind === "wordb");
        if (ok) stack.push(pc + 1);
      } else if (inst.op === "match") return true;
    }
    return false;
  };

  for (let at = 0; at <= n; at++) {
    // An unanchored search: a fresh thread may start at every position.
    if (add(current, 0, at)) return { matched: true, steps };
    if (over) return null;
    next.clear();
    const code = at < n ? codes[at] : undefined;
    if (code !== undefined) {
      for (const pc of current) {
        const inst = prog[pc]!;
        if (inst.op !== "set") continue;
        steps += 1 + (inst.set.ranges.length >> 3);
        if (steps > budget) return null;
        if (setMatches(inst.set, code) && add(next, pc + 1, at + 1)) return { matched: true, steps };
        if (over) return null;
      }
    }
    [current, next] = [next, current];
  }
  return { matched: false, steps };
}
