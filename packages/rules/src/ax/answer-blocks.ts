// ax/answer-blocks - can an answer engine quote this page? Advisory, never scored.
//
// Two deterministic checks on content pages: a question heading is followed by a short,
// self-contained direct answer, and data tables and charts carry a source next to them.
// The date, author and citation signals already exist as eeat/* and content/* rules; the
// report links to them from the Agents section instead of repeating them here.

import type { CheckItem } from "@squirrelscan/core-contracts";

import { CHECK_NOT_APPLICABLE_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Page types where a question heading is a product FAQ or a listing, not an article.
const NON_CONTENT_PAGE_TYPES = new Set([
  "product",
  "category",
  "search",
  "contact",
  "profile",
  "event",
  "local",
  "media",
]);

const MAX_HEADINGS = 200;
const MAX_FIGURES = 50;
const MAX_TEXT = 800;
const MAX_OPENING_WORDS = 60;
const HEADING_SELECTOR = "h2, h3, h4";
const ANY_HEADING = "h1, h2, h3, h4, h5, h6";
const CHROME_SELECTOR = "nav, footer, aside, [hidden], [aria-hidden='true']";

const PRONOUN_OPENER =
  /^(it|its|they|them|their|he|she|this|that|these|those)\b/i;
const DEMONSTRATIVES = new Set(["this", "that", "these", "those"]);
// A demonstrative followed by one of these is standing in for a noun; followed by a noun it is a determiner.
const DEMONSTRATIVE_VERBS = new Set([
  "is",
  "are",
  "was",
  "were",
  "can",
  "will",
  "means",
  "has",
  "have",
  "does",
  "do",
  "depends",
  "refers",
  "allows",
  "helps",
  "may",
  "should",
  "could",
  "would",
  "'s",
]);
const SOURCE_CUE =
  /\b(?:source|sources|credit|credits|via|data from|data by|courtesy|retrieved from|adapted from|according to|photo by|image by|chart by)\b|©|\(c\)/i;
const CHART_HINT = /chart|graph|diagram|infographic|statistic|survey/i;

const collapse = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

function isQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text) && text.split(" ").length >= 3;
}

type Answer =
  | { kind: "text"; text: string }
  | { kind: "structured" }
  | { kind: "none" };

function containsHeading(el: Element): boolean {
  return !!el.querySelector(ANY_HEADING);
}

// The first block of body text after a heading, before the next heading.
function firstBlock(start: Element): Answer {
  let el: Element | null = start;
  for (let depth = 0; depth < 3 && el; depth++) {
    let sib: Element | null = el.nextElementSibling;
    while (sib) {
      const tag = sib.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag) || containsHeading(sib)) return { kind: "none" };
      if (tag === "p") {
        const text = collapse(sib.textContent).slice(0, MAX_TEXT);
        if (text) return { kind: "text", text };
      } else if (
        ["ul", "ol", "dl", "table", "pre", "blockquote"].includes(tag)
      ) {
        return { kind: "structured" };
      } else if (["div", "section", "span"].includes(tag)) {
        const p = sib.querySelector("p");
        const text = collapse((p ?? sib).textContent).slice(0, MAX_TEXT);
        if (text) return { kind: "text", text };
      }
      sib = sib.nextElementSibling;
    }
    const parent: Element | null = el.parentElement;
    if (!parent || /^(body|main|article|section)$/i.test(parent.tagName)) break;
    el = parent;
  }
  return { kind: "none" };
}

function openingProblem(text: string): string | null {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“(])/);
  const first = sentences[0] ?? "";
  const words = first.split(" ").filter(Boolean);
  const pronoun = PRONOUN_OPENER.exec(first)?.[1]?.toLowerCase();
  if (pronoun) {
    if (!DEMONSTRATIVES.has(pronoun)) return "opens with a pronoun";
    const next = (words[1] ?? "").toLowerCase().replace(/[^a-z']/g, "");
    if (DEMONSTRATIVE_VERBS.has(next)) return "opens with a pronoun";
  }
  if (words.length > MAX_OPENING_WORDS) return "first sentence is too long";
  return null;
}

function labelOf(el: Element, fallback: string): string {
  const cap = collapse(el.querySelector("caption, figcaption")?.textContent);
  const th = collapse(el.querySelector("th")?.textContent);
  return clip(cap || th || fallback, 80);
}

function hasSourceNearby(el: Element): boolean {
  const container =
    el.tagName.toLowerCase() === "table" ? (el.closest("figure") ?? el) : el;
  const near: Element[] = [];
  for (const q of ["caption", "figcaption", "tfoot"]) {
    const found = container.querySelector(q);
    if (found) near.push(found);
  }
  for (const sib of [
    container.previousElementSibling,
    container.nextElementSibling,
  ]) {
    if (sib && collapse(sib.textContent).length <= 400) near.push(sib);
  }
  return near.some(
    (n) =>
      SOURCE_CUE.test(collapse(n.textContent)) ||
      !!n.querySelector("a[href^='http']")
  );
}

function isDataTable(t: Element): boolean {
  const role = t.getAttribute("role");
  if (role === "presentation" || role === "none") return false;
  if (t.querySelector("table")) return false;
  return (
    t.querySelectorAll("tr").length >= 3 && !!t.querySelector("th, td + td")
  );
}

function isChartFigure(f: Element): boolean {
  if (f.querySelector("svg, canvas, table")) return true;
  const hint = `${f.querySelector("figcaption")?.textContent ?? ""} ${f.querySelector("img")?.getAttribute("alt") ?? ""}`;
  return !!f.querySelector("img") && CHART_HINT.test(hint);
}

export const answerBlocksRule: Rule = {
  meta: {
    id: "ax/answer-blocks",
    name: "Answer Blocks",
    description:
      "Checks that question headings are followed by a short, self-contained answer and that data tables and charts carry a source, so an answer engine can quote the page",
    solution:
      "Put the answer directly under the question heading. Make the first one or two sentences stand alone: name the subject instead of opening with a pronoun like 'it' or 'this', and keep the opening sentence short. Put the detail after it. Give each data table and chart a caption or a nearby line that names its source, ideally with a link. This check is advisory and never changes the score.",
    category: "ax",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    // info is advisory: it is excluded from the score (#1386).
    severity: "info",
    weight: 1,
    skipOnSoft404: true,
    skipOnNoindex: true,
    checks: [
      { name: "answer-blocks", outcome: "problem" },
      { name: "answer-blocks", outcome: "clean", clears: ["answer-blocks"] },
      { name: "figure-sources", outcome: "problem" },
      { name: "figure-sources", outcome: "clean", clears: ["figure-sources"] },
      { name: "answer-blocks", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    const notApplicable = (message: string): RuleResult => ({
      checks: [
        {
          name: "answer-blocks",
          status: "skipped",
          message,
          skipReason: CHECK_NOT_APPLICABLE_SKIP_REASON,
          details: { foldKey: CHECK_NOT_APPLICABLE_SKIP_REASON },
        },
      ],
    });
    if (!doc || ctx.page.statusCode < 200 || ctx.page.statusCode >= 300) {
      return {
        checks: [
          {
            name: "answer-blocks",
            status: "skipped",
            message: "Page not readable, answer blocks not assessed",
            skipReason: "unreadable",
          },
        ],
      };
    }
    if (NON_CONTENT_PAGE_TYPES.has(ctx.parsed.pageType)) {
      return notApplicable("Not a content page, answer blocks not assessed");
    }

    const checks: CheckResult[] = [];

    // 1. Question headings and their answers.
    const questions: { text: string; reason: string | null }[] = [];
    const headings = Array.from(doc.querySelectorAll(HEADING_SELECTOR)).slice(
      0,
      MAX_HEADINGS
    );
    for (const h of headings) {
      const text = collapse(h.textContent);
      if (!isQuestion(text) || h.closest(CHROME_SELECTOR)) continue;
      const answer = firstBlock(h);
      if (answer.kind === "structured") questions.push({ text, reason: null });
      else if (answer.kind === "none")
        questions.push({ text, reason: "no answer under the heading" });
      else questions.push({ text, reason: openingProblem(answer.text) });
    }
    if (questions.length > 0) {
      const bad = questions.filter((q) => q.reason);
      if (bad.length > 0) {
        const items: CheckItem[] = bad.map((q) => ({
          id: clip(q.text, 120),
          label: `${clip(q.text, 120)} (${q.reason})`,
        }));
        checks.push({
          name: "answer-blocks",
          status: "warn",
          message:
            "Question headings without a short, self-contained answer in the first two sentences",
          value: bad.length,
          expected: 0,
          items,
          details: { questionHeadings: questions.length },
        });
      } else {
        checks.push({
          name: "answer-blocks",
          status: "pass",
          message: "Every question heading is followed by a direct answer",
          value: 0,
          details: { questionHeadings: questions.length },
        });
      }
    }

    // 2. Data tables and charts carry a source.
    const figures: { el: Element; kind: string }[] = [];
    const seen = new Set<Element>();
    for (const f of Array.from(doc.querySelectorAll("figure")).slice(
      0,
      MAX_FIGURES
    )) {
      if (isChartFigure(f) && !f.closest(CHROME_SELECTOR)) {
        figures.push({ el: f, kind: "figure" });
        seen.add(f);
        for (const t of Array.from(f.querySelectorAll("table"))) seen.add(t);
      }
    }
    for (const t of Array.from(doc.querySelectorAll("table")).slice(
      0,
      MAX_FIGURES
    )) {
      if (!seen.has(t) && isDataTable(t) && !t.closest(CHROME_SELECTOR))
        figures.push({ el: t, kind: "table" });
    }
    if (figures.length > 0) {
      const unsourced = figures.filter((f) => !hasSourceNearby(f.el));
      if (unsourced.length > 0) {
        checks.push({
          name: "figure-sources",
          status: "warn",
          message: "Data tables or charts with no source named next to them",
          value: unsourced.length,
          expected: 0,
          items: unsourced.map((f) => {
            const label = `${f.kind}: ${labelOf(f.el, "untitled")}`;
            return { id: label, label };
          }),
          details: { figures: figures.length },
        });
      } else {
        checks.push({
          name: "figure-sources",
          status: "pass",
          message: "Every data table and chart names its source",
          value: 0,
          details: { figures: figures.length },
        });
      }
    }

    if (checks.length === 0) {
      return notApplicable(
        "No question headings, data tables or charts on this page"
      );
    }
    return { checks };
  },
};
