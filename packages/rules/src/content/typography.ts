// content/typography - typographic hygiene in body copy

import { getRenderedProseText, getRenderedProseTextNodes } from "./text-content";

import type { Rule, RuleResult, CheckResult } from "../types";

/**
 * Languages that legitimately put a space before `; : ! ?` (French typography and
 * the languages that follow it). The space-before-punctuation check is not run for
 * them, and not for a page with no `lang` either: with no declared locale we cannot
 * tell a French page from a sloppy English one, so we stay quiet.
 */
const SPACE_BEFORE_PUNCT_LOCALES = new Set(["fr", "br", "oc", "co", "wa", "ht", "ln", "wo", "mg"]);

/** At or above this many occurrences the check fails instead of warning. */
const FAIL_THRESHOLD = 20;

type Kind = "double-space" | "mixed-quotes" | "space-before-punctuation" | "double-hyphen-dash";
type Finding = { kind: Kind; count: number; sample: string };

/** Two or more spaces, or a space beside a no-break space, between words on one line. */
const DOUBLE_SPACE_RE = /\S(?: {2,}|[ ]\u00A0|\u00A0[ ])(?=\S)/gu;
/** A word character, one space, then `, . ; : ! ?` that ends a word (not `.com`, `...`, `:)`). */
const SPACE_BEFORE_PUNCT_RE = /[\p{L}\p{N})] [,.;:!?](?=\s|$)/gu;
/** `--` as a spaced dash or glued between words. Not `---`, `-->` or a ` --flag`. */
const DOUBLE_HYPHEN_RE = /(?<!-)(?:\s--\s|[\p{L}\p{N}]--[\p{L}\p{N}])(?!-)/gu;

const count = (re: RegExp, text: string): { n: number; first: string } => {
  const all = [...text.matchAll(re)];
  return { n: all.length, first: all[0]?.[0] ?? "" };
};

const show = (s: string): string => s.replace(/\u00A0/g, "[nbsp]");

/**
 * Findings for one page's prose text. `checkPunctSpacing` is off for French and friends.
 * `textNodes` are the same prose as separate text nodes: double spaces are counted per
 * node, because whitespace where two nodes meet collapses to one space when rendered.
 * Without it, `text` is treated as a single node.
 */
export function findTypographyIssues(
  text: string,
  checkPunctSpacing: boolean,
  textNodes: readonly string[] = [text],
): Finding[] {
  const out: Finding[] = [];

  let dblCount = 0;
  let dblFirst = "";
  for (const value of textNodes) {
    const dbl = count(DOUBLE_SPACE_RE, value);
    if (dbl.n === 0) continue;
    if (dblCount === 0) dblFirst = dbl.first;
    dblCount += dbl.n;
  }
  if (dblCount > 0)
    out.push({ kind: "double-space", count: dblCount, sample: show(dblFirst) || "double space" });

  // Straight and curly are only "mixed" when the SAME family uses both. Double quotes and
  // single quotes/apostrophes are separate families: a page can be all-curly doubles.
  const straightDouble = text.split('"').length - 1;
  const curlyDouble = (text.match(/[“”]/g) ?? []).length;
  const straightSingle = text.split("'").length - 1;
  const curlySingle = (text.match(/[‘’]/g) ?? []).length;
  const mixedDouble = straightDouble > 0 && curlyDouble > 0;
  const mixedSingle = straightSingle > 0 && curlySingle > 0;
  if (mixedDouble || mixedSingle) {
    const parts: string[] = [];
    if (mixedDouble) parts.push(`${straightDouble} straight and ${curlyDouble} curly double`);
    if (mixedSingle) parts.push(`${straightSingle} straight and ${curlySingle} curly single`);
    const n =
      (mixedDouble ? Math.min(straightDouble, curlyDouble) : 0) +
      (mixedSingle ? Math.min(straightSingle, curlySingle) : 0);
    out.push({ kind: "mixed-quotes", count: n, sample: parts.join(", ") });
  }

  if (checkPunctSpacing) {
    const sp = count(SPACE_BEFORE_PUNCT_RE, text);
    if (sp.n > 0) out.push({ kind: "space-before-punctuation", count: sp.n, sample: sp.first });
  }

  const dash = count(DOUBLE_HYPHEN_RE, text);
  if (dash.n > 0)
    out.push({ kind: "double-hyphen-dash", count: dash.n, sample: dash.first.trim() });

  return out;
}

export const typographyRule: Rule = {
  meta: {
    id: "content/typography",
    name: "Typographic Hygiene",
    description:
      "Detects double spaces, mixed straight and curly quotes, spaces before punctuation and `--` used as a dash in body copy",
    solution:
      "Pick one convention and apply it across the page. Collapse repeated spaces to one (use CSS for layout spacing, not extra spaces). Use either straight or curly quotes and apostrophes consistently, ideally by letting your editor or CMS smart-quote the copy. Remove the space before `, . ; : ! ?` in English copy (French and similar locales keep it, so set `lang` correctly). Replace `--` with a real em dash or a comma, colon or full stop.",
    category: "content",
    scope: "page",
    verdictScope: "page",
    severity: "info",
    weight: 1,
    // Check names by outcome class (#1741).
    checks: [
      { name: "typography", outcome: "problem" },
      { name: "typography", outcome: "clean", clears: ["typography"] },
      { name: "typography", outcome: "skipped" },
    ],
  },

  run(ctx): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) {
      checks.push({
        name: "typography",
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }
    const body = doc.querySelector("body");
    if (!body) {
      checks.push({
        name: "typography",
        status: "skipped",
        message: "No body element to read copy from",
        skipReason: "no-body",
      });
      return { checks };
    }

    // Prose only: <pre>, <code>, <samp>, <kbd>, scripts and highlighter containers are
    // literals, so a `--flag` or two-space indent there is not a typo.
    const text = getRenderedProseText(body);
    const lang = (doc.documentElement?.getAttribute("lang") ?? "")
      .trim()
      .toLowerCase()
      .split(/[-_]/)[0]!;
    const checkPunctSpacing = lang !== "" && !SPACE_BEFORE_PUNCT_LOCALES.has(lang);
    // Double spaces are judged per text node: where two nodes meet, the browser
    // collapses the whitespace, so the joined text would report spaces nobody sees.
    const found = findTypographyIssues(text, checkPunctSpacing, getRenderedProseTextNodes(body));

    if (found.length === 0) {
      checks.push({
        name: "typography",
        status: "pass",
        message: "No typographic inconsistencies in body copy",
      });
      return { checks };
    }

    const total = found.reduce((sum, f) => sum + f.count, 0);
    const kinds = found.map((f) => f.kind).join(", ");
    checks.push({
      name: "typography",
      status: total >= FAIL_THRESHOLD ? "fail" : "warn",
      message: `${total} typographic issue(s) in body copy (${kinds})`,
      value: total,
      details: { kinds: found.map((f) => ({ kind: f.kind, count: f.count, sample: f.sample })) },
    });
    return { checks };
  },
};
