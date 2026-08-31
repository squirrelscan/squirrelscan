// content/date-agreement - visible byline vs schema vs URL/title vs Last-Modified (#108)
//
// Both existing date rules are PRESENCE checks: content/freshness passes as soon
// as any one signal exists, and eeat/content-dates reports the coverage
// percentage of datePublished / dateModified. A page can therefore carry five
// date signals that contradict each other and pass both — which is what
// squirrelscan.com's own site did, in two opposite directions at once:
//
//   - /blog/* rendered a visible 2025 date while the only JSON-LD on the page
//     was the sitewide SoftwareApplication (datePublished 2026, a release date),
//   - /learn/* emitted Article JSON-LD with dates and showed the reader nothing.
//
// The defect this rule looks for is the DISAGREEMENT, so both halves of that
// have to be reachable without inventing findings. Two false-positive traps cost
// an internal audit pass two full re-runs (14 findings, 1 real) and are the
// reason for most of the guards below:
//
//   1. A date belongs to the node that describes the DOCUMENT. A sitewide
//      SoftwareApplication / Product / Organization node carries its own
//      datePublished (when the software shipped, not when the post was written).
//      Taking the first datePublished in the document attributed one placeholder
//      release date to every blog post on the site. Only document-describing
//      @types feed a disagreement warning; a date from any other node is
//      reported with its source noted and can never raise one (see
//      `SCHEMA_SOURCE_CHECK`).
//   2. A byline is a POSITION, not a date-shaped string. Scanning body text read
//      running prose ("INP replaced FID on March 12, 2024" on a 2026 page) and
//      outbound citations (`<a>March 12, 2024</a>` pointing at web.dev) as
//      publication dates. A candidate must sit near the top of main content AND
//      look like byline markup, and an anchor's own text never counts.
//
// The reader-facing date is read from the DOM here rather than from the parser's
// `visibleDatePublished`, which prefers a `<time datetime>` attribute: markup can
// carry a machine-readable date with nothing rendered inside it, and a date the
// reader cannot see is exactly the /learn/* defect.
//
// Last-Modified is extracted and reported alongside the others but never raises a
// warning on its own — origins stamp it at deploy time far more often than at
// content-change time, so a disagreement there is not evidence of a defect.

import { z } from "zod";

import type { Document, Element } from "linkedom";

import { flattenJsonLdNodes, getPathname } from "@squirrelscan/utils";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import {
  documentTypes,
  isArticleType,
  schemaDateString,
  typeNames,
} from "../shared/schema-document";

const BYLINE_CHECK = "byline-vs-schema-date";
const VISIBLE_MISSING_CHECK = "visible-date-missing";
const URL_TITLE_CHECK = "url-title-year";
const SCHEMA_SOURCE_CHECK = "schema-date-source";

const MS_PER_DAY = 86_400_000;

/** Years a page could plausibly assert; outside this a 4-digit run is an id. */
const MIN_YEAR = 1990;
const MAX_YEAR = 2999;

/** Longest line that can still read as a byline rather than as body copy. */
const MAX_BYLINE_LEN = 120;
/** How far into main content the byline zone extends (elements / leaf text). */
const MAX_ZONE_ELEMENTS = 60;
const MAX_ZONE_CHARS = 600;
/** Distinct visible dates considered before the page is judged (see below). */
const MAX_VISIBLE_DATES = 4;

export const optionsSchema = z.object({
  tolerance_days: z
    .number()
    .default(1)
    .describe(
      "Days the visible byline date may differ from the schema document date before warning",
    ),
});

// ============================================================================
// Date parsing
// ============================================================================

const MONTH_NAMES =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/;
const MONTH_FIRST_RE = new RegExp(
  `\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
  "i",
);
const DAY_FIRST_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?,?\\s+(\\d{4})\\b`,
  "i",
);

/** A date signal, normalized to UTC midnight so two forms compare cleanly. */
interface DateSignal {
  /** The value exactly as the page states it — quoted back in findings. */
  value: string;
  /** UTC midnight of the calendar day the value names. */
  ms: number;
  /** Where the value came from — reported so a fix targets the right markup. */
  source: string;
}

function utcDay(year: number, month: number, day: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  return Date.UTC(year, month, day);
}

/**
 * The first calendar date named in `text`, as UTC midnight. Written forms are
 * built from their own components rather than handed to `Date.parse`, which
 * reads "March 12, 2024" as LOCAL midnight — enough to shift the calendar day
 * and turn an exact match into a one-day disagreement in half the world's
 * timezones.
 */
export function matchDate(text: string): { text: string; ms: number } | null {
  const iso = ISO_DATE_RE.exec(text);
  if (iso) {
    const ms = utcDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (ms !== null) return { text: iso[0], ms };
  }

  const monthFirst = MONTH_FIRST_RE.exec(text);
  if (monthFirst) {
    const month = MONTH_INDEX[monthFirst[1]!.slice(0, 3).toLowerCase()];
    const ms =
      month === undefined ? null : utcDay(Number(monthFirst[3]), month, Number(monthFirst[2]));
    if (ms !== null) return { text: monthFirst[0], ms };
  }

  const dayFirst = DAY_FIRST_RE.exec(text);
  if (dayFirst) {
    const month = MONTH_INDEX[dayFirst[2]!.slice(0, 3).toLowerCase()];
    const ms = month === undefined ? null : utcDay(Number(dayFirst[3]), month, Number(dayFirst[1]));
    if (ms !== null) return { text: dayFirst[0], ms };
  }

  return null;
}

/**
 * A machine-readable date value (schema property, `datetime` attribute,
 * `Last-Modified` header). The written forms above are tried first so the
 * timezone-safe path wins; `Date.parse` is the fallback for RFC-1123 and other
 * stamps, read back in UTC.
 */
function parseDateValue(raw: string | null | undefined, source: string): DateSignal | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  const matched = matchDate(value);
  if (matched) return { value, ms: matched.ms, source };

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const date = new Date(parsed);
  const ms = utcDay(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return ms === null ? null : { value, ms, source };
}

function deltaDays(a: number, b: number): number {
  return Math.round(Math.abs(a - b) / MS_PER_DAY);
}

// ============================================================================
// Schema dates
// ============================================================================

/** Dates read off the JSON-LD, split by whether their node describes the page. */
interface SchemaDates {
  /** Date(s) from a document-describing node — the only ones that can warn. */
  document: { type: string; published: DateSignal | null; modified: DateSignal | null } | null;
  /** A date from some other node (sitewide app/product/org), source noted. */
  fallback: { type: string; field: string; value: string } | null;
}

/**
 * Split every JSON-LD date on the page by the kind of node carrying it. An
 * Article-family node wins over a generic page node — a Yoast-style `@graph`
 * emits a dated `WebPage` ahead of the `BlogPosting`, and the post's own node is
 * the one that speaks for the content. A date on any node that describes neither
 * is kept only so the rule can NAME it (a SoftwareApplication release date looks
 * exactly like a publish date until you ask what it is attached to).
 */
function collectSchemaDates(raw: string | null | undefined): SchemaDates {
  const result: SchemaDates = { document: null, fallback: null };
  if (!raw) return result;

  let articleNode: SchemaDates["document"] = null;
  let pageNode: SchemaDates["document"] = null;

  for (const node of flattenJsonLdNodes(raw)) {
    const published = schemaDateString(node["datePublished"]);
    const modified = schemaDateString(node["dateModified"]);
    if (!published && !modified) continue;

    const types = typeNames(node);
    // First document type wins, as it always has here.
    const docType = documentTypes(node)[0] ?? null;

    if (docType) {
      const isArticle = isArticleType(docType);
      if (isArticle ? articleNode !== null : pageNode !== null) continue;

      const publishedSignal = parseDateValue(published, "schema:datePublished");
      const modifiedSignal = parseDateValue(modified, "schema:dateModified");
      if (!publishedSignal && !modifiedSignal) continue;

      const entry = { type: docType, published: publishedSignal, modified: modifiedSignal };
      if (isArticle) articleNode = entry;
      else pageNode = entry;
      continue;
    }

    if (!result.fallback) {
      const value = published ?? modified;
      if (value) {
        result.fallback = {
          type: types[0] ?? "untyped node",
          field: published ? "datePublished" : "dateModified",
          value,
        };
      }
    }
  }

  result.document = articleNode ?? pageNode;
  return result;
}

/** Raw JSON-LD for the page: the parser's, else the document's own scripts. */
function rawJsonLd(ctx: RuleContext, doc: Document): string | null {
  const parsed = ctx.parsed.schema?.raw;
  if (parsed) return parsed;
  const blocks = [...doc.querySelectorAll('script[type="application/ld+json"]')]
    .map((script) => (script.textContent ?? "").trim())
    .filter(Boolean);
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

// ============================================================================
// Visible byline date
// ============================================================================

/** Class/id tokens that mark byline / entry-meta markup. */
const BYLINE_CONTEXT_RE =
  /\b(byline|by-line|dateline|entry-meta|entry-date|post-meta|post-date|article-meta|article-date|published|pubdate|posted-on|publish-date|meta-date|timestamp)\b/i;

/** Words a byline line legitimately opens with. */
const BYLINE_PREFIX_RE =
  /^(published|posted|updated|last\s+updated|last\s+modified|last\s+reviewed|written|reviewed|revised|date)\b/i;

/** Decorations that survive removing the date from a byline line. */
const BYLINE_NOISE_RE =
  /\b(\d+\s*min(?:ute)?s?\s*read|read\s*time|published|posted|updated|last\s+modified|on|in|at)\b/gi;

/** What is left of a byline once the date and its decorations are gone. */
const BYLINE_RESIDUE_RE = /^[\s·|•\-–—,.:;()]*(?:by\s+[^,|·•]{2,60}?)?[\s·|•\-–—,.:;()]*$/i;

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * `el`'s text with every anchor's text removed. A date-shaped string that only
 * exists inside a link is a citation ("as measured on <a>March 12, 2024</a>"),
 * not this page's publication date.
 */
function textWithoutAnchors(el: Element): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      text += node.textContent ?? "";
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as unknown as Element;
    if (child.tagName?.toLowerCase() === "a") continue;
    text += textWithoutAnchors(child);
  }
  return text;
}

/** The region a byline can live in: the article body, else main, else the page. */
function contentRoot(doc: Document): Element | null {
  return (
    (doc.querySelector("article") as Element | null) ??
    (doc.querySelector("main") as Element | null) ??
    (doc.querySelector("[role='main']") as Element | null) ??
    (doc.body as Element | null)
  );
}

/** Site chrome and non-text subtrees: never a byline, and never zone budget. */
const SKIP_TAGS = new Set([
  "nav",
  "aside",
  "footer",
  "form",
  "button",
  "select",
  "script",
  "style",
  "svg",
  "noscript",
  "template",
]);
const SKIP_ROLES = new Set(["navigation", "banner", "contentinfo", "search"]);

function isChrome(el: Element): boolean {
  const tag = el.tagName?.toLowerCase() ?? "";
  if (SKIP_TAGS.has(tag)) return true;
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  return role !== "" && SKIP_ROLES.has(role);
}

/**
 * Elements in the top zone of main content, in document order. The zone ends
 * once the page has produced `MAX_ZONE_CHARS` of rendered leaf text or
 * `MAX_ZONE_ELEMENTS` elements — a byline sits above the article body, so
 * anything past that is prose, and prose is where the false positives live.
 *
 * Navigation and other chrome is skipped whole rather than counted: when a page
 * has no `<article>`/`<main>` the walk starts at `<body>`, and a long menu would
 * otherwise spend the entire zone before reaching the byline.
 */
function topZoneElements(root: Element): Element[] {
  const zone: Element[] = [];
  let chars = 0;

  const visit = (el: Element): void => {
    for (const child of [...el.children] as Element[]) {
      if (zone.length >= MAX_ZONE_ELEMENTS || chars >= MAX_ZONE_CHARS) return;
      if (isChrome(child)) continue;
      zone.push(child);
      if (child.children.length === 0) {
        // Only leaves add to the budget, so a wrapper's text is not counted
        // once per level of nesting.
        chars += cleanText(child.textContent).length;
      } else {
        visit(child);
      }
    }
  };

  visit(root);
  return zone;
}

function hasBylineContext(el: Element): boolean {
  const marker = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
  return BYLINE_CONTEXT_RE.test(marker);
}

/** True when the line says nothing beyond the date and byline decorations. */
function isBylineLine(line: string, dateText: string): boolean {
  if (BYLINE_PREFIX_RE.test(line)) return true;
  const residue = line.replace(dateText, " ").replace(BYLINE_NOISE_RE, " ");
  return BYLINE_RESIDUE_RE.test(cleanText(residue));
}

/**
 * The dates the reader actually sees, in document order (first = the one a
 * finding quotes). A candidate must sit in the top zone of main content and be
 * byline-shaped: a `<time>` element, markup that names itself a byline, or a
 * short line that says nothing but the date (plus "Published"/"by Author"-style
 * decoration). Anchor text never qualifies unless it is wrapped in `<time>` — a
 * permalinked post date is markup, an outbound citation is prose.
 *
 * Several are collected rather than just the first because pages legitimately
 * show two ("Published … · Updated …"), and a listing page shows one per item;
 * a disagreement is only real when NONE of them matches the schema.
 */
function findVisibleDates(doc: Document): DateSignal[] {
  const root = contentRoot(doc);
  if (!root) return [];

  const found: DateSignal[] = [];
  const seen = new Set<number>();
  const add = (signal: DateSignal): void => {
    if (seen.has(signal.ms)) return;
    seen.add(signal.ms);
    found.push(signal);
  };

  for (const el of topZoneElements(root)) {
    if (found.length >= MAX_VISIBLE_DATES) break;
    const tag = el.tagName?.toLowerCase();
    if (tag === "a") continue;

    if (tag === "time") {
      // An empty `<time datetime>` renders nothing: machine-readable, invisible.
      const shown = cleanText(el.textContent);
      if (!shown) continue;
      const signal =
        parseDateValue(el.getAttribute("datetime"), "visible:time") ??
        parseDateValue(shown, "visible:time");
      if (signal) add({ ...signal, value: shown });
      continue;
    }

    // Anchors are stripped so a citation's own text can never be the byline;
    // a `<time>` nested in a permalink is reached by the branch above.
    const line = cleanText(textWithoutAnchors(el));
    if (!line || line.length > MAX_BYLINE_LEN) continue;

    const matched = matchDate(line);
    if (!matched) continue;
    if (!hasBylineContext(el) && !isBylineLine(line, matched.text)) continue;

    add({ value: matched.text, ms: matched.ms, source: "visible:byline" });
  }

  return found;
}

/**
 * True when main content prints a date-shaped string ANYWHERE — byline-shaped or
 * not, citation or prose. "This page shows the reader no date" is only worth
 * saying when it is literally true: a date this rule declined to read as a
 * byline is still a date on the reader's screen, and accusing a page that shows
 * one is exactly the kind of finding that gets a rule switched off.
 */
function showsAnyDate(doc: Document): boolean {
  const root = contentRoot(doc);
  return root !== null && matchDate(cleanText(root.textContent)) !== null;
}

// ============================================================================
// URL / title year
// ============================================================================

const YEAR_RE = /(?<!\d)(19|20)\d{2}(?!\d)/;

function yearIn(text: string): number | null {
  const match = YEAR_RE.exec(text);
  if (!match) return null;
  const year = Number(match[0]);
  return year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
}

// ============================================================================
// Rule
// ============================================================================

export const dateAgreementRule: Rule = {
  meta: {
    id: "content/date-agreement",
    name: "Date Agreement",
    description: "Checks the visible date, schema dates and URL/title year agree",
    solution:
      "A page states its date more than once - the visible byline, schema.org datePublished/dateModified, a year in the URL or title, the sitemap lastmod, the Last-Modified header - and readers and crawlers do not all read the same one. When they disagree, at least one is wrong, and presence checks cannot tell you which: they pass as soon as any single signal exists. Drive every date on the page from ONE content timestamp. If the visible byline disagrees with the schema, fix whichever renders from the wrong field (a common cause is the template printing a build-time or hardcoded value while the schema prints the CMS field). If the schema carries dates the reader never sees, render the date in the article header - Google asks for a visible date on dated content, and a date only crawlers can see is not one. Check the schema date is attached to the node describing the page (Article/BlogPosting/WebPage): a datePublished on a sitewide SoftwareApplication or Organization node is that entity's own date and says nothing about this page.",
    category: "content",
    scope: "page",
    severity: "warning",
    weight: 4,
    optionsSchema,
    // A soft-404 serves the site template for a URL that does not exist; its
    // dates describe nothing, so arguing about them is noise.
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const schema = collectSchemaDates(rawJsonLd(ctx, doc));
    const visibleDates = findVisibleDates(doc);
    const visible = visibleDates[0] ?? null;
    const header = parseDateValue(ctx.page.headers["last-modified"], "header:last-modified");

    // No date attached to a node that describes this page: there is nothing to
    // hold the other signals against. Name the node the date DID come from when
    // the page also shows a date, so "schema says 2026, the page says 2025" is
    // traceable to the sitewide node it really belongs to — but never treat that
    // as a disagreement, because it is not one.
    if (!schema.document) {
      if (schema.fallback && visible) {
        return {
          checks: [
            {
              name: SCHEMA_SOURCE_CHECK,
              status: "info",
              message:
                `The only schema date on this page is ${schema.fallback.field} ` +
                `${schema.fallback.value} on a ${schema.fallback.type} node, which describes that ` +
                `entity rather than this page — the visible date ${visible.value} has nothing to ` +
                "be checked against. Add datePublished/dateModified to an Article or WebPage node.",
              value: visible.value,
              details: {
                visibleDate: visible.value,
                visibleDateSource: visible.source,
                schemaDate: schema.fallback.value,
                schemaDateField: schema.fallback.field,
                schemaDateNodeType: schema.fallback.type,
                lastModified: header?.value ?? null,
                reason: "no-document-schema-date",
              },
            },
          ],
        };
      }
      return { checks: [] };
    }

    const docNode = schema.document;
    const schemaDates = [docNode.published, docNode.modified].filter(
      (d): d is DateSignal => d !== null,
    );
    const checks: CheckResult[] = [];
    const baseDetails = {
      schemaNodeType: docNode.type,
      schemaDatePublished: docNode.published?.value ?? null,
      schemaDateModified: docNode.modified?.value ?? null,
      lastModified: header?.value ?? null,
    };

    // A page-level node (WebPage, CollectionPage, ...) alongside SEVERAL visible
    // dates is an index or archive: those dates belong to the entries it lists,
    // not to the page, so there is nothing here to disagree with.
    const isListing = visibleDates.length > 1 && !isArticleType(docNode.type);

    if (visible && !isListing) {
      // Every visible date is measured against the CLOSEST schema date, and the
      // best pairing decides. A page showing "Published January … Updated March"
      // is telling the truth about both, and a listing page shows one date per
      // item — only when NOTHING on the page matches the schema is there a real
      // disagreement to report.
      const best = visibleDates
        .map((shown) => {
          const nearest = schemaDates.reduce((closest, candidate) =>
            deltaDays(shown.ms, candidate.ms) < deltaDays(shown.ms, closest.ms) ? candidate : closest,
          );
          return { shown, nearest, gap: deltaDays(shown.ms, nearest.ms) };
        })
        .reduce((closest, candidate) => (candidate.gap < closest.gap ? candidate : closest));

      checks.push(
        best.gap > opts.tolerance_days
          ? {
              name: BYLINE_CHECK,
              status: "warn",
              message:
                `The visible date reads ${best.shown.value} but the ${docNode.type} schema says ` +
                `${best.nearest.source.replace("schema:", "")} ${best.nearest.value} — ` +
                `${best.gap} day(s) apart, so readers and crawlers are being told different things`,
              value: best.shown.value,
              expected: best.nearest.value,
              details: { ...baseDetails, visibleDate: best.shown.value, gapDays: best.gap },
            }
          : {
              name: BYLINE_CHECK,
              status: "pass",
              message: `Visible date ${best.shown.value} agrees with the ${docNode.type} schema dates`,
              value: best.shown.value,
              details: { ...baseDetails, visibleDate: best.shown.value, gapDays: best.gap },
            },
      );
    } else if (!visible && isArticleType(docNode.type) && !showsAnyDate(doc)) {
      // Dates in the markup and none on the page: the /learn/* half of #108.
      // `showsAnyDate` keeps this off a page that prints a date this rule
      // declined to read as a byline — a citation, or a format it cannot parse.
      const stated = docNode.published ?? docNode.modified;
      if (stated) {
        checks.push({
          name: VISIBLE_MISSING_CHECK,
          status: "warn",
          message:
            `This ${docNode.type} states ${stated.source.replace("schema:", "")} ` +
            `${stated.value} in its schema but shows the reader no date at all`,
          expected: stated.value,
          details: { ...baseDetails, reason: "no-visible-date" },
        });
      }
    }

    // A year in the URL or the title is a date claim too, and it is the one
    // nobody updates when a post is re-dated.
    const pathYear = yearIn(getPathname(ctx.page.url) || ctx.page.url);
    const titleYear = pathYear === null ? yearIn(ctx.parsed.meta?.title ?? "") : null;
    const claimedYear = pathYear ?? titleYear;
    if (claimedYear !== null) {
      const where = pathYear !== null ? "URL" : "title";
      const schemaYears = schemaDates.map((d) => new Date(d.ms).getUTCFullYear());
      checks.push(
        schemaYears.includes(claimedYear)
          ? {
              name: URL_TITLE_CHECK,
              status: "pass",
              message: `The ${where} year ${claimedYear} matches the ${docNode.type} schema dates`,
              value: claimedYear,
              details: { ...baseDetails, claimedYear, claimedYearSource: where },
            }
          : {
              name: URL_TITLE_CHECK,
              status: "warn",
              message:
                `The ${where} says ${claimedYear} but the ${docNode.type} schema dates are from ` +
                `${[...new Set(schemaYears)].join("/")}`,
              value: claimedYear,
              expected: schemaYears[0] ?? null,
              details: { ...baseDetails, claimedYear, claimedYearSource: where },
            },
      );
    }

    return { checks };
  },
};
