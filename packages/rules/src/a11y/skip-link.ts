// a11y/skip-link - Skip-to-content link for keyboard navigation
// Based on WCAG 2.4.1 Bypass Blocks (Level A)

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

// How far into the body a heading still counts as "early" — enough for a nav,
// not enough for real content.
const EARLY_HEADING_LIMIT = 2000;

export const skipLinkRule: Rule = {
  meta: {
    id: "a11y/skip-link",
    name: "Skip Link",
    description: "Checks for bypass mechanisms for keyboard navigation",
    solution:
      "Skip links allow keyboard users to bypass repetitive navigation and jump directly to main content. Add a hidden link at the very beginning of your page: <a href='#main-content' class='skip-link'>Skip to main content</a>. Style it to become visible on focus. Ensure the target (#main-content) has tabindex='-1' if it's not naturally focusable. Alternative: use landmark roles like <main> which screen readers can navigate to directly.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // WCAG 2.4.1 allows multiple bypass mechanisms - check all
    const bypassMethods: string[] = [];

    // 1. Check for skip link patterns
    const skipLinks = doc.querySelectorAll(
      'a[href^="#main"], a[href^="#content"], a[href="#skip"], a.skip-link, a.skip-to-content, a.skip-nav'
    );
    if (skipLinks.length > 0) {
      bypassMethods.push("skip link");
    }

    // 2. Check for links with skip-related text
    if (bypassMethods.length === 0) {
      const allLinks = doc.querySelectorAll("a[href^='#']");
      for (const link of allLinks) {
        const text = link.textContent?.toLowerCase() || "";
        if (
          text.includes("skip") ||
          text.includes("jump to content") ||
          text.includes("go to main")
        ) {
          bypassMethods.push("skip link (text match)");
          break;
        }
      }
    }

    // 3. Check for <main> landmark (screen readers can navigate directly)
    const mainLandmark = doc.querySelector("main, [role='main']");
    if (mainLandmark) {
      bypassMethods.push("<main> landmark");
    }

    // 4. Check for heading within first portion of page (allows heading navigation)
    // Look for h1 within first ~500 chars of body
    const body = doc.querySelector("body");
    if (body) {
      const headings = body.querySelectorAll("h1, h2");
      // `body.innerHTML` serialises the whole page, so building it INSIDE the
      // loop cost one full serialisation per heading — 12 ms on a 1 MB page with
      // eleven of them (#1864). It does not change between iterations.
      const html = headings.length > 0 ? body.innerHTML || "" : "";
      for (const h of headings) {
        // Check if heading appears early in the document
        const hOuterHTML = (h as Element).outerHTML || "";
        // Only the first 2000 characters can satisfy the test below, so searching
        // the whole megabyte for a heading that is not there is wasted. A match
        // starting before 2000 lies entirely inside this prefix, and any match
        // found only outside it is at or past 2000 either way, so the answer to
        // `position >= 0 && position < 2000` is unchanged.
        const position = html
          .slice(0, EARLY_HEADING_LIMIT + hOuterHTML.length)
          .indexOf(hOuterHTML);
        // Consider "early" if within first 2000 chars (allows for nav, but not much content)
        if (position >= 0 && position < EARLY_HEADING_LIMIT) {
          bypassMethods.push("early heading");
          break;
        }
      }
    }

    // 5. Check for navigation landmark (helps segment content)
    const navLandmark = doc.querySelector("nav, [role='navigation']");
    if (navLandmark) {
      bypassMethods.push("<nav> landmark");
    }

    // Evaluate results
    // Pass if: skip link exists OR (main landmark + nav landmark) OR (main + early heading)
    const hasSkipLink =
      bypassMethods.includes("skip link") ||
      bypassMethods.includes("skip link (text match)");
    const hasMainLandmark = bypassMethods.includes("<main> landmark");
    const hasNavLandmark = bypassMethods.includes("<nav> landmark");
    const hasEarlyHeading = bypassMethods.includes("early heading");

    // Best practice: skip link provides most direct bypass
    // Acceptable: main landmark + (nav or heading) per WCAG techniques
    const hasAdequateBypass =
      hasSkipLink || (hasMainLandmark && (hasNavLandmark || hasEarlyHeading));

    if (hasSkipLink) {
      checks.push({
        name: "skip-link",
        status: "pass",
        message: "Skip link found",
        details: { methods: bypassMethods },
      });
    } else if (hasAdequateBypass) {
      checks.push({
        name: "skip-link",
        status: "pass",
        message: "Bypass mechanism available via landmarks",
        details: { methods: bypassMethods },
      });
    } else {
      // Missing bypass - warn for all pages
      checks.push({
        name: "skip-link",
        status: "warn",
        message: "No bypass mechanism for repetitive content",
        details: {
          found: bypassMethods.length > 0 ? bypassMethods : ["none"],
          suggestion:
            "Add skip link or ensure <main> landmark with <nav> landmark",
        },
      });
    }

    return { checks };
  },
};
