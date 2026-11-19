// content/stale-dated-copy - copy that asserts a date which has already passed (repo#1357)
//
// content/freshness reasons about date METADATA (Last-Modified, schema dates).
// This reasons about what the visible copy CLAIMS: "Coming in 2024", "Register now"
// beside a datetime from last year, "Sale ends March 3, 2025", a countdown aimed at
// a past timestamp. A reader and an agent both take those at face value.
//
// Retrospective copy is the false-positive risk ("in 2019 we launched ..."), so a
// sentence only counts when it is future-framed AND carries no past-tense cue, and
// archival pages (noindex, archive URLs, archive body classes) are skipped.
//
// "Now" is injected through the `now` option. The comparison is by calendar MONTH:
// a date counts as passed once its month has ended. That is deliberate. The rule
// cache keys a verdict on the UTC year and month, so a verdict can never be replayed
// into a month it was not computed for, and a day-level answer would be wrong half
// the time a cache replays it.

import { z } from "zod";
import type { Element } from "linkedom";

import type { Rule, RuleContext, RuleResult } from "../types";
import { noindexSource } from "../shared/noindex";

export const optionsSchema = z.object({
  now: z
    .string()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/, "use YYYY-MM or YYYY-MM-DD")
    .optional()
    .describe("Date to judge the copy against (YYYY-MM-DD); defaults to the current UTC date"),
});

const CHECK = "stale-dated-copy";
const MAX_EXAMPLES = 5;
const MAX_SENTENCES = 4000;
const MAX_ADJACENT_CHARS = 600;
/** Distinct stale claims at which a page stops reading as one slip and reads as unmaintained. */
const FAIL_CLAIM_COUNT = 3;

const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
];
const MONTH_ALT = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const YEAR = "(?:19|20)\\d{2}";

/** A calendar month, as a single comparable number. */
interface Ym {
  year: number;
  /** 0-11, or undefined for a year-only date. */
  month?: number;
}

function monthIndex(name: string): number | undefined {
  const i = MONTHS.findIndex((m) => m.startsWith(name.slice(0, 3).toLowerCase()));
  return i < 0 ? undefined : i;
}

/** True once the date's period has fully ended relative to `now`. */
export function hasPassed(date: Ym, now: Ym): boolean {
  if (date.month === undefined) return date.year < now.year;
  return date.year * 12 + date.month < now.year * 12 + (now.month ?? 0);
}

/** Resolve the injected "now". The clock is read only when no `now` was injected. */
export function resolveNow(option: string | undefined): Ym {
  if (option) {
    return { year: Number(option.slice(0, 4)), month: Number(option.slice(5, 7)) - 1 };
  }
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

/** An ISO-ish datetime, or a 10/13 digit epoch, as a month. */
export function parseMachineDate(
  raw: string | null | undefined,
  allowBareYear = true,
): Ym | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  // A bare 4-digit number is a year in <time datetime>, but a seconds-remaining value in a countdown attribute.
  if (!allowBareYear && /^\d{4}$/.test(value)) return undefined;
  if (/^\d{13}$/.test(value) || /^\d{10}$/.test(value)) {
    const d = new Date(value.length === 13 ? Number(value) : Number(value) * 1000);
    return Number.isNaN(d.getTime()) ? undefined : { year: d.getUTCFullYear(), month: d.getUTCMonth() };
  }
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(value);
  if (!m) return undefined;
  const year = Number(m[1]);
  if (year < 1990 || year > 2999) return undefined;
  if (m[2] === undefined) return { year };
  const month = Number(m[2]) - 1;
  return month >= 0 && month <= 11 ? { year, month } : undefined;
}

// --- Text patterns ----------------------------------------------------------

/** Past-tense or historical framing: the sentence is about what happened, not what is coming. */
const RETROSPECTIVE_RE =
  /\b(?:we|they|it|i)\s+(?:launched|started|began|opened|released|founded|introduced|announced|shipped|debuted|celebrated|held|hosted)\b|\b(?:was|were|had|has been|have been|launched|opened|released|founded|announced|debuted|took place|ended|expired|closed|held)\b|\b(?:since|ago|back in|looking back|recap|in review|history|originally|formerly|last year)\b/i;

/** Page-level retrospective framing in the title or first heading. */
const RETROSPECTIVE_PAGE_RE =
  /\b(?:recap|retrospective|year in review|in review|looking back|history of|timeline|archive[sd]?|past events?|what we (?:shipped|learned)|annual report)\b/i;

const FUTURE_CUE_RE =
  /\b(?:upcoming|register now|register today|join us|save the date|rsvp|tickets? on sale|book now|reserve your spot|sign up now|coming soon|early[- ]bird)\b/i;

/** "Coming in 2024", "Launching in March 2024", "Arriving by late 2023". */
const COMING_IN_RE = new RegExp(
  `\\b(?:coming|launching|launches|arriving|opening|debuting|releasing|returning|starting|rolling out)\\s+(?:soon\\s+)?(?:in|on|by|for)\\s+(?:(?:early|late|mid)[- ]\\s*)?(?:(${MONTH_ALT})\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?)?(${YEAR})\\b`,
  "i",
);
/** "New for 2024". */
const NEW_FOR_RE = new RegExp(`\\bnew\\s+for\\s+(${YEAR})\\b`, "i");

/** A full date with a year: "March 3, 2025", "3 March 2025", "2025-03-03", "March 2025". */
const DATE_MONTH_FIRST = `(${MONTH_ALT})\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?(${YEAR})`;
const DATE_DAY_FIRST = `\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\.?,?\\s+(${YEAR})`;
const DATE_ISO = `(${YEAR})-(\\d{2})-\\d{2}`;
const ANY_DATE_RE = new RegExp(`${DATE_DAY_FIRST}|${DATE_MONTH_FIRST}|${DATE_ISO}`, "i");

const END_LEAD =
  "(?:(?:sale|offer|promo(?:tion)?|discount|deal|event|webinar|registration|enrol(?:l)?ment|giveaway|contest|early[- ]bird|applications?|tickets?|pricing)\\s+(?:ends?|ending|closes?|closing|expires?|expiring)|valid\\s+(?:until|through|till)|expires?|ends?\\s+on|register\\s+by|deadline(?:\\s+is)?)";
const END_DATE_RE = new RegExp(`\\b${END_LEAD}\\b[^.!?\\n]{0,25}?(?:${DATE_DAY_FIRST}|${DATE_MONTH_FIRST}|${DATE_ISO})`, "i");

function dateFromMatch(m: RegExpExecArray | null): Ym | undefined {
  if (!m) return undefined;
  // Groups: day-first (1 month, 2 year), month-first (3 month, 4 year), iso (5 year, 6 month).
  if (m[2]) return { year: Number(m[2]), month: monthIndex(m[1]!) };
  if (m[4]) return { year: Number(m[4]), month: monthIndex(m[3]!) };
  if (m[5]) return { year: Number(m[5]), month: Number(m[6]) - 1 };
  return undefined;
}

/** First full date in `text`, as a month. */
export function firstDate(text: string): Ym | undefined {
  return dateFromMatch(ANY_DATE_RE.exec(text));
}

export type StaleKind = "coming-year" | "event-or-sale-end" | "past-event-cue" | "past-time-element" | "countdown";

interface Claim {
  kind: StaleKind;
  text: string;
  date: string;
}

function fmt(d: Ym): string {
  return d.month === undefined ? String(d.year) : `${d.year}-${String(d.month + 1).padStart(2, "0")}`;
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 140 ? `${t.slice(0, 137)}...` : t;
}

/** Judge one sentence of visible copy. Exported for the unit tests. */
export function claimsInSentence(sentence: string, now: Ym): Claim[] {
  if (RETROSPECTIVE_RE.test(sentence)) return [];
  const out: Claim[] = [];

  const coming = COMING_IN_RE.exec(sentence);
  if (coming) {
    const date: Ym = { year: Number(coming[2]), month: coming[1] ? monthIndex(coming[1]) : undefined };
    if (hasPassed(date, now)) out.push({ kind: "coming-year", text: clip(sentence), date: fmt(date) });
  }
  const newFor = NEW_FOR_RE.exec(sentence);
  if (newFor && !coming) {
    const date: Ym = { year: Number(newFor[1]) };
    if (hasPassed(date, now)) out.push({ kind: "coming-year", text: clip(sentence), date: fmt(date) });
  }

  const end = END_DATE_RE.exec(sentence);
  if (end) {
    const date = firstDate(end[0]);
    if (date && hasPassed(date, now)) out.push({ kind: "event-or-sale-end", text: clip(sentence), date: fmt(date) });
  } else if (FUTURE_CUE_RE.test(sentence)) {
    const date = firstDate(sentence);
    if (date && hasPassed(date, now)) out.push({ kind: "past-event-cue", text: clip(sentence), date: fmt(date) });
  }
  return out;
}

// --- DOM -------------------------------------------------------------------

const ARCHIVE_URL_RE = /\/(?:archives?|archived|past-events?|past|previous|history|old)(?:\/|$)/i;
const ARCHIVE_BODY_CLASS_RE = /(?:^|\s)(?:archive|archived|post-type-archive|date-archive)(?:\s|$)/i;
const ARCHIVE_NOTICE_RE = /\bthis (?:page|post|article|event) (?:has been |is )?archived\b|\barchived (?:page|post|article|content)\b/i;

const BLOCK_ANCESTORS = new Set(["P", "LI", "DIV", "SECTION", "ARTICLE", "HEADER", "TD", "ASIDE", "BLOCKQUOTE"]);
const COUNTDOWN_ATTRS = [
  "data-countdown", "data-countdown-to", "data-countdown-date", "data-countdown-end", "data-end-date",
  "data-end", "data-target-date", "data-target", "data-deadline", "data-until", "data-date", "data-time", "data-timer",
];

function cleanText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const junk of clone.querySelectorAll("script,style,noscript,template,footer,nav")) junk.remove();
  // textContent glues adjacent blocks together ("...2023.New for 2024"); a newline ends the sentence.
  const owner = clone.ownerDocument;
  for (const block of clone.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,div,section,article,td,tr,br,blockquote,header,aside")) {
    block.appendChild(owner.createTextNode("\n"));
  }
  return clone.textContent || "";
}

function adjacentBlock(el: Element): Element | null {
  let cur: Element | null = el.parentElement;
  while (cur && !BLOCK_ANCESTORS.has(cur.tagName)) cur = cur.parentElement;
  return cur;
}

function scanTimeElements(doc: Document, now: Ym): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<Element>();
  for (const time of doc.querySelectorAll("time[datetime]") as Iterable<Element>) {
    const date = parseMachineDate(time.getAttribute("datetime"));
    if (!date || !hasPassed(date, now)) continue;
    const block = adjacentBlock(time);
    if (!block || seen.has(block)) continue;
    const text = block.textContent || "";
    if (text.length > MAX_ADJACENT_CHARS) continue;
    if (!FUTURE_CUE_RE.test(text) || RETROSPECTIVE_RE.test(text)) continue;
    seen.add(block);
    out.push({ kind: "past-time-element", text: clip(text), date: fmt(date) });
  }
  return out;
}

function scanCountdowns(doc: Document, now: Ym): Claim[] {
  const out: Claim[] = [];
  const selector = [
    ...COUNTDOWN_ATTRS.map((a) => `[${a}]`),
    '[class*="countdown" i]',
    '[id*="countdown" i]',
  ].join(",");
  const seen = new Set<Element>();
  for (const el of doc.querySelectorAll(selector) as Iterable<Element>) {
    if (seen.has(el)) continue;
    const named = (el.getAttribute("class") || "").toLowerCase().includes("countdown") ||
      (el.getAttribute("id") || "").toLowerCase().includes("countdown") ||
      el.hasAttribute("data-countdown") || el.hasAttribute("data-countdown-to") ||
      el.hasAttribute("data-countdown-date") || el.hasAttribute("data-countdown-end") ||
      el.hasAttribute("data-timer");
    // A bare `data-date` or `data-target` elsewhere on the page is not a countdown.
    if (!named) continue;
    const candidates = COUNTDOWN_ATTRS.map((a) => el.getAttribute(a));
    for (const t of el.querySelectorAll("time[datetime]") as Iterable<Element>) candidates.push(t.getAttribute("datetime"));
    candidates.push(el.getAttribute("datetime"));
    for (const raw of candidates) {
      const date = parseMachineDate(raw, false);
      if (date && hasPassed(date, now)) {
        seen.add(el);
        out.push({ kind: "countdown", text: clip(el.textContent || raw || ""), date: fmt(date) });
        break;
      }
    }
  }
  return out;
}

function isArchival(ctx: RuleContext): string | null {
  const doc = ctx.parsed.document!;
  let path = "";
  try {
    path = new URL(ctx.page.finalUrl ?? ctx.page.url).pathname;
  } catch {
    path = "";
  }
  if (ARCHIVE_URL_RE.test(path)) return "archive URL";
  if (ARCHIVE_BODY_CLASS_RE.test(doc.body?.getAttribute("class") || "")) return "archive page template";
  const title = `${doc.querySelector("title")?.textContent || ""} ${doc.querySelector("h1")?.textContent || ""}`;
  if (RETROSPECTIVE_PAGE_RE.test(title)) return "retrospective title";
  const lead = (doc.body?.textContent || "").slice(0, 3000);
  if (ARCHIVE_NOTICE_RE.test(lead)) return "archive notice";
  return null;
}

export const staleDatedCopyRule: Rule = {
  meta: {
    id: "content/stale-dated-copy",
    name: "Stale Dated Copy",
    description: "Finds copy that asserts a date which has already passed: 'Coming in 2024', expired sale or event dates, countdowns to a past time",
    solution:
      "Copy that promises something for a date that has passed tells a visitor, and an agent reading the page, that nobody maintains it. Rewrite the line in the past tense ('launched in March 2024'), update the date, or take the page down. For an event page, keep the page as a record: change the framing from 'register now' to 'watch the recording', or move it under an archive path or mark it noindex so it is read as history. Remove or retarget countdown widgets whose end time has passed, and drive sale and offer end dates from the same source that ends the sale. This rule reads what the copy says; content/freshness reads the date metadata.",
    category: "content",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 3,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CHECK, outcome: "clean", clears: [CHECK] },
      { name: CHECK, outcome: "skipped" },
    ],
    optionsSchema,
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const doc = ctx.parsed.document;
    if (!doc) {
      return {
        checks: [{ name: CHECK, status: "skipped", message: "No document available", skipReason: "unread-page" }],
      };
    }

    const noindex = noindexSource(ctx.parsed, ctx.page.headers);
    if (noindex) {
      return {
        checks: [{
          name: CHECK,
          status: "skipped",
          message: `Page is noindex (${noindex}); dated copy on it is not read as live`,
          skipReason: "noindex",
        }],
      };
    }
    const archival = isArchival(ctx);
    if (archival) {
      return {
        checks: [{
          name: CHECK,
          status: "skipped",
          message: `Page reads as archival (${archival}); past dates are expected`,
          skipReason: "archival-page",
        }],
      };
    }

    const now = resolveNow(opts.now);
    const claims: Claim[] = [];

    const sentences = cleanText(doc.body ?? doc.documentElement)
      .split(/(?<=[.!?])\s+|\n+/)
      .slice(0, MAX_SENTENCES);
    for (const sentence of sentences) {
      if (sentence.length < 8 || sentence.length > 600) continue;
      claims.push(...claimsInSentence(sentence, now));
    }
    claims.push(...scanTimeElements(doc, now), ...scanCountdowns(doc, now));

    // The same sentence can trip two patterns; report each claim once.
    const seen = new Set<string>();
    const distinct = claims.filter((c) => {
      const key = `${c.kind}|${c.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (distinct.length === 0) {
      return { checks: [{ name: CHECK, status: "pass", message: "No copy on this page asserts a date that has passed" }] };
    }

    const hasCountdown = distinct.some((c) => c.kind === "countdown");
    const shown = distinct.slice(0, MAX_EXAMPLES);
    return {
      checks: [{
        name: CHECK,
        // A dead countdown is visibly broken, and several expired claims on one page read as neglect.
        status: hasCountdown || distinct.length >= FAIL_CLAIM_COUNT ? "fail" : "warn",
        message: `${distinct.length} claim(s) on this page refer to a date that has passed: ${shown[0]!.date} in "${shown[0]!.text}"`,
        value: distinct.length,
        details: { now: fmt(now), claims: shown },
        items: shown.map((c, i) => ({ id: `${c.kind}-${i}`, label: c.kind, snippet: c.text })),
      }],
    };
  },
};
