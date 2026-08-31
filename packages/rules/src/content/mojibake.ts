// content/mojibake - Encoding corruption visible in rendered copy

import { getAttrCI, querySelectorByAttrValueCI } from "@squirrelscan/utils";

import { getProseTextExcludingCode } from "./text-content";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

/**
 * UTF-8 bytes decoded as latin1/cp1252. Every one of these is a real UTF-8 lead byte
 * (0xC2/0xC3/0xE2) rendered as its latin1 character, so they only co-occur in genuinely
 * broken text — matching the SEQUENCE rather than the individual accented letters is
 * what keeps legitimate French, German and Spanish copy clean.
 */
const MOJIBAKE_SEQUENCES = [
  "â€™", // ' right single quote
  "â€œ", // " left double quote
  "â€", // " right double quote
  "â€“", // – en dash
  "â€”", // — em dash
  "â€¦", // … ellipsis
  "Ã©", // é
  "Ã¨", // è
  "Ã¤", // ä
  "Ã¶", // ö
  "Ã¼", // ü
  "Ã±", // ñ
  "Ã§", // ç
  "Ã ", // à
  "Â ", // non-breaking space
  "Â©", // ©
  "Â®", // ®
  "Â°", // °
] as const;

/** U+FFFD: the decoder already gave up on these bytes. Unambiguous corruption. */
const REPLACEMENT_CHAR = "�";

/**
 * Entities that survived one decode too few and render literally as their own source.
 * `&amp;nbsp;` on screen means the source said `&amp;amp;nbsp;`.
 */
const DOUBLE_ENCODED_RE = /&amp;(?:nbsp|amp|quot|lt|gt|#\d+|[a-z]{2,8});/gi;

type Corruption = { kind: string; sample: string; count: number };

/**
 * One alternation, LONGEST FIRST. This ordering is load-bearing: `â€` is a prefix of
 * `â€™`, `â€œ`, `â€“`, `â€”` and `â€¦`, so counting each sequence independently counts
 * every long one twice — once as itself and once as its own prefix. Regex alternation
 * is first-match-wins, so longest-first consumes the full sequence and the counts stay
 * honest.
 */
const MOJIBAKE_RE = new RegExp(
  [...MOJIBAKE_SEQUENCES]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "g",
);

/** Every corruption family present in `text`, with a sample and a count for each. */
export function findMojibake(text: string): Corruption[] {
  const out: Corruption[] = [];

  const seqMatches = [...text.matchAll(MOJIBAKE_RE)].map((m) => m[0]);
  if (seqMatches.length > 0) {
    const tally = new Map<string, number>();
    for (const s of seqMatches) tally.set(s, (tally.get(s) ?? 0) + 1);
    out.push({
      kind: "utf8-as-latin1",
      // Most frequent sequence is the most useful thing to show first.
      sample: [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0],
      count: seqMatches.length,
    });
  }

  const replacements = text.split(REPLACEMENT_CHAR).length - 1;
  if (replacements > 0)
    out.push({ kind: "replacement-char", sample: REPLACEMENT_CHAR, count: replacements });

  const doubles = [...text.matchAll(DOUBLE_ENCODED_RE)];
  if (doubles.length > 0)
    out.push({ kind: "double-encoded-entity", sample: doubles[0]![0], count: doubles.length });

  return out;
}

/** The page's declared encoding, from `<meta charset>` or the http-equiv form, lowercased. */
export function declaredCharset(
  doc: NonNullable<RuleContext["parsed"]["document"]>,
): string | undefined {
  for (const meta of doc.querySelectorAll("meta")) {
    const val = getAttrCI(meta, "charset");
    if (val !== null && val.trim()) return val.trim().toLowerCase();
  }
  const httpEquiv = querySelectorByAttrValueCI(doc, "meta", "http-equiv", "Content-Type");
  const match = (httpEquiv?.getAttribute("content") || "").match(/charset=([^\s;]+)/i);
  return match?.[1]?.trim().toLowerCase();
}

const isUtf8 = (charset: string | undefined): boolean => charset === "utf-8" || charset === "utf8";

export const mojibakeRule: Rule = {
  meta: {
    id: "content/mojibake",
    name: "Encoding Corruption",
    description: "Detects mojibake and replacement characters in visible text",
    solution:
      'Mojibake means the bytes and the declared encoding disagree. Fix the declaration first: serve `<meta charset="utf-8">` as the first thing in the head, and send `Content-Type: text/html; charset=utf-8`. If the declaration is already utf-8, the source itself was double-encoded, usually by a CMS migration that read utf-8 bytes as latin1 and re-encoded them. Re-import the affected content from the original source rather than search-and-replacing the visible symptoms, because the same corruption is usually present in fields you cannot see, such as meta descriptions and alt text.',
    category: "content",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) {
      checks.push({
        name: "encoding-corruption",
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    const body = doc.querySelector("body");
    if (!body) {
      checks.push({
        name: "encoding-corruption",
        status: "skipped",
        message: "No body element to read visible text from",
        skipReason: "no-body",
      });
      return { checks };
    }

    // Prose only, never raw HTML: a `&amp;nbsp;` in an attribute or an encoded
    // sequence inside a <script> is not something a reader ever sees. Code-like
    // elements are excluded for the opposite reason — a reader DOES see them, but
    // <code>â€™</code> is a page quoting the sequence on purpose, not a page whose
    // bytes are broken. Without this the rule fires on its own documentation.
    const text = getProseTextExcludingCode(body);
    const found = findMojibake(text);

    if (found.length === 0) {
      checks.push({
        name: "encoding-corruption",
        status: "pass",
        message: "No encoding corruption in visible text",
      });
      return { checks };
    }

    const charset = declaredCharset(doc);
    const total = found.reduce((sum, f) => sum + f.count, 0);
    const kinds = found.map((f) => f.kind).join(", ");

    // Attributing the CAUSE is what makes this actionable: "you have weird
    // characters" is not a fix, and the two causes have different fixes.
    const cause =
      charset === undefined
        ? 'no charset is declared, so the browser guessed the encoding: add <meta charset="utf-8">'
        : isUtf8(charset)
          ? "charset is correctly utf-8, so the source itself is double-encoded: re-import the content from its original source"
          : `charset is declared as "${charset}", not utf-8: correct the declaration, then re-check whether the source is also double-encoded`;

    // U+FFFD is unambiguous corruption; the rest can be argued with, so only the
    // replacement character escalates to a hard failure.
    const hasReplacement = found.some((f) => f.kind === "replacement-char");

    checks.push({
      name: "encoding-corruption",
      status: hasReplacement ? "fail" : "warn",
      message: `${total} encoding corruption occurrence(s) in visible text (${kinds}): ${cause}`,
      value: total,
      details: {
        charset: charset ?? null,
        kinds: found.map((f) => ({ kind: f.kind, sample: f.sample, count: f.count })),
      },
    });
    return { checks };
  },
};
