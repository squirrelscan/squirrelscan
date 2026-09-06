// content/placeholder-text - Template leftovers that shipped to production.
//
// Six families of "this was never meant to be read": latin filler, theme
// boilerplate, template syntax that never rendered, a stringified object, the
// bare JavaScript values, and source-comment markers. All six are judged against
// PROSE only, because every one of them is a legitimate thing for a page to
// QUOTE — this rule's own documentation shows `{{var}}` and `[object Object]`
// on purpose, and must stay clean. That constraint is a test, not a hope: see
// "this rule's own documentation page stays clean" in the test file.

import type { CheckItem } from "@squirrelscan/core-contracts";

import { getRenderedProseText } from "./text-content";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export type PlaceholderKind =
  | "lorem-ipsum"
  | "boilerplate-copy"
  | "unrendered-template"
  | "stringified-object"
  | "js-artifact"
  | "todo-marker";

export interface PlaceholderFinding {
  kind: PlaceholderKind;
  /** Distinct matched strings, deduped, in first-seen order. */
  samples: string[];
  /** Total occurrences, including repeats of the same sample. */
  count: number;
}

/** Regex metacharacter escape for literals spliced into an alternation. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Collapse HORIZONTAL whitespace runs to one space and newline runs to one
 * newline, so every pattern below can join words with a LITERAL space and carry
 * no quantifier at all. Two payoffs: phrases still match when the markup wrapped
 * a word in a `<span>`, and no pattern in this file contains adjacent unbounded
 * whitespace quantifiers (the `\s*X?\s*` shape that backtracks quadratically).
 *
 * Newlines survive because they are load-bearing: `getRenderedProseText` emits
 * one in place of every skipped subtree, and the TODO heuristic below uses "same
 * line" to tell a marker that introduces a sentence from a bare UI label.
 */
export function normalizeProse(text: string): string {
  return (
    text
      // Horizontal runs first, so the second pass only ever sees single spaces.
      .replace(/[^\S\n]+/g, " ")
      // A newline ABSORBS the spaces on either side of it, so a boundary reads as
      // exactly one "\n". Written as an optional single space plus a simple class
      // star rather than `\s*\n\s*`: the latter lets the leading quantifier eat
      // the newline it is looking for, which is the shape that backtracks
      // quadratically on a long whitespace run with no newline in it.
      .replace(/ ?\n[ \n]*/g, "\n")
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Lorem ipsum                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Only tokens with no life outside the filler text. Deliberately EXCLUDED:
 * `dolor` (Spanish for pain), `sit`, `amet`, `elit`, `velit`, `sint` and `sed` —
 * each is a real word in a real language, and one of them alone is not evidence.
 */
const LOREM_TOKENS = [
  "lorem",
  "ipsum",
  "consectetur",
  "consectetuer",
  "adipiscing",
  "adipisicing",
  "eiusmod",
  "incididunt",
  "ullamco",
  "laboris",
  "cupidatat",
  "proident",
  "occaecat",
  "excepteur",
  "nostrud",
  "exercitation",
  "reprehenderit",
  "aliquip",
  "pariatur",
  "laborum",
] as const;

const LOREM_TOKEN_RE = new RegExp(`\\b(?:${LOREM_TOKENS.join("|")})\\b`, "gi");

/** The opening of the standard passage. Nothing else on earth says this. */
const LOREM_PHRASE_RE = /\bdolor sit amet\b/i;

/**
 * Latin filler needs corroboration, because a page is allowed to talk ABOUT it:
 * three distinct marker tokens, or the standard opening phrase. The bigram alone
 * is NOT enough at any position. Every heading and every bolded lede begins a
 * line once block boundaries are in the text, so "at the head of a block" would
 * flag `<h2>Lorem ipsum explained</h2>` and this rule's own documentation.
 *
 * The cost is a bare `<h1>Lorem ipsum</h1>` with no filler under it, which real
 * placeholder pages almost never are.
 */
function findLorem(text: string): PlaceholderFinding | undefined {
  const matches = [...text.matchAll(LOREM_TOKEN_RE)].map((m) => m[0]);
  if (matches.length === 0) return undefined;

  const distinct = [...new Set(matches.map((m) => m.toLowerCase()))];
  if (distinct.length < 3 && !LOREM_PHRASE_RE.test(text)) return undefined;

  return { kind: "lorem-ipsum", samples: distinct.slice(0, 5), count: matches.length };
}

/* -------------------------------------------------------------------------- */
/* 2. Boilerplate copy                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Phrases shipped by themes and page builders that a human was supposed to
 * replace. Every entry has to be a phrase, never a single word: "sample" and
 * "placeholder" are ordinary English, "sample text" as a sentence is not.
 *
 * `placeholder text` and `example text` are deliberately absent. They are the
 * ordinary way to NAME this subject, so they flag this rule's own documentation
 * and every article about page builders.
 */
const BOILERPLATE_PHRASES = [
  "your company name",
  "your business name",
  "company name here",
  "your name here",
  "your text here",
  "your logo here",
  "your headline here",
  "insert text here",
  "insert your text here",
  "enter text here",
  "add your text here",
  "type your text here",
  "sample text",
  "dummy text",
  "replace this text",
  "edit this text",
  "click here to edit",
  "this is a placeholder",
] as const;

/**
 * Words joined by a LITERAL space, never `\s`. Two consequences, both wanted: the
 * pattern carries no quantifier at all, so matching is strictly linear; and a
 * phrase cannot span the newline that stands in for a skipped subtree, so
 * `your <code>x</code> company name` is not "your company name".
 */
const BOILERPLATE_RE = new RegExp(
  `\\b(?:${BOILERPLATE_PHRASES.map((p) => p.split(" ").map(escapeRe).join(" ")).join("|")})\\b`,
  "gi",
);

/* -------------------------------------------------------------------------- */
/* 3. Unrendered template syntax                                              */
/* -------------------------------------------------------------------------- */

/**
 * Delimiter pairs that reached the reader. Every body is a NEGATED class or a
 * bounded lazy run, so none of them can nest or backtrack super-linearly: the
 * engine gives up after at most 200 characters per start position.
 */
const TEMPLATE_PATTERNS: readonly RegExp[] = [
  /\{\{[^{}]{1,200}\}\}/g, // {{ var }} — Handlebars, Vue, Angular, Jinja, Liquid
  /\{%[^{}]{1,200}%\}/g, // {% for x in y %} — Jinja, Liquid, Twig statement tags
  /<%[\s\S]{1,200}?%>/g, // <%= var %> — EJS, ERB, ASP
  /\$\{[^{}]{1,200}\}/g, // ${var} — JS template literals, shell, Gradle
  /\[\[[^[\]]{1,200}\]\]/g, // [[var]] — Polymer, wiki links, some CMSes
];

/**
 * One leftover, one occurrence. `<%= ${x} %>` matches two patterns over the same
 * span, and reporting `count: 2` for a single stale expression overstates every
 * page that nests one delimiter inside another.
 */
function findTemplateSyntax(text: string): PlaceholderFinding | undefined {
  const spans: { start: number; end: number; text: string }[] = [];
  for (const re of TEMPLATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  if (spans.length === 0) return undefined;

  // Widest first, so a nested match is always tested against its container.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof spans = [];
  for (const span of spans) {
    if (kept.some((k) => k.start <= span.start && span.end <= k.end)) continue;
    kept.push(span);
  }

  return {
    kind: "unrendered-template",
    samples: [...new Set(kept.map((k) => k.text))].slice(0, 5),
    count: kept.length,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. JavaScript artifacts                                                    */
/* -------------------------------------------------------------------------- */

/** `[object Object]` and its siblings. Never anything but a stringify accident. */
const OBJECT_TAG_RE = /\[object [A-Z][A-Za-z]{0,30}\]/g;

/**
 * Case-SENSITIVE and standalone. `NULL` in SQL prose, `Undefined` at the start of
 * a sentence, `foo.null` and `non-null` all stay clean; only the JavaScript
 * spellings match. `$` is NOT a boundary here: `Price: $undefined` is the very
 * artifact this family is for, and the currency sign is what proves it.
 */
const JS_VALUE_RE = /(?<![\w.\-])(?:undefined|null|NaN)(?![\w\-])/g;

/**
 * The collocations that make one of those words ordinary technical English. A
 * match keeps only when NEITHER neighbour is on a list, so "the null hypothesis"
 * and "behaviour is undefined" are out before the slot test below ever runs.
 * These lists are the cheap first pass, not the guarantee.
 */
const PROSE_BEFORE = new Set([
  "a", "an", "the", "is", "was", "be", "been", "being", "are", "were", "if",
  "unless", "when", "whether", "not", "non", "or", "and", "of", "any", "no",
  "all", "some", "every", "returns", "return", "returning", "yields", "yield",
  "produces", "equals", "equal", "becomes", "become", "than", "to", "from", "as",
  "versus", "vs", "checks", "check", "checking", "against", "into", "with",
  "without", "allow", "allows", "allowed", "permit", "permits", "treat",
  "treats", "treated", "means", "meaning", "explicit", "implicit", "literal",
  "nullable", "possibly", "always", "never", "either", "neither", "both",
]);

const PROSE_AFTER = new Set([
  "behavior", "behaviour", "behaviors", "behaviours", "variable", "variables",
  "reference", "references", "function", "functions", "value", "values",
  "property", "properties", "method", "methods", "symbol", "symbols", "index",
  "indices", "state", "states", "term", "terms", "type", "types", "name",
  "names", "error", "errors", "key", "keys", "result", "results", "field",
  "fields", "column", "columns", "row", "rows", "entry", "entries", "case",
  "cases", "check", "checks", "checking", "safety", "coalescing", "pointer",
  "pointers", "hypothesis", "character", "characters", "byte", "bytes", "set",
  "sets", "string", "strings", "island", "and", "or", "terminated",
  "terminator", "default", "instead", "rather", "when", "if", "unless",
  "because", "since", "means", "here", "in", "at", "for", "is", "was", "are",
  "were", "has", "have", "had", "refers", "denotes", "indicates", "represents",
  "behaves", "evaluates", "coerces",
]);

/**
 * Delimiters that mean the page is NAMING the word rather than printing a value.
 * `the [null] hypothesis` is an editorial insertion and `a "null" result` is a
 * quotation; neither is a value that leaked into the copy.
 */
const QUOTE_CHARS = new Set([
  '"', "'", "`", "[", "]", "(", ")", "{", "}", "\u201c", "\u201d", "\u2018", "\u2019", "\u00ab", "\u00bb",
]);

/**
 * Punctuation that INTRODUCES a value, so it only counts on the LEFT: a value
 * sits after the colon in `Rating: NaN`, never before it. Reading these on both
 * sides is what makes `Stated null: Ability = 0` look like a finding when it is
 * a label whose NAME ends in the word.
 *
 * `=` is deliberately absent: without a space it is far more often a query
 * string (`?title=NaN&oldid=1`) than a label. `/` is absent for the same reason
 * in reverse, since `null/undefined has no properties` reads as "or".
 */
const VALUE_INTRODUCER = /[:>\u2192$\u00a3\u20ac\u00a5#]/;



/** Nearest non-space character before `index`, or "" at the start of the text. */
function edgeBefore(text: string, index: number): string {
  // Runs are already collapsed, so at most one space can separate the two.
  const i = text.charAt(index - 1) === " " ? index - 2 : index - 1;
  return i < 0 ? "" : text.charAt(i);
}

/** Nearest non-space character after `end`, or "" at the end of the text. */
function edgeAfter(text: string, end: number): string {
  const i = text.charAt(end) === " " ? end + 1 : end;
  return i >= text.length ? "" : text.charAt(i);
}

/** Start or end of a line. */
const isLineEdge = (ch: string): boolean => ch === "" || ch === "\n";

/**
 * The token OCCUPIES a slot: it is the whole line, the way `<h1>{title}</h1>`
 * renders when the title is missing, or the whole cell of a table.
 *
 * A line edge on ONE side is deliberately not enough. `Posted by undefined` and
 * `Comparison with NaN` are the same shape in flat text, so treating a trailing
 * line edge as evidence reports every heading on every page that discusses these
 * words. This is the rule's precision/recall trade, made in favour of precision
 * because this family FAILS an audit.
 */
const occupiesLine = (before: string, after: string): boolean =>
  isLineEdge(before) && isLineEdge(after);

/**
 * A label introduces it: `Rating: NaN`, `Home > undefined`, `Price: $undefined`.
 * LEFT side only, because a value follows its label and never precedes it.
 *
 * List separators are NOT slots. `,` reads as a clause break far more often than
 * as a list: `Accepts a string, null, or undefined` and `The three falsy values
 * are 0, null, and NaN` are English sentences. `|` is a TypeScript union in
 * every API reference on the web. A genuine list item gets its own line from the
 * block boundaries, so `occupiesLine` already covers it.
 */
const isSlotBefore = (ch: string): boolean => VALUE_INTRODUCER.test(ch);

/** The word immediately before `index`, lowercased, or "" when there is none. */
function wordBefore(text: string, index: number): string {
  const m = /([A-Za-z]+)[ \t]?$/.exec(text.slice(Math.max(0, index - 40), index));
  return m ? m[1]!.toLowerCase() : "";
}

/** The word immediately after `end`, lowercased, or "" when there is none. */
function wordAfter(text: string, end: number): string {
  const m = /^[ \t]?([A-Za-z]+)/.exec(text.slice(end, end + 40));
  return m ? m[1]!.toLowerCase() : "";
}

/** `[object X]` needs no corroboration: nothing but a stringify accident says it. */
function findStringifiedObjects(text: string): PlaceholderFinding | undefined {
  const hits = [...text.matchAll(OBJECT_TAG_RE)].map((m) => m[0]);
  if (hits.length === 0) return undefined;
  return {
    kind: "stringified-object",
    samples: [...new Set(hits)].slice(0, 5),
    count: hits.length,
  };
}

function findJsArtifacts(text: string): PlaceholderFinding | undefined {
  const hits: string[] = [];

  for (const m of text.matchAll(JS_VALUE_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (PROSE_BEFORE.has(wordBefore(text, start))) continue;
    if (PROSE_AFTER.has(wordAfter(text, end))) continue;

    // A word GLUED to a slash is a compound, not a value: `null/undefined has no
    // properties` and `and/or` read the same way, and neither is a leak.
    if (text.charAt(start - 1) === "/" || text.charAt(end) === "/") continue;

    const before = edgeBefore(text, start);
    const after = edgeAfter(text, end);
    if (QUOTE_CHARS.has(before) || QUOTE_CHARS.has(after)) continue;
    // The decisive test, and the one that survives contact with a page whose
    // SUBJECT is the word: a value sits at a slot boundary, prose does not. An
    // article on the null hypothesis has ordinary words on both sides of every
    // occurrence, so no collocation list has to be complete for it to stay clean.
    if (!occupiesLine(before, after) && !isSlotBefore(before)) continue;

    hits.push(m[0]);
  }

  if (hits.length === 0) return undefined;
  return { kind: "js-artifact", samples: [...new Set(hits)].slice(0, 5), count: hits.length };
}

/* -------------------------------------------------------------------------- */
/* 5. Source-comment markers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `TODO`/`FIXME` in ANNOTATION form: followed by `:` or `(`, or introducing a
 * lowercase sentence ON THE SAME LINE. A bare standalone `TODO` is a legitimate
 * label — it is the name of a column on every task board ever shipped — so it is
 * deliberately not matched.
 *
 * `XXX` is absent from this form on purpose. `Super Bowl XXX: the box score` and
 * `Chapter XXX: aftermath` are Roman numerals, and `Rated XXX (explicit)` is a
 * content label; all three fit annotation form exactly. It survives only behind
 * a comment sigil below, where nothing else can be meant.
 *
 * The bounded `[ \t]{0,4}` runs are horizontal-only: a newline stands in for a
 * skipped subtree and for every block boundary, so letting one bridge would let
 * the next paragraph pose as the marker's sentence.
 */
const MARKER_ANNOTATION_RE = /(?<![\w])(?:TODO|FIXME)(?![\w])(?=[ \t]{0,4}[:(]|[ \t]{1,4}[a-z])/g;
const MARKER_COMMENT_RE =
  /(?:(?:\/\/|\/\*)[ \t]{0,4}|#[ \t]{1,4})(TODO|FIXME|XXX)(?![\w])/g;

/**
 * `XXX` doubles as a redaction: `$XXX,XXX` and `555-XXX-XXXX` are censored
 * digits, not a leftover marker. Reject a match glued to the punctuation that
 * builds those runs.
 */
const REDACTION_NEIGHBOUR = /[$#\d]/;
function isRedactedXxx(text: string, start: number, end: number): boolean {
  if (text.slice(start, end).indexOf("XXX") === -1) return false;
  const before = text.slice(Math.max(0, start - 2), start);
  const after = text.slice(end, end + 2);
  return (
    (/[-,./]$/.test(before) && REDACTION_NEIGHBOUR.test(before.charAt(0))) ||
    /^[-,./](?:[Xx\d])/.test(after) ||
    /[$#]$/.test(before)
  );
}

function findMarkers(text: string): PlaceholderFinding | undefined {
  // Keyed by the MARKER's own offset, because `// TODO: x` is in annotation form
  // AND in comment form. Counting both would report one leftover as two, the
  // same double-count trap `content/mojibake` hit with its prefix sequences.
  const byOffset = new Map<number, string>();

  for (const m of text.matchAll(MARKER_ANNOTATION_RE)) {
    const start = m.index;
    if (isRedactedXxx(text, start, start + m[0].length)) continue;
    byOffset.set(start, m[0]);
  }

  for (const m of text.matchAll(MARKER_COMMENT_RE)) {
    const marker = m[1]!;
    const start = m.index + m[0].lastIndexOf(marker);
    if (isRedactedXxx(text, start, start + marker.length)) continue;
    // The sigil form is the more informative sample, so it wins the slot.
    byOffset.set(start, m[0].trim());
  }

  if (byOffset.size === 0) return undefined;
  const hits = [...byOffset.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return { kind: "todo-marker", samples: [...new Set(hits)].slice(0, 5), count: hits.length };
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

/** Collect every distinct match of `patterns` in `text`, or undefined when there are none. */
function findByPatterns(
  kind: PlaceholderKind,
  text: string,
  patterns: readonly RegExp[],
): PlaceholderFinding | undefined {
  const hits: string[] = [];
  for (const re of patterns) for (const m of text.matchAll(re)) hits.push(m[0]);
  if (hits.length === 0) return undefined;
  return { kind, samples: [...new Set(hits)].slice(0, 5), count: hits.length };
}

/**
 * Every placeholder family present in `text`. `text` must already be VISIBLE
 * prose: pass raw HTML and the template family will fire on every framework
 * attribute on the page.
 */
export function findPlaceholders(text: string): PlaceholderFinding[] {
  const prose = normalizeProse(text);
  const found: (PlaceholderFinding | undefined)[] = [
    findLorem(prose),
    findByPatterns("boilerplate-copy", prose, [BOILERPLATE_RE]),
    findTemplateSyntax(prose),
    findStringifiedObjects(prose),
    findJsArtifacts(prose),
    findMarkers(prose),
  ];
  return found.filter((f): f is PlaceholderFinding => f !== undefined);
}

/**
 * Families no site ever ships on purpose, where the finding is its own proof.
 *
 * `js-artifact` is NOT one of them, even though it names the same bug class. A
 * defaults table whose cell reads `null`, and an API reference whose heading is
 * the bare word, are indistinguishable from a value that failed to render, and
 * both are ordinary on developer sites. Reporting those as a hard failure would
 * be wrong more often than it was right, so the three bare words warn and only
 * `[object X]`, which nothing legitimate produces, fails.
 */
const CERTAIN_KINDS = new Set<PlaceholderKind>([
  "lorem-ipsum",
  "unrendered-template",
  "stringified-object",
]);

const KIND_LABELS: Record<PlaceholderKind, string> = {
  "lorem-ipsum": "lorem ipsum filler",
  "boilerplate-copy": "theme boilerplate",
  "unrendered-template": "unrendered template syntax",
  "stringified-object": "stringified object in copy",
  "js-artifact": "JavaScript value in copy",
  "todo-marker": "source-comment marker",
};

const MAX_SAMPLE_CHARS = 60;

const truncate = (s: string): string =>
  s.length <= MAX_SAMPLE_CHARS ? s : `${s.slice(0, MAX_SAMPLE_CHARS - 1)}…`;

export const placeholderTextRule: Rule = {
  meta: {
    id: "content/placeholder-text",
    name: "Placeholder Text",
    description: "Detects template leftovers and filler copy that shipped to production",
    solution:
      "Each family points at a different break in the publishing pipeline. Lorem ipsum and theme boilerplate mean a page was published before its copy was written: replace the text, and add the affected fields to whatever check gates publishing. Unrendered template syntax means the templating engine never ran over that string, usually because the value was interpolated into an already-escaped fragment or the template was served as static HTML: render it server-side, or delete the stale copy. A visible undefined, NaN, null or [object Object] means the value was missing and the code concatenated it into the copy anyway: guard the field at the point of render rather than in CSS. TODO and FIXME markers mean a draft shipped: finish or remove the note, since search engines and readers see it exactly as written.",
    category: "content",
    scope: "page",
    severity: "warning",
    weight: 6,
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) {
      checks.push({
        name: "placeholder-content",
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    const body = doc.querySelector("body");
    if (!body) {
      checks.push({
        name: "placeholder-content",
        status: "skipped",
        message: "No body element to read visible text from",
        skipReason: "no-body",
      });
      return { checks };
    }

    // Rendered prose, never raw HTML. Code-like and <template> subtrees are out
    // by construction: a docs page SHOWING `{{ name }}` is documenting the
    // syntax, and a <template> is markup the browser never renders. Without
    // both exclusions this rule fails its own documentation and every Vue page.
    const found = findPlaceholders(getRenderedProseText(body));

    if (found.length === 0) {
      checks.push({
        name: "placeholder-content",
        status: "pass",
        message: "No placeholder or template leftovers in visible text",
      });
      return { checks };
    }

    const total = found.reduce((sum, f) => sum + f.count, 0);
    const certain = found.some((f) => CERTAIN_KINDS.has(f.kind));
    const items: CheckItem[] = found.map((f) => ({
      id: f.kind,
      label: KIND_LABELS[f.kind],
      snippet: f.samples.map(truncate).join(" | "),
      meta: { count: f.count },
    }));

    checks.push({
      name: "placeholder-content",
      status: certain ? "fail" : "warn",
      // Naming the family and a sample is what makes this findable: "placeholder
      // text detected" sends the reader hunting through the whole page.
      message: `${total} placeholder occurrence(s) in visible text: ${found
        .map((f) => `${KIND_LABELS[f.kind]} (${truncate(f.samples[0]!)})`)
        .join(", ")}`,
      value: total,
      items,
      details: {
        kinds: found.map((f) => ({ kind: f.kind, count: f.count, samples: f.samples })),
      },
    });
    return { checks };
  },
};
