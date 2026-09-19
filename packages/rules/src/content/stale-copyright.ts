// content/stale-copyright - Footer copyright year older than the current year

import { z } from "zod";
import type { Element } from "linkedom";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { ComponentOccurrenceCache, componentOccurrence } from "../shared/component-occurrence";

export const optionsSchema = z.object({
  // Injected so a test never depends on the wall clock: a rule that reads the
  // year itself passes in December and fails on 1 January. Defaults to the real
  // year only when a caller supplies nothing.
  current_year: z
    .number()
    .int()
    .min(1970)
    .max(9999)
    .optional()
    .describe("Year to compare the footer against; defaults to the current UTC year"),
});

/**
 * Where a site-chrome copyright legitimately lives. Restricting to these keeps the
 * rule off body copy — "© 2019 Acme" quoted inside an archived post, or a dated
 * legal notice, is correct as written and must not be reported as stale.
 */
const FOOTER_SELECTORS = [
  "footer",
  "[role=contentinfo]",
  ".footer",
  "#footer",
  ".site-footer",
  ".page-footer",
  "#colophon",
] as const;

/**
 * `©`, `(c)`, the literal `&copy;` entity, or the word itself, then a year or a
 * range. The gap allows "Copyright 2019 Acme Inc." and "© Acme 2019" style
 * padding, but is bounded so a year far away in unrelated text isn't captured.
 */
const COPYRIGHT_RE =
  /(?:©|\(c\)|&copy;|copyright)[^0-9]{0,30}?(\d{4})(?:\s*(?:[-–—]|to)\s*(\d{4}))?/gi;

/** Years a page could plausibly assert. Anything outside is a version or an id, not a year. */
const MIN_YEAR = 1990;
const MAX_YEAR = 2999;

/**
 * Latest copyright year asserted in the given text, or undefined when none is present.
 * A range is judged on its END year — "2019-2026" is current in 2026 — and a footer
 * carrying several notices is judged on the newest, since that is the one a visitor
 * reads as the site's freshness signal.
 */
export function latestCopyrightYear(text: string): number | undefined {
  let latest: number | undefined;
  for (const match of text.matchAll(COPYRIGHT_RE)) {
    // The range's end year wins when present; otherwise the single year.
    for (const raw of [match[2], match[1]]) {
      if (!raw) continue;
      const year = Number(raw);
      if (year < MIN_YEAR || year > MAX_YEAR) continue;
      if (latest === undefined || year > latest) latest = year;
      break;
    }
  }
  return latest;
}

/**
 * The elements that assert `year` and have no descendant asserting it — the
 * innermost notice, which is the thing a fix would edit.
 *
 * ONE bottom-up pass. The first cut computed `textContent` for every candidate
 * AND ran `querySelectorAll("*")` on each of them to test for a matching
 * descendant, which is quadratic twice over on a deep wrapper chain. Here each
 * element is visited once and "some descendant matched" is aggregated from the
 * children on the way back up.
 */
function innermostAssertingElements(
  footers: readonly Element[],
  year: number,
): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();

  /** Returns true when this subtree contains an element asserting `year`. */
  const visit = (element: Element): boolean => {
    let descendantAsserts = false;
    for (const child of element.children as unknown as Iterable<Element>) {
      // No short-circuit: every innermost asserter in every branch is wanted.
      if (visit(child)) descendantAsserts = true;
    }
    if (descendantAsserts) return true;
    if (latestCopyrightYear(element.textContent || "") !== year) return false;
    if (!seen.has(element)) {
      seen.add(element);
      out.push(element);
    }
    return true;
  };

  for (const footer of footers) visit(footer);
  return out;
}

export const staleCopyrightRule: Rule = {
  meta: {
    id: "content/stale-copyright",
    name: "Stale Copyright Year",
    description: "Checks the footer copyright year against the current year",
    solution:
      "A footer copyright year behind the current year is the most common 'this site is abandoned' signal a visitor sees, and it costs nothing to fix. Render the year dynamically from the server or build step rather than hardcoding it, or use a range whose end year updates ('2019-2026'). If the date is a deliberate legal assertion tied to a fixed publication, move it out of site chrome and into the page body so it reads as a statement about that content rather than about the site.",
    category: "content",
    scope: "page",
    verdictScope: "page",
    // Warning, never error: a stale year is a trust smell, not a defect — the page
    // works. Weight stays low so one templated footer repeated across every page
    // cannot dominate the content category score.
    severity: "warning",
    weight: 2,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const currentYear = opts.current_year ?? new Date().getUTCFullYear();
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];
    const occurrenceCache = new ComponentOccurrenceCache();
    const matchedPerSelector = FOOTER_SELECTORS.flatMap((selector) => [
      ...doc.querySelectorAll(selector),
    ]);
    // DETECTION: byte-identical to the pre-#2307 rule, which concatenates the
    // matches of every selector. One element matching both `footer` and
    // `.footer` therefore contributes its text TWICE, and that duplication can
    // decide the verdict: `<footer class="footer">2025 &copy;</footer>` only
    // matches because the seam between the two copies reads "&copy; 2025".
    // Deduping here silently dropped that finding. Evidence uses the deduped
    // element set below; detection must not.
    const footerText = matchedPerSelector
      .map((el) => el.textContent || "")
      .join(" ")
      .trim();
    const footers = [...new Set(matchedPerSelector)];

    if (!footerText) {
      checks.push({
        name: "footer-copyright-year",
        status: "skipped",
        message: "No footer or site-chrome region found on this page",
        skipReason: "no-footer",
      });
      return { checks };
    }

    const year = latestCopyrightYear(footerText);
    if (year === undefined) {
      checks.push({
        name: "footer-copyright-year",
        status: "skipped",
        message: "No copyright year in the footer",
        skipReason: "no-copyright-year",
      });
      return { checks };
    }

    checks.push(
      year < currentYear
        ? {
            name: "footer-copyright-year",
            status: "warn",
            message: `Footer copyright year is ${year}, behind the current year ${currentYear}`,
            value: year,
            expected: currentYear,
            // The legacy detection intentionally judges the newest copyright
            // assertion across all footer regions. Attach evidence only for
            // elements that assert THAT selected value, so older suppressed
            // notices never become invented findings.
            componentOccurrences: innermostAssertingElements(footers, year).map((element) =>
              componentOccurrence(
                {
                  pageUrl: ctx.page.url,
                  observedUrl: ctx.page.finalUrl ?? ctx.page.url,
                    rendered: ctx.page.rendered === true,
                  element,
                  kind: "stale-copyright",
                  values: { year, currentYear },
                },
                occurrenceCache,
              ),
            ),
          }
        : {
            name: "footer-copyright-year",
            status: "pass",
            // A year AHEAD of now is not a finding: sites legitimately roll over early.
            message: `Footer copyright year is ${year}`,
            value: year,
          },
    );
    return { checks };
  },
};
