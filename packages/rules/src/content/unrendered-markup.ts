// content/unrendered-markup - Markup that failed to render and leaked into visible copy

import { getAttrCI } from "@squirrelscan/utils";

import { collectTextExcluding } from "@squirrelscan/parser/extractors";

import type { Element } from "linkedom";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

/** Never read by a visitor at all. */
const SCRIPT_LIKE_TAGS = ["script", "style", "noscript", "template"] as const;

/**
 * Markup that says "what follows is a literal, not prose". A documentation page
 * showing `**bold**` inside one of these is doing its job, not mis-rendering, so
 * every one of them is excluded before a single pattern runs. `<textarea>` joins
 * the usual four because an editor pre-filled with a post's markdown source is
 * the single most common way real markdown appears on a page on purpose.
 */
const CODE_LIKE_TAGS = ["code", "pre", "samp", "kbd", "textarea"] as const;

/**
 * Class tokens every mainstream syntax highlighter stamps on its container.
 * Matched as WHOLE tokens, never as substrings: a marketing page's
 * `class="highlight-box"` callout is prose and must still be judged, while
 * Rouge's `class="highlight"` wrapper is a code block and must not be.
 *
 * Some highlighters (Rouge, Chroma, Pygments) put the marker on a `<div>` that
 * WRAPS the `<pre>`, so the tag list alone would still read the language label
 * and line numbers they inject as prose.
 */
const HIGHLIGHT_CLASS_TOKENS = new Set([
  "highlight",
  "highlighter-rouge",
  "codehilite",
  "chroma",
  "hljs",
  "shiki",
  "astro-code",
  "expressive-code",
  "torchlight",
  "prismjs",
  "code-block",
  "codeblock",
  "sourcecode",
  "line-numbers",
  // A site that styles source-on-display without reaching for <pre>. Generic
  // enough to be a promise about the content, not one site's class name:
  // commonmark.org's syntax table marks every cell of markdown source this way.
  "preformatted",
  "pre",
]);

/** `class="language-ts"` / `class="lang-ts"`: the same marker, spelled per-language. */
const HIGHLIGHT_CLASS_PREFIXES = ["language-", "lang-"] as const;

/** Attributes a highlighter or MDX renderer writes on the block it owns. */
const HIGHLIGHT_ATTRIBUTES = ["data-language", "data-lang", "data-highlighted", "data-code"];

const SCRIPT_OR_CODE_TAGS = new Set<string>([...SCRIPT_LIKE_TAGS, ...CODE_LIKE_TAGS]);

/** True for any element whose subtree is source-on-display rather than prose. */
export function isCodeLikeElement(el: Element): boolean {
  const tag = el.tagName?.toLowerCase();
  if (tag && SCRIPT_OR_CODE_TAGS.has(tag)) return true;

  // getAttribute is case-SENSITIVE on this parser, so read both class spellings
  // the same way every other rule does.
  const className = getAttrCI(el, "class");
  if (className) {
    for (const token of className.split(/\s+/)) {
      if (!token) continue;
      const lower = token.toLowerCase();
      if (HIGHLIGHT_CLASS_TOKENS.has(lower)) return true;
      for (const prefix of HIGHLIGHT_CLASS_PREFIXES) {
        if (lower.startsWith(prefix) && lower.length > prefix.length) return true;
      }
    }
  }

  for (const attr of HIGHLIGHT_ATTRIBUTES) {
    if (getAttrCI(el, attr) !== null) return true;
  }
  return false;
}

/**
 * A newline, never a space, stands in for each skipped subtree.
 *
 * Skipping glues neighbours together: `**<code>x</code>**` would read back as
 * `****` and be counted as emphasis that exists in neither fragment. A newline
 * also stops a line-anchored pattern (`## `, ```` ``` ````) from starting mid-line
 * where an excluded block actually ended.
 */
const SKIPPED_SUBTREE_BOUNDARY = "\n";

/**
 * Work cap. Prose beyond this is not scanned: the rule is a yes/no signal about
 * whether a template mis-rendered, and no real page needs half a megabyte of
 * prose to demonstrate that. Bounds the cost on a hostile or generated page.
 */
const MAX_SCANNED_CHARS = 500_000;

/** Per family, so one pathological page cannot allocate an unbounded match list. */
const MAX_MATCHES_PER_KIND = 500;

/**
 * Markdown emphasis, ASTERISK form. The delimiters must be FLANKED the way
 * CommonMark requires — opener preceded by start/whitespace/opening punctuation
 * and followed by non-whitespace, closer preceded by non-whitespace and followed
 * by end/whitespace/closing punctuation.
 *
 * Flanking is the whole point: a naive "two paired asterisks" rule reads
 * `2 * 3 * 4` as emphasis and `width * height` as bold. Both fail here because
 * the character after the opening `*` is a space.
 */
const MD_EMPHASIS_ASTERISK_RE =
  /(?:^|[\s([{'"])(\*{1,2})(?=[^\s*])([^*\n]{1,200})\1(?=$|[\s.,;:!?)\]}'"])/gm;

/**
 * Markdown emphasis, UNDERSCORE form — deliberately stricter than the asterisk
 * form: the emphasized run must contain whitespace, which `INNER_HAS_SPACE`
 * checks on the capture rather than in the pattern.
 *
 * Flanking alone already rejects `CLOUDFLARE_API_TOKEN` and `some_file_name.ts`,
 * whose underscores are intraword. It does NOT reject `__init__`, `__main__` or
 * `__all__`, which are flanked exactly like bold and appear in ordinary Python
 * prose outside a code span. Requiring a space inside costs single-word
 * `__bold__` and buys silence on every dunder; a page that really lost its
 * markdown almost always leaks phrases and asterisks too.
 *
 * The whitespace test is JS, not regex, on purpose: spelling it as
 * `[^_\n]{0,198}[ \t][^_\n]{0,198}` puts two quantifiers over the same
 * characters, and every run that fails to close then re-partitions itself.
 */
const MD_EMPHASIS_UNDERSCORE_RE =
  /(?:^|[\s([{'"])(_{1,2})(?=[^\s_])([^_\n]{1,200})\1(?=$|[\s.,;:!?)\]}'"])/gm;

const INNER_HAS_SPACE = (m: RegExpExecArray): boolean => /[ \t]/.test(m[2] ?? "");

/**
 * Markdown link or image: `[text](url)`, `![alt](url)`.
 *
 * The target must LOOK like a URL. That single condition is what separates a
 * leaked link from ordinary bracketed prose — `f[x](y)`, `[see note] (below)`
 * and `array[i](arg)` all fail it, while `[docs](https://…)`, `[home](/)` and
 * `[top](#top)` do not.
 */
const MD_LINK_RE =
  /!?\[[^\]\n]{0,200}\]\((?:https?:\/\/|mailto:|\/|#|www\.|[\w.-]{1,60}\.[a-z]{2,10}[/?#])[^)\s]{0,300}\)/g;

/**
 * A leading `#` run at the start of a line. `[ \t]` never `\s`, so the class
 * cannot swallow the newline the `m` anchor depends on.
 *
 * The trailing letter requirement keeps `#1 in the market` and `# 404` out; a
 * line that opens with hashes, a space and a word is a heading nobody rendered.
 *
 * There is deliberately no `$`: anchoring the tail to end-of-line would make a
 * heading longer than the bound fail and then re-try every shorter length,
 * which is both slow and a silent miss on exactly the long headings a broken
 * template produces.
 */
const MD_HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+(?=[^\s#\d])[^\n]{1,100}/gm;

/** A fence line: three or more backticks or tildes, optionally with an info string. */
const MD_FENCE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]{0,60}/gm;

/**
 * Inline code span. Backticks are near-absent from ordinary prose, so flanking
 * plus a non-space interior is enough; the run is bounded to keep it linear.
 */
const MD_INLINE_CODE_RE = /(?:^|[\s([{'"])`(?=[^\s`])([^`\n]{1,200})`(?=$|[\s.,;:!?)\]}'"])/gm;

/**
 * HTML tags a reader can SEE. The page source said `&lt;p&gt;`; `.textContent`
 * decodes that, so by the time the text reaches here it is a literal `<p>`.
 * Scanning the raw HTML for `&lt;` instead would be the same rule written
 * backwards, and would fire on every escaped example inside a code block.
 *
 * One bounded character class, not two adjacent quantifiers: `[^<>]{0,200}`
 * cannot match the closing `>`, so it stops at the first one and never
 * re-partitions a long run the way `\s*[^>]*` would.
 *
 * LOWERCASE tag names only. Escaped markup that leaked out of a template came
 * from HTML a server actually emitted, which is lowercase. A capitalised
 * `<Article>` or `<Video>` is a JSX, Astro or Vue COMPONENT name that a page is
 * displaying on purpose — astro.build puts a whole row of them in its hero.
 */
const ESCAPED_TAG_RE = /<(\/?)([a-z][a-z0-9]{0,9})([^<>]{0,200})>/g;

/**
 * Tags whose bare form is unambiguous evidence. `b`, `i`, `u`, `s` and `q` are
 * absent on purpose: `x<b>y` occurs in mathematical prose, and one comparison
 * chain must not accuse a page of leaking markup.
 */
const VISIBLE_HTML_TAGS = new Set([
  "p", "div", "span", "br", "hr", "ul", "ol", "li", "dl", "dt", "dd",
  "strong", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
  "section", "article", "header", "footer", "aside", "nav", "main",
  "form", "input", "button", "select", "option", "label", "textarea",
  "img", "picture", "source", "video", "audio", "iframe", "embed", "object",
  "blockquote", "figure", "figcaption", "pre", "code", "script", "style",
  "link", "meta", "svg", "path", "html", "head", "body", "title",
  "details", "summary", "canvas", "template", "abbr",
]);

/** These need an attribute or a closing slash before they count. */
const AMBIGUOUS_HTML_TAGS = new Set(["a", "b", "i", "u", "s", "q"]);

/**
 * Named entities that survived one decode too few. A curated list, not
 * `&[a-z]+;`: the generic shape reads `Johnson&Johnson;` as an entity, and a
 * rule that accuses a page of broken encoding cannot afford that. Numeric
 * references are unambiguous and handled separately.
 */
const KNOWN_ENTITY_NAMES = [
  "nbsp", "amp", "lt", "gt", "quot", "apos", "hellip", "mdash", "ndash",
  "copy", "reg", "trade", "laquo", "raquo", "ldquo", "rdquo", "lsquo", "rsquo",
  "bull", "middot", "deg", "plusmn", "times", "divide", "frac12", "frac14",
  "euro", "pound", "yen", "cent", "sect", "para", "dagger", "permil", "prime",
  "ne", "le", "ge", "larr", "rarr", "harr", "infin", "sup2", "sup3",
  "eacute", "egrave", "agrave", "uuml", "ouml", "auml", "ccedil", "ntilde", "szlig",
  "shy", "ensp", "emsp", "thinsp", "zwnj", "zwj",
] as const;

const DOUBLE_ENCODED_ENTITY_RE = new RegExp(
  `&(?:${KNOWN_ENTITY_NAMES.join("|")}|#\\d{1,7}|#[xX][0-9a-fA-F]{1,6});`,
  "g",
);

export type UnrenderedMarkupKind =
  | "markdown-emphasis"
  | "markdown-link"
  | "markdown-heading"
  | "markdown-code-fence"
  | "markdown-inline-code"
  | "escaped-html-tag"
  | "double-encoded-entity";

export interface UnrenderedMarkupFinding {
  kind: UnrenderedMarkupKind;
  /** A short, single-line excerpt of the first occurrence. */
  sample: string;
  count: number;
}

/** Kinds that mean a reader is looking at raw markup, not at a formatting glyph. */
const RAW_MARKUP_KINDS = new Set<UnrenderedMarkupKind>([
  "escaped-html-tag",
  "double-encoded-entity",
]);

/**
 * Corroborating only: present in the detail when something else fires, never
 * able to accuse a page by itself.
 *
 * A visible backtick is the one markdown character people put on a page
 * deliberately and often — a prompt written to be copied into an agent, a chat
 * transcript, a changelog entry. Vercel's docs landing page carries six of them
 * in a copyable prompt and is not mis-rendering anything. A template that
 * really lost its markdown pass leaks headings, links or emphasis as well.
 */
const CORROBORATING_KINDS = new Set<UnrenderedMarkupKind>(["markdown-inline-code"]);

/** Reports get these verbatim, so no newline and no unbounded site-controlled string. */
function toSample(match: string): string {
  const flat = match.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/**
 * Matches of `re` in `text` that satisfy `accept`, capped, with `re`'s
 * lastIndex left clean for the next page (these regexes are module-level and
 * `g`-flagged, so a stale lastIndex would silently skip the head of the text).
 */
function collect(
  re: RegExp,
  text: string,
  accept?: (m: RegExpExecArray) => boolean,
): string[] {
  re.lastIndex = 0;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (!accept || accept(match)) {
      out.push(match[0]);
      if (out.length >= MAX_MATCHES_PER_KIND) break;
    }
    // A zero-length match would spin forever; none of these patterns can produce
    // one, but the guard costs nothing and the alternative is a hung audit.
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  re.lastIndex = 0;
  return out;
}

function push(
  out: UnrenderedMarkupFinding[],
  kind: UnrenderedMarkupKind,
  matches: string[],
): void {
  if (matches.length === 0) return;
  out.push({ kind, sample: toSample(matches[0] as string), count: matches.length });
}

/**
 * Visible HTML tags in `text`, reported only when at least one of them could
 * not have been written on purpose.
 *
 * A bare tag NAME is how a page talks about an element: MDN's reference for the
 * `pre` element says `<pre>` in its breadcrumb and `<meta name>` and
 * `<meta http-equiv>` in its see-also list, none of them inside a code span.
 * Markup that actually leaked out of a template looks different — it brings the
 * closing tag with it (`<p>…</p>`) or an attribute with a VALUE
 * (`<div class="row">`, `<a href="/x">`), because that is what a server emits
 * and what nobody types into a sentence.
 *
 * One such tag vouches for the rest, so a leak of `<p>text</p><br><br>` is
 * counted in full while a page of bare element names is silent.
 */
function findEscapedTags(text: string): string[] {
  const candidates: { text: string; closing: boolean; valued: boolean }[] = [];
  ESCAPED_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ESCAPED_TAG_RE.exec(text)) !== null) {
    const closing = match[1] === "/";
    const name = match[2] ?? "";
    const rest = match[3] ?? "";
    // An attribute list has to start at a boundary, so `<pathological>` cannot
    // read as `<path>` followed by noise.
    const attrs = rest.length > 0 && /^[\s/]/.test(rest);
    if (rest.length > 0 && !attrs) continue;
    const ambiguous = AMBIGUOUS_HTML_TAGS.has(name);
    if (!VISIBLE_HTML_TAGS.has(name) && !ambiguous) continue;
    // `x<b>y` is a comparison chain in mathematical prose. An ambiguous opening
    // tag needs an attribute before it outweighs that reading.
    if (ambiguous && !closing && !attrs) continue;
    candidates.push({ text: match[0], closing, valued: attrs && rest.includes("=") });
    if (candidates.length >= MAX_MATCHES_PER_KIND) break;
  }
  ESCAPED_TAG_RE.lastIndex = 0;

  if (!candidates.some((c) => c.closing || c.valued)) return [];
  return candidates.map((c) => c.text);
}

/** Every family of unrendered markup present in `text`, with a sample and a count. */
export function findUnrenderedMarkup(text: string): UnrenderedMarkupFinding[] {
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  const out: UnrenderedMarkupFinding[] = [];

  const emphasis = [
    ...collect(MD_EMPHASIS_ASTERISK_RE, scanned),
    ...collect(MD_EMPHASIS_UNDERSCORE_RE, scanned, INNER_HAS_SPACE),
  ];
  push(out, "markdown-emphasis", emphasis);
  push(out, "markdown-link", collect(MD_LINK_RE, scanned));
  push(out, "markdown-heading", collect(MD_HEADING_RE, scanned));
  push(out, "markdown-code-fence", collect(MD_FENCE_RE, scanned));
  push(out, "markdown-inline-code", collect(MD_INLINE_CODE_RE, scanned));

  push(out, "escaped-html-tag", findEscapedTags(scanned));

  push(out, "double-encoded-entity", collect(DOUBLE_ENCODED_ENTITY_RE, scanned));

  return out;
}

export const unrenderedMarkupRule: Rule = {
  meta: {
    id: "content/unrendered-markup",
    name: "Unrendered Markup",
    description: "Detects literal markdown or escaped HTML leaking into rendered copy",
    solution:
      'Something rendered a value as plain text that was authored as markup. Find the field, not the page: a CMS that stores markdown and a template that prints it without a markdown-to-HTML pass produces literal `**bold**` and `[text](url)` everywhere that field appears, and fixing one page leaves the rest broken. Visible `<p>` or `<a href` means the opposite mistake — HTML was escaped twice, usually by escaping a value that a templating engine (Jinja, Twig, Blade, JSX) had already escaped, so remove the manual escape rather than marking the value safe. Visible `&nbsp;` or `&amp;` means the entity itself was encoded a second time on the way in, which is normally an import or a rich-text editor round-trip, so re-import the affected content. If the markup is meant to be on display, put it in `<code>` or `<pre>`, which this rule skips.',
    category: "content",
    scope: "page",
    severity: "warning",
    weight: 5,
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) {
      checks.push({
        name: "unrendered-markup",
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    const body = doc.querySelector("body");
    if (!body) {
      checks.push({
        name: "unrendered-markup",
        status: "skipped",
        message: "No body element to read visible text from",
        skipReason: "no-body",
      });
      return { checks };
    }

    // Prose only, and never the raw HTML: the rule asks what a VISITOR sees, so
    // it has to read the same decoded text a browser paints. Code-like subtrees
    // come out first because a documentation page showing `**bold**` on purpose
    // is the single largest false-positive class this rule has — without the
    // exclusion it fires on its own documentation.
    const text = collectTextExcluding(body, isCodeLikeElement, SKIPPED_SUBTREE_BOUNDARY);
    const found = findUnrenderedMarkup(text);

    const hasRawMarkup = found.some((f) => RAW_MARKUP_KINDS.has(f.kind));
    const markdownCount = found
      .filter((f) => !RAW_MARKUP_KINDS.has(f.kind) && !CORROBORATING_KINDS.has(f.kind))
      .reduce((sum, f) => sum + f.count, 0);

    // Backticks alone say nothing: they are the one markdown character pages
    // display on purpose. Everything else is reported, and the corroborating
    // family rides along in the detail once something real has fired.
    if (!hasRawMarkup && markdownCount === 0) {
      checks.push({
        name: "unrendered-markup",
        status: "pass",
        message: "No unrendered markup in visible text",
      });
      return { checks };
    }

    const total = found.reduce((sum, f) => sum + f.count, 0);
    const kinds = found.map((f) => f.kind).join(", ");

    // Visible tags and entities are not a judgement call: nothing renders them
    // on purpose outside a code block, and those are already excluded. Literal
    // markdown is judged by weight instead — one stray asterisk pair is a typo,
    // three or more is a template that never ran its markdown pass.
    const status = hasRawMarkup || markdownCount >= 3 ? "fail" : "warn";

    checks.push({
      name: "unrendered-markup",
      status,
      message: `${total} unrendered markup occurrence(s) in visible text (${kinds}): example ${found[0]?.sample}`,
      value: total,
      details: {
        kinds: found.map((f) => ({ kind: f.kind, sample: f.sample, count: f.count })),
      },
    });
    return { checks };
  },
};
