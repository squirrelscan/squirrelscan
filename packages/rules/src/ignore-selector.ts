// `selectors` of an `[[ignore]]` entry (#1440): a small, linear selector language matched against the
// ancestry path a rule puts on an item (see element-path.ts).
//
// Supported: a compound of a tag (or `*`), `#id` and `.class` tokens, joined by a descendant (space) or child
// (`>`) combinator: `localization-form select`, `form#localization-form > select.picker`. Anything else
// (attribute selectors, pseudo-classes, `+`, `~`, `,`) is refused with a message by `squirrel config validate`,
// never guessed at. Matching is right to left over at most MAX_PARTS compound selectors and the path's
// segments, so its cost is bounded by their product.

/** Characters in one selector. */
export const MAX_SELECTOR_CHARS = 300;
/** Compound selectors in one selector. */
export const MAX_SELECTOR_PARTS = 12;
/** Path segments read (the path itself is bounded by `ANCESTOR_LIMIT`; a longer one is cut to its end). */
const MAX_PATH_SEGMENTS = 32;

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  /** The combinator that joins this compound to the one on its left: " " (descendant) or ">" (child). */
  combinator: " " | ">";
}

/** A compiled selector: its parts (for the work it costs) and the test over a path parsed once with {@link parsePath}. */
export interface SelectorMatcher {
  parts: number;
  test(path: readonly Segment[]): boolean;
}

const NAME = "[A-Za-z0-9_-]+";
const COMPOUND = new RegExp(`^(?:(\\*|${NAME}))?((?:[.#]${NAME})*)$`);

/** A compiled selector, or the reason it is refused. */
export function compileSelector(text: string): SelectorMatcher | string {
  const source = text.trim();
  if (!source) return "an empty selector";
  if (source.length > MAX_SELECTOR_CHARS) return `a selector over ${MAX_SELECTOR_CHARS} characters`;
  if (/[[\]:,+~()'"\\]/.test(source)) return "a selector with an attribute, pseudo-class, sibling combinator or list (only tags, #ids, .classes, spaces and > are supported)";
  const tokens = source.replace(/>/g, " > ").split(/\s+/).filter(Boolean);
  const parts: Compound[] = [];
  let combinator: " " | ">" = " ";
  let expectCompound = true;
  for (const token of tokens) {
    if (token === ">") {
      if (expectCompound) return "a combinator with no selector before it";
      combinator = ">";
      expectCompound = true;
      continue;
    }
    const match = COMPOUND.exec(token);
    if (!match || (match[1] === undefined && match[2] === "")) return `"${token.slice(0, 40)}" is not a tag, #id or .class selector`;
    const rest = match[2] ?? "";
    const classes: string[] = [];
    let id: string | null = null;
    for (const piece of rest.match(new RegExp(`[.#]${NAME}`, "g")) ?? []) {
      if (piece[0] === ".") classes.push(piece.slice(1));
      else if (id !== null) return `"${token.slice(0, 40)}" has two ids`;
      else id = piece.slice(1);
    }
    parts.push({ tag: match[1] && match[1] !== "*" ? match[1].toLowerCase() : null, id, classes, combinator });
    combinator = " ";
    expectCompound = false;
  }
  if (parts.length === 0 || expectCompound) return "a selector that ends in a combinator";
  if (parts.length > MAX_SELECTOR_PARTS) return `a selector of more than ${MAX_SELECTOR_PARTS} parts`;
  return { parts: parts.length, test: (path) => matchPath(parts, path) };
}

export interface Segment {
  tag: string;
  id: string | null;
  classes: Set<string>;
}

/** A path (see element-path.ts) as segments, nearest {@link MAX_PATH_SEGMENTS} ancestors; empty when it does not parse. */
export function parsePath(path: string): Segment[] {
  const out: Segment[] = [];
  for (const raw of path.split(" > ")) {
    const match = /^([A-Za-z0-9_-]+)((?:[.#][A-Za-z0-9_-]+)*)$/.exec(raw);
    if (!match) return [];
    const classes = new Set<string>();
    let id: string | null = null;
    for (const piece of match[2]!.match(/[.#][A-Za-z0-9_-]+/g) ?? []) {
      if (piece[0] === ".") classes.add(piece.slice(1));
      else id = piece.slice(1);
    }
    out.push({ tag: match[1]!.toLowerCase(), id, classes });
  }
  return out.length > MAX_PATH_SEGMENTS ? out.slice(-MAX_PATH_SEGMENTS) : out;
}

function matches(compound: Compound, segment: Segment): boolean {
  if (compound.tag !== null && compound.tag !== segment.tag) return false;
  if (compound.id !== null && compound.id !== segment.id) return false;
  return compound.classes.every((c) => segment.classes.has(c));
}

/** Right to left: the last compound matches the element itself, each earlier one an ancestor (the parent for `>`). */
function matchPath(parts: readonly Compound[], segments: readonly Segment[]): boolean {
  if (segments.length === 0) return false;
  // Memoised on (part, segment), so a descendant chain costs parts x segments, not segments to the power of parts.
  const memo = new Map<number, boolean>();
  const walk = (partIndex: number, segmentIndex: number): boolean => {
    const key = partIndex * 64 + segmentIndex;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result = false;
    if (matches(parts[partIndex]!, segments[segmentIndex]!)) {
      if (partIndex === 0) result = true;
      else if (parts[partIndex]!.combinator === ">") result = segmentIndex > 0 && walk(partIndex - 1, segmentIndex - 1);
      else for (let k = segmentIndex - 1; k >= 0 && !result; k--) result = walk(partIndex - 1, k);
    }
    memo.set(key, result);
    return result;
  };
  return walk(parts.length - 1, segments.length - 1);
}
