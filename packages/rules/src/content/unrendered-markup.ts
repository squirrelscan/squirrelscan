// content/unrendered-markup - Markup that failed to render and leaked into visible copy

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
]);

/** `class="language-ts"` / `class="lang-ts"`: the same marker, spelled per-language. */
const HIGHLIGHT_CLASS_PREFIXES = ["language-", "lang-"] as const;

/** Attributes a highlighter or MDX renderer writes on the block it owns. */
const HIGHLIGHT_ATTRIBUTES = new Set([
  "data-language",
  "data-lang",
  "data-highlighted",
  "data-code",
]);

const SCRIPT_OR_CODE_TAGS = new Set<string>([...SCRIPT_LIKE_TAGS, ...CODE_LIKE_TAGS]);

/**
 * Elements a browser lays out on their own line. Their text has to be kept
 * apart, or `<p>a</p><p>b</p>` reads back as `ab` and every line-anchored
 * pattern here (a leading `## `, a fence) can only ever match at offset 0 —
 * which on a real page means after the header and nav, never.
 */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "details", "dialog",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main",
  "nav", "ol", "p", "section", "summary", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "ul", "option", "optgroup", "caption", "legend", "menu",
]);

/** True for any element a browser starts on a new line. */
export function isBlockElement(el: Element): boolean {
  const tag = el.tagName?.toLowerCase();
  return !!tag && BLOCK_TAGS.has(tag);
}

/**
 * True for any element whose subtree is source-on-display rather than prose.
 *
 * One pass over `attributes`, not five: this runs on every element of every
 * crawled page, and `getAttrCI` walks the whole list per call. getAttribute
 * itself is case-SENSITIVE on this parser, which is why the names are folded
 * here rather than looked up directly.
 */
export function isCodeLikeElement(el: Element): boolean {
  const tag = el.tagName?.toLowerCase();
  if (tag && SCRIPT_OR_CODE_TAGS.has(tag)) return true;

  for (const attr of el.attributes) {
    const name = attr.name.toLowerCase();
    if (HIGHLIGHT_ATTRIBUTES.has(name)) return true;
    if (name !== "class") continue;
    for (const token of attr.value.split(/\s+/)) {
      if (!token) continue;
      const lower = token.toLowerCase();
      if (HIGHLIGHT_CLASS_TOKENS.has(lower)) return true;
      for (const prefix of HIGHLIGHT_CLASS_PREFIXES) {
        if (lower.startsWith(prefix) && lower.length > prefix.length) return true;
      }
    }
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
  /!?\[[^\]\n]{0,80}\]\((?:https?:\/\/|mailto:|\/|#|www\.|[\w.-]{1,60}\.[a-z]{2,10}[/?#])[^)\s]{0,300}\)/g;

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
const MD_HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(?=[^\s#\d])([^\n]{1,100})/gm;

/**
 * A SINGLE `#` is also the number sign, and now that every block starts a line
 * the number sign starts plenty of them: `<th># of seats</th>` is a column
 * header, and MDN's specification table renders `HTML<br /># the-pre-element`,
 * a real line showing the link's fragment. Both are lowercase after the hash.
 *
 * `##` and deeper have no such second reading, so they are taken as written —
 * which keeps `## my-package` and `## getting-started`, headings a changelog
 * really can lose.
 */
const HEADING_IS_PROSE = (m: RegExpExecArray): boolean =>
  (m[1] ?? "").length > 1 || /^[A-Z]/.test((m[2] ?? "").trim());

/** A fence line: three or more backticks or tildes, optionally with an info string. */
const MD_FENCE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]{0,60}/gm;

/**
 * Inline code span. Backticks are near-absent from ordinary prose, so flanking
 * plus a non-space interior is enough; the run is bounded to keep it linear.
 */
const MD_INLINE_CODE_RE = /(?:^|[\s([{'"])`(?=[^\s`])([^`\n]{1,200})`(?=$|[\s.,;:!?)\]}'"])/gm;

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
 * The name bound is DERIVED, never a literal. `blockquote` and `figcaption` are
 * ten characters, so a hand-written `{0,9}` tail sits exactly on the limit and
 * the next longer name added to the set above would compile, review clean, and
 * silently never match.
 */
export const MAX_TAG_NAME_LENGTH = Math.max(
  ...[...VISIBLE_HTML_TAGS, ...AMBIGUOUS_HTML_TAGS].map((t) => t.length),
);

/**
 * HTML tags a reader can SEE. The page source said `&lt;p&gt;`; `.textContent`
 * decodes that, so by the time the text reaches here it is a literal `<p>`.
 * Scanning the raw HTML for `&lt;` instead would be the same rule written
 * backwards, and would fire on every escaped example inside a code block.
 *
 * One bounded character class, not two adjacent quantifiers: `[^<>\n]{0,200}`
 * cannot match the closing `>`, so it stops at the first one and never
 * re-partitions a long run the way `\s*[^>]*` would. It excludes the newline
 * for a second reason: a block boundary is a newline, so allowing one here
 * would let `<p>x&lt;p</p><span>&gt;y</span>` assemble a `<p>` out of two
 * blocks that each hold half of it.
 *
 * LOWERCASE tag names only. Escaped markup that leaked out of a template came
 * from HTML a server actually emitted, which is lowercase. A capitalised
 * `<Article>` or `<Video>` is a JSX, Astro or Vue COMPONENT name that a page is
 * displaying on purpose — astro.build puts a whole row of them in its hero.
 */
const ESCAPED_TAG_RE = new RegExp(
  `<(/?)([a-z][a-z0-9]{0,${MAX_TAG_NAME_LENGTH - 1}})([^<>\n]{0,200})>`,
  "g",
);

/**
 * Attribute names a browser would recognise. A curated list for the same reason
 * the entity list is curated: the generic shape reads any `word=value` as an
 * attribute, so `if a<b then c=1>0 holds` parses as `<b>` with an attribute
 * `c="1"` and the rule calls an inequality plus an equation a rendering bug —
 * at `fail`, the hardest status it has.
 */
const KNOWN_ATTRIBUTES = new Set([
  "class", "id", "style", "title", "lang", "dir", "role", "hidden", "tabindex",
  "href", "src", "srcset", "sizes", "alt", "rel", "target", "type", "name",
  "value", "content", "charset", "media", "loading", "decoding", "width",
  "height", "colspan", "rowspan", "for", "action", "method", "placeholder",
  "datetime", "label", "cite", "download", "referrerpolicy", "integrity",
  "crossorigin", "http-equiv", "property", "itemprop", "viewbox", "xmlns",
  // Legacy presentational attributes. A mangled rich-text or email import
  // produces exactly this shape — no closing tags, nothing modern — and would
  // otherwise have nothing to vouch for it. Single-letter SVG names (d, x, y)
  // are deliberately absent: `if a<b then d=1>0` would read as an attribute
  // again, which is the false positive this allowlist exists to prevent.
  "align", "valign", "bgcolor", "cellpadding", "cellspacing", "nowrap",
  "frameborder", "allowfullscreen", "scrolling", "poster", "srcdoc", "border",
]);

/**
 * Each `name=` in an attribute list. Bounded and over disjoint classes, so the
 * scan stays linear over the 200 characters `ESCAPED_TAG_RE` can hand it.
 */
const ATTRIBUTE_NAME_RE = /[\s/]([a-z][a-z0-9:_.-]{0,40})[ \t]{0,4}=/gi;

/** True when `rest` assigns a value to an attribute a browser would recognise. */
function hasRecognisedAttribute(rest: string): boolean {
  ATTRIBUTE_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = ATTRIBUTE_NAME_RE.exec(rest)) !== null) {
    const name = (m[1] ?? "").toLowerCase();
    if (KNOWN_ATTRIBUTES.has(name) || name.startsWith("data-") || name.startsWith("aria-")) {
      found = true;
      break;
    }
  }
  ATTRIBUTE_NAME_RE.lastIndex = 0;
  return found;
}

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
 * closing tag with it (`<p>…</p>`) or assigns a value to a RECOGNISED attribute
 * (`<div class="row">`, `<a href="/x">`), because that is what a server emits
 * and what nobody types into a sentence.
 *
 * One such tag vouches for the rest, so a leak of `<p>text</p><br><br>` is
 * counted in full while a page of bare element names is silent.
 */
const closing = (m: RegExpExecArray): boolean => m[1] === "/";

function findEscapedTags(text: string): string[] {
  const candidates: string[] = [];
  // Index of the tag that made the family reportable. It is moved to the front
  // so the report's example line shows real evidence — `<div class="row">`, not
  // the bare `<pre>` that happened to appear first. An INDEX, not the string:
  // the same tag text usually repeats, and removing it by value would drop
  // every copy and undercount the family.
  let vouchingAt = -1;
  ESCAPED_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ESCAPED_TAG_RE.exec(text)) !== null) {
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
    if (ambiguous && !closing(match) && !attrs) continue;
    // A path in angle brackets — `</path/to/file>` — parses as a closing tag
    // whose "attributes" are the rest of the path. A real closing tag has
    // nothing after the name.
    const closesCleanly = closing(match) && rest.trim().length === 0;
    if (vouchingAt < 0 && (closesCleanly || hasRecognisedAttribute(rest))) {
      vouchingAt = candidates.length;
    }
    candidates.push(match[0]);
    // Stop once the list is full AND something has vouched: breaking earlier
    // could drop the one tag that would have made the family reportable.
    if (candidates.length >= MAX_MATCHES_PER_KIND && vouchingAt >= 0) break;
    if (candidates.length >= MAX_MATCHES_PER_KIND * 4) break;
  }
  ESCAPED_TAG_RE.lastIndex = 0;

  if (vouchingAt < 0) return [];
  const [vouching] = candidates.splice(vouchingAt, 1);
  return [vouching as string, ...candidates].slice(0, MAX_MATCHES_PER_KIND);
}


/** Every family of unrendered markup present in `text`, with a sample and a count. */
export function findUnrenderedMarkup(text: string): UnrenderedMarkupFinding[] {
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  const out: UnrenderedMarkupFinding[] = [];

  // Two patterns, ONE family budget: capping each `collect` separately would let
  // the emphasis family reach twice MAX_MATCHES_PER_KIND.
  const emphasis = [
    ...collect(MD_EMPHASIS_ASTERISK_RE, scanned),
    ...collect(MD_EMPHASIS_UNDERSCORE_RE, scanned, INNER_HAS_SPACE),
  ].slice(0, MAX_MATCHES_PER_KIND);
  push(out, "markdown-emphasis", emphasis);
  push(out, "markdown-link", collect(MD_LINK_RE, scanned));
  push(out, "markdown-heading", collect(MD_HEADING_RE, scanned, HEADING_IS_PROSE));
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
    const text = collectTextExcluding(
      body,
      isCodeLikeElement,
      SKIPPED_SUBTREE_BOUNDARY,
      isBlockElement,
    );
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

    // Headline the evidence that DECIDED the status. Counting the corroborating
    // family here would report "6 occurrences" at `warn` on a page whose only
    // real finding is one bold phrase, and would put a backtick span in the
    // example line — the exact thing the family is promised never to do.
    const accusing = found.filter((f) => !CORROBORATING_KINDS.has(f.kind));
    const total = accusing.reduce((sum, f) => sum + f.count, 0);
    const kinds = accusing.map((f) => f.kind).join(", ");
    const example = accusing[0]!.sample;

    // Visible tags and entities are not a judgement call: nothing renders them
    // on purpose outside a code block, and those are already excluded. Literal
    // markdown is judged by weight instead — one stray asterisk pair is a typo,
    // three or more is a template that never ran its markdown pass.
    const status = hasRawMarkup || markdownCount >= 3 ? "fail" : "warn";

    checks.push({
      name: "unrendered-markup",
      status,
      message: `${total} unrendered markup occurrence(s) in visible text (${kinds}): example ${example}`,
      value: total,
      details: {
        kinds: found.map((f) => ({ kind: f.kind, sample: f.sample, count: f.count })),
      },
    });
    return { checks };
  },
};
