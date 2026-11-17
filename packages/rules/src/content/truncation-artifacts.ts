// content/truncation-artifacts - Copy cut off by a character limit instead of written to length.
//
// A CMS or a theme that does `substr(text, 0, 160)` leaves a title, a meta description
// or an excerpt that stops in the middle of a word. The title and the description are
// what a search result shows, so a cut there costs more than a cut in body copy.
//
// The signal is the CUT, never the ellipsis. A trailing ellipsis after a whole word is
// ordinary writing ("Wait for it..."), and a quotation may end on one, so each field is
// judged by evidence that the text stopped inside a word:
//   1. PROOF: the text (minus any ellipsis) is a prefix of a longer text on the same page
//      (the H1, og:title, og:description, the body) and the longer text carries on with
//      a letter or digit. A title that reads "Introducing the new dashbo" beside an H1
//      "Introducing the new dashboard" has been cut, with no guessing.
//   2. An ellipsis glued to a letter (`dashbo...`) where the visible text is exactly a
//      round CMS limit long (60, 70, 155, 160 ...).
//   3. A title or description with no ellipsis that is exactly a round limit long and
//      ends on a word that can never end a phrase ("the", "and", "of").
// Title and description findings fail. Body findings only warn.

import type { CheckItem } from "@squirrelscan/core-contracts";

import { noindexSource } from "../shared/noindex";

import { getRenderedProseText } from "./text-content";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const CHECK = "truncation-artifacts";

export type TruncationField = "title" | "meta description" | "body";
export type TruncationReason = "prefix-of-longer-text" | "ellipsis-at-limit" | "dangling-word-at-limit";

export interface TruncationFinding {
  field: TruncationField;
  reason: TruncationReason;
  /** The text as the page carries it, clipped for display. */
  text: string;
}

const MAX_ITEMS = 10;
const MAX_SNIPPET = 90;
/** Shorter fragments are too likely to be a real, complete short text. */
const MIN_FRAGMENT = 20;
const MIN_BODY_FRAGMENT = 40;
const MAX_BODY_BLOCKS = 400;

/** Round limits CMS plugins and SERP-length advice make into hard cuts. */
const TITLE_LIMITS = new Set([50, 55, 56, 60, 65, 70]);
const DESCRIPTION_LIMITS = new Set([110, 120, 150, 155, 156, 158, 160, 165, 170]);
/** Body excerpts are compared on the visible text before the ellipsis only: a coincidental length is common in prose. */
const BODY_LIMITS = new Set([100, 120, 150, 155, 160, 200, 250, 300]);

/** Trailing ellipsis in any of its common spellings, including the bracketed WordPress form. */
const TRAILING_ELLIPSIS = /\s*(?:\[\s*(?:\.{3}|…)\s*\]|\.{3,}|…)\s*$/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Words that cannot be the last word of a finished title or sentence. */
const DANGLING = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "by", "at", "from",
  "your", "our", "their", "its", "is", "are", "as", "&", "how", "that", "this", "into",
]);

const READ_MORE = /\b(?:read(?:ing)? more|continue reading|keep reading|learn more|more|full (?:story|article|post)|view (?:more|post|article)|see more)\b|^\s*(?:…|\.\.\.|»|›|>|\[…\])\s*$/i;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string): string => (s.length <= MAX_SNIPPET ? s : `…${s.slice(s.length - MAX_SNIPPET + 1)}`);

interface Split {
  /** The text with any trailing ellipsis removed. */
  fragment: string;
  hadEllipsis: boolean;
  /** The ellipsis touches a letter or digit: `dashbo...`, not `dashboard ...`. */
  glued: boolean;
  /** Characters of the original that the ellipsis took up (0 when there is none). */
  ellipsisLength: number;
}

export function splitEllipsis(raw: string): Split {
  const text = squash(raw);
  const m = TRAILING_ELLIPSIS.exec(text);
  if (!m) return { fragment: text, hadEllipsis: false, glued: false, ellipsisLength: 0 };
  const fragment = text.slice(0, m.index);
  const glued = m[0].charAt(0) !== " " && WORD_CHAR.test(fragment.charAt(fragment.length - 1));
  return { fragment, hadEllipsis: true, glued, ellipsisLength: text.length - fragment.length };
}

/**
 * True when `fragment` appears in `source` and the source goes on with a letter or digit,
 * so the fragment stopped inside a word. The fragment must end on a letter or digit too:
 * "dashboard." followed by more text is a sentence boundary, not a cut.
 */
export function cutInsideWord(fragment: string, source: string, anywhere: boolean): boolean {
  const frag = fragment.toLowerCase();
  const src = source.toLowerCase();
  if (!WORD_CHAR.test(frag.charAt(frag.length - 1))) return false;
  let from = 0;
  for (;;) {
    const at = src.indexOf(frag, from);
    if (at === -1) return false;
    if (!anywhere && at !== 0) return false;
    const next = src.charAt(at + frag.length);
    if (next !== "" && WORD_CHAR.test(next)) return true;
    from = at + 1;
  }
}

function lastWord(fragment: string): string {
  return fragment.split(/\s+/).pop()?.toLowerCase() ?? "";
}

function metaContent(doc: Document, attr: "property" | "name", value: string): string {
  for (const el of Array.from(doc.querySelectorAll("meta"))) {
    if ((el.getAttribute(attr) ?? "").toLowerCase() === value) return squash(el.getAttribute("content") ?? "");
  }
  return "";
}

/** Judge one SERP-visible field against the longer texts on the page. */
export function judgeSerpField(
  field: "title" | "meta description",
  raw: string,
  longer: readonly string[],
  bodyText: string,
): TruncationFinding | undefined {
  const split = splitEllipsis(raw);
  const { fragment } = split;
  const finding = (reason: TruncationReason): TruncationFinding => ({ field, reason, text: clip(squash(raw)) });
  if (fragment.length === 0) return undefined;

  if (fragment.length >= MIN_FRAGMENT) {
    for (const source of longer) {
      if (source.length > fragment.length && cutInsideWord(fragment, source, false)) {
        return finding("prefix-of-longer-text");
      }
    }
    if (field === "meta description" && fragment.length >= MIN_BODY_FRAGMENT && cutInsideWord(fragment, bodyText, true)) {
      return finding("prefix-of-longer-text");
    }
  }

  const limits = field === "title" ? TITLE_LIMITS : DESCRIPTION_LIMITS;
  const visible = squash(raw).length;
  const atLimit = limits.has(fragment.length) || limits.has(visible);

  if (split.hadEllipsis) {
    if (split.glued && atLimit && fragment.length >= MIN_FRAGMENT) return finding("ellipsis-at-limit");
    return undefined;
  }
  if (atLimit && fragment.length >= MIN_FRAGMENT && DANGLING.has(lastWord(fragment))) {
    return finding("dangling-word-at-limit");
  }
  return undefined;
}

function hasReadMore(block: Element): boolean {
  // A block inside a link is a clickable card: the reader can always continue.
  if (block.closest("a")) return true;
  const scope = block.parentElement ?? block;
  return Array.from(scope.querySelectorAll("a")).some((a) => READ_MORE.test(squash(a.textContent ?? "")));
}

/** Body blocks that end in an orphaned or mid-word ellipsis. */
export function findBodyTruncations(doc: Document, bodyText: string): TruncationFinding[] {
  const out: TruncationFinding[] = [];
  const blocks = Array.from(doc.querySelectorAll("p, li, dd")).slice(0, MAX_BODY_BLOCKS);
  for (const block of blocks) {
    // A quotation may end on an ellipsis by design, and code shows literal text.
    if (block.closest("blockquote, q, pre, code, nav, template, noscript")) continue;
    const text = squash(getRenderedProseText(block));
    const split = splitEllipsis(text);
    if (!split.hadEllipsis || !split.glued || split.fragment.length < MIN_BODY_FRAGMENT) continue;
    if (hasReadMore(block)) continue;

    const rest = bodyText.replace(text, " ");
    const atLimit = BODY_LIMITS.has(split.fragment.length);
    const proven = cutInsideWord(split.fragment, rest, true);
    if (!proven && !atLimit) continue;
    out.push({ field: "body", reason: proven ? "prefix-of-longer-text" : "ellipsis-at-limit", text: clip(text) });
  }
  return out;
}

const REASON_LABEL: Record<TruncationReason, string> = {
  "prefix-of-longer-text": "cut mid-word: a longer version of the same text is on the page",
  "ellipsis-at-limit": "ends in an ellipsis glued to a partial word at a round character limit",
  "dangling-word-at-limit": "stops on a dangling word at a round character limit",
};

const FIELD_LABEL: Record<TruncationField, string> = {
  title: "<title>",
  "meta description": "meta description",
  body: "body copy",
};

export const truncationArtifactsRule: Rule = {
  meta: {
    id: "content/truncation-artifacts",
    name: "Truncation Artifacts",
    description: "Finds titles, meta descriptions and body copy cut mid-word by a character limit",
    solution:
      "A title, meta description or excerpt that stops inside a word was cut by a character limit instead of written to length, and a search result shows the stump. Write the title (about 50 to 60 characters) and description (about 150 to 160) to length in the CMS field, or trim on a word boundary and end on a whole word. If a theme builds the description from the body, change its excerpt function to cut at the last space before the limit and to append the ellipsis only after a whole word. Body excerpts that end in an ellipsis need a read more link beside them. A deliberate ellipsis after a whole word, and an ellipsis inside a quotation, are not flagged.",
    category: "content",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CHECK, outcome: "clean", clears: [CHECK] },
      { name: CHECK, outcome: "skipped" },
    ],
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const skip = (message: string, skipReason: string): RuleResult => ({
      checks: [{ name: CHECK, status: "skipped", message, skipReason }],
    });
    const doc = ctx.parsed.document;
    if (!doc) return skip("No document available", "unread-page");

    const noindex = noindexSource(ctx.parsed, ctx.page.headers);
    if (noindex) return skip(`Page is noindex (${noindex}); it never appears in a search result`, "noindex");

    const title = squash(ctx.parsed.meta.title ?? "");
    const description = squash(ctx.parsed.meta.description ?? "");
    const bodyText = squash(doc.body ? getRenderedProseText(doc.body) : "");
    if (!title && !description && bodyText.length === 0) {
      return skip("No title, description or body copy to read", "no-text");
    }

    const findings: TruncationFinding[] = [];
    if (title) {
      // Rendered text, so `<br>` and block children separate words as the browser shows them.
      const h1El = doc.querySelector("h1");
      const h1 = h1El ? squash(getRenderedProseText(h1El)) : "";
      const f = judgeSerpField(
        "title",
        title,
        [h1, metaContent(doc, "property", "og:title"), metaContent(doc, "name", "twitter:title")].filter(Boolean),
        bodyText,
      );
      if (f) findings.push(f);
    }
    if (description) {
      const f = judgeSerpField(
        "meta description",
        description,
        [metaContent(doc, "property", "og:description"), metaContent(doc, "name", "twitter:description")].filter(Boolean),
        bodyText,
      );
      if (f) findings.push(f);
    }
    findings.push(...findBodyTruncations(doc, bodyText));

    if (findings.length === 0) {
      return { checks: [{ name: CHECK, status: "pass", message: "No title, description or body copy looks cut by a character limit" }] };
    }

    const serp = findings.filter((f) => f.field !== "body");
    const first = serp[0] ?? findings[0]!;
    const items: CheckItem[] = findings.slice(0, MAX_ITEMS).map((f) => ({
      id: `${f.field}:${f.text}`,
      label: `${FIELD_LABEL[f.field]} ${REASON_LABEL[f.reason]}`,
      snippet: f.text,
    }));
    const check: CheckResult = {
      name: CHECK,
      status: serp.length > 0 ? "fail" : "warn",
      message: `${FIELD_LABEL[first.field]} ${REASON_LABEL[first.reason]}: "${first.text}"${findings.length > 1 ? ` (${findings.length} cut texts on the page)` : ""}`,
      value: findings.length,
      items,
      details: { fields: [...new Set(findings.map((f) => f.field))], ...(findings.length > MAX_ITEMS ? { additional: findings.length - MAX_ITEMS } : {}) },
    };
    return { checks: [check] };
  },
};
