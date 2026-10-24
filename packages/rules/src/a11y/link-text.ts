// a11y/link-text - Check for descriptive link text
// Based on WCAG 2.4.4 Link Purpose (In Context) (Level A)

import type { LinkSection } from "@squirrelscan/core-contracts";
import {
  coerceSchemelessUrl,
  hasNonCrawlableUrlScheme,
  hasUnsafeUrlScheme,
  isCloudflareEmailProtectionUrl,
} from "@squirrelscan/utils";

import { pageRegionsField } from "../links/link-section-label";
import {
  createStaticVisibility,
  SCRIPT_STATE_LABEL,
  sortUnnamedControls,
  unconfirmedRow,
} from "../shared/static-hidden";
import { isConventionalLinkLabel } from "../shared/conventional-link-labels";
import { isGenericInPageLanguage } from "../shared/generic-link-phrases";
import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { ComponentOccurrenceCache, componentOccurrence } from "../shared/component-occurrence";

// Generic link text that doesn't describe the destination
// Expanded list based on Lighthouse and common patterns. Conventional account and
// site-utility labels ("sign in", "sign up", "log in", "register", "terms", "privacy")
// name their destination and are NOT here: see shared/conventional-link-labels.ts (pub#839).
export const GENERIC_LINK_TEXT = [
  // Original
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "link",
  "click",
  "this",
  "go",
  "see more",
  "continue",
  "details",
  // Action words without context
  "view",
  "download",
  "visit",
  "open",
  "access",
  "get",
  "start",
  "begin",
  // Calls to action that name nothing. Account actions (sign in, sign up, log in,
  // register) are conventional labels, not generic text, and are exempt instead (pub#839).
  "subscribe",
  "join",
  // Navigation
  "next",
  "previous",
  "back",
  "forward",
  "skip",
  // Common CTA
  "submit",
  "send",
  "buy",
  "shop",
  "order",
  "buy now",
  "shop now",
  "order now",
  // Info seeking
  "info",
  "information",
  "find out",
  "find out more",
  "see details",
  "view details",
  "full details",
  // Misc
  "website",
  "page",
  "site",
  "check it out",
  "discover",
  "explore",
];

/** A link label as the generic-text list reads it: lowercase, without sentence punctuation. */
function normalizeLinkLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[.,!?;:'"]+/g, "")
    .trim();
}

/**
 * True when the label is generic text that does not describe its destination. A
 * conventional account or site-utility label is never generic, and that check runs first,
 * so it wins over the list whatever the list holds (pub#839).
 */
export function isGenericLinkText(
  label: string,
  genericPhrases: readonly string[] = GENERIC_LINK_TEXT,
): boolean {
  if (isConventionalLinkLabel(label)) return false;
  return genericPhrases.includes(normalizeLinkLabel(label));
}

/**
 * Get accessible name from an element
 * Follows accessible name computation (simplified)
 */
function getAccessibleName(link: Element, doc: Document): string | null {
  // 1. aria-labelledby (references other elements)
  const labelledBy = link.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    const texts: string[] = [];
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (el) {
        texts.push(el.textContent?.trim() || "");
      }
    }
    if (texts.some((t) => t.length > 0)) {
      return texts.join(" ");
    }
  }

  // 2. aria-label
  const ariaLabel = link.getAttribute("aria-label");
  if (ariaLabel?.trim()) {
    return ariaLabel.trim();
  }

  // 3. title attribute (fallback)
  const title = link.getAttribute("title");
  if (title?.trim()) {
    return title.trim();
  }

  return null;
}

/**
 * Check if link has accessible content (text, image with alt, SVG with accessible name)
 */
function hasAccessibleContent(link: Element): {
  hasContent: boolean;
  contentType: string;
} {
  // Check for text content
  const text = link.textContent?.trim() || "";
  if (text) {
    return { hasContent: true, contentType: "text" };
  }

  // Check for image with alt
  const imgWithAlt = link.querySelector("img[alt]:not([alt=''])");
  if (imgWithAlt) {
    return { hasContent: true, contentType: "image" };
  }

  // Check for SVG with accessible name
  const svg = link.querySelector("svg");
  if (svg) {
    // SVG is accessible if it has title, aria-label, or aria-labelledby
    const svgTitle = svg.querySelector("title");
    const svgAriaLabel = svg.getAttribute("aria-label");
    const svgAriaLabelledby = svg.getAttribute("aria-labelledby");
    if (svgTitle?.textContent?.trim() || svgAriaLabel?.trim() || svgAriaLabelledby) {
      return { hasContent: true, contentType: "svg" };
    }
    // SVG without accessible name - this is a problem
    return { hasContent: false, contentType: "svg-no-name" };
  }

  // Check for icon font (common patterns)
  const iconElement = link.querySelector(
    'i[class*="icon"], span[class*="icon"], i[class*="fa-"], span[class*="fa-"]',
  );
  if (iconElement) {
    return { hasContent: false, contentType: "icon-font" };
  }

  // Check for role="img" with accessible name
  const roleImg = link.querySelector('[role="img"]');
  if (roleImg) {
    const imgAriaLabel = roleImg.getAttribute("aria-label");
    if (imgAriaLabel?.trim()) {
      return { hasContent: true, contentType: "role-img" };
    }
    return { hasContent: false, contentType: "role-img-no-name" };
  }

  return { hasContent: false, contentType: "empty" };
}

function noteSection(
  byText: Map<string, Set<LinkSection | undefined>>,
  text: string,
  section: LinkSection | undefined,
): void {
  let sections = byText.get(text);
  if (!sections) byText.set(text, (sections = new Set()));
  sections.add(section);
}

/**
 * Where each anchor sits, from the parse's placement of the page's links (pub#846): the markup
 * landmarks and the page classifier's answer, as `parsed.links[].section` stores them. The parse
 * keeps one entry per crawlable anchor in document order, keyed here by resolved URL and text, so
 * reading every anchor in document order hands each repeat of a link its own entry. An anchor the
 * parse did not keep, or a parse without sections, has no section.
 */
function linkPlacements(ctx: RuleContext): (anchor: Element, href: string) => LinkSection | undefined {
  const placed = ctx.parsed.links ?? [];
  if (!placed.some((l) => l.section && l.section !== "unknown")) return () => undefined;
  const queues = new Map<string, Array<LinkSection | undefined>>();
  for (const l of placed) {
    const key = `${l.url}\u0000${l.text}`;
    const queue = queues.get(key);
    if (queue) queue.push(l.section);
    else queues.set(key, [l.section]);
  }
  return (anchor, href) => {
    // The anchors the engine's link extractor leaves out have no entry: reading one would take
    // the entry of a kept anchor that resolves to the same URL and text.
    if (!href || href.trim() === "#" || hasNonCrawlableUrlScheme(href)) return undefined;
    let url: string;
    try {
      url = new URL(coerceSchemelessUrl(href.trim()), ctx.page.url).toString();
    } catch {
      return undefined;
    }
    // Cloudflare's email-protection link is a contact, not a page: never in `parsed.links` (pub#811).
    if (isCloudflareEmailProtectionUrl(url)) return undefined;
    const section = queues.get(`${url}\u0000${anchor.textContent?.trim() ?? ""}`)?.shift();
    return section === "unknown" ? undefined : section;
  };
}

export const linkTextRule: Rule = {
  meta: {
    id: "a11y/link-text",
    name: "Link Text",
    description: "Checks for descriptive link text",
    solution:
      "Link text should describe the destination, not generic phrases like 'click here'. Screen reader users often navigate by links, hearing them out of context. Good: 'View our pricing plans'. Bad: 'Click here'. For icon-only links, add aria-label: <a href='/search' aria-label='Search'><svg>...</svg></a>. Empty links are especially problematic - add text or aria-label. A link hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs text before it is shown. A <style> rule squirrel can decide counts too. An empty link carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. One a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so a link hidden only by one is still reported.",
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

    const links = doc.querySelectorAll("a[href]");
    const genericLinks: string[] = [];
    // pub#993: a link out of the accessibility tree is skipped, and an empty
    // one a style may hide is unconfirmed, like button-name.
    const visibility = createStaticVisibility({ ariaHidden: true });
    const empty = sortUnnamedControls<{ id: string; label: string }>(visibility);
    const emptyLinks = empty.failures;

    const isHidden = (el: Element): boolean => visibility.visibility(el).state === "hidden";
    // pub#840: the page language adds its own generic phrases; English always applies.
    const lang = doc.documentElement?.getAttribute("lang");
    const isGeneric = (raw: string): boolean =>
      isGenericLinkText(raw) || isGenericInPageLanguage(raw, lang);

    // pub#846: the section each flagged link sits in, per generic text.
    const genericSections = new Map<string, Set<LinkSection | undefined>>();
    const sectionOf = linkPlacements(ctx);
    const genericOccurrences = [];
    const occurrenceCache = new ComponentOccurrenceCache();
    // What an empty link carries beyond its row: its section, and its component
    // evidence, built only if the link ends up a failure (not hidden, not
    // unconfirmed). Keyed by the row object, which `empty.failures` hands back
    // as it was added, so the rows themselves stay `{ id, label }`.
    const emptyExtras = new WeakMap<
      object,
      { section: LinkSection | undefined; occurrence: () => ReturnType<typeof componentOccurrence> }
    >();

    // Browser URL resolution uses the first document base. Only use an HTTP(S)
    // base for evidence: custom schemes could turn an otherwise ordinary link
    // into a sensitive or non-navigable value that this rule does not model.
    const documentBase = (() => {
      const raw = doc.querySelector("base[href]")?.getAttribute("href");
      if (!raw) return ctx.page.finalUrl ?? ctx.page.url;
      try {
        const resolved = new URL(raw, ctx.page.finalUrl ?? ctx.page.url);
        return resolved.protocol === "http:" || resolved.protocol === "https:"
          ? resolved.toString()
          : (ctx.page.finalUrl ?? ctx.page.url);
      } catch {
        return ctx.page.finalUrl ?? ctx.page.url;
      }
    })();

    const resolvedHref = (href: string): string => {
      try {
        return new URL(href, documentBase).toString();
      } catch {
        return href;
      }
    };

    for (const link of links) {
      const href = link.getAttribute("href") || "";
      // Read for every anchor, in document order, so repeats of one link line up with the parse.
      const section = sectionOf(link, href);

      // Skip anchor links and javascript
      if (href.trimStart().startsWith("#") || hasUnsafeUrlScheme(href)) continue;

      // Get accessible name (aria-labelledby, aria-label, title)
      const accessibleName = getAccessibleName(link, doc as unknown as Document);

      // If has accessible name via ARIA, skip further checks
      if (accessibleName) {
        // Still check if it's generic
        if (isGeneric(accessibleName) && !isHidden(link)) {
          genericLinks.push(accessibleName);
          genericOccurrences.push(
            componentOccurrence(
              {
                pageUrl: ctx.page.url,
                observedUrl: ctx.page.finalUrl ?? ctx.page.url,
                rendered: ctx.page.rendered === true,
                element: link,
                kind: "link-text-generic",
                values: { nameSource: "accessible-name", normalizedText: normalizeLinkLabel(accessibleName) },
                sensitiveValues: { destination: resolvedHref(href) },
              },
              occurrenceCache,
            ),
          );
          noteSection(genericSections, accessibleName, section);
        }
        continue;
      }

      // Check for accessible content
      const { hasContent, contentType } = hasAccessibleContent(link);

      if (!hasContent) {
        const row = { id: href.substring(0, 50), label: contentType };
        emptyExtras.set(row, {
          section,
          occurrence: () =>
            componentOccurrence(
              {
                pageUrl: ctx.page.url,
                observedUrl: ctx.page.finalUrl ?? ctx.page.url,
                rendered: ctx.page.rendered === true,
                element: link,
                kind: "link-text-empty",
                values: { reason: contentType },
                sensitiveValues: { destination: resolvedHref(href) },
              },
              occurrenceCache,
            ),
        });
        empty.add(link, row);
        continue;
      }

      // Has content - check if it's generic
      const text = link.textContent?.trim().toLowerCase() || "";
      if (isGeneric(text) && !isHidden(link)) {
        genericLinks.push(text);
        genericOccurrences.push(
          componentOccurrence(
            {
              pageUrl: ctx.page.url,
              observedUrl: ctx.page.finalUrl ?? ctx.page.url,
              rendered: ctx.page.rendered === true,
              element: link,
              kind: "link-text-generic",
              values: { nameSource: "text", normalizedText: normalizeLinkLabel(text) },
              sensitiveValues: { destination: resolvedHref(href) },
            },
            occurrenceCache,
          ),
        );
        noteSection(genericSections, text, section);
      }
    }

    if (emptyLinks.length > 0) {
      checks.push({
        name: "link-text-empty",
        status: "fail",
        message: `${emptyLinks.length} link(s) with no accessible text`,
        items: emptyLinks.map((item) => ({
          id: item.id,
          label: item.label,
          ...pageRegionsField([emptyExtras.get(item)?.section]),
        })),
        details: {
          reasons: [...new Set(emptyLinks.map((e) => e.label))],
        },
        componentOccurrences: emptyLinks.map((item) => emptyExtras.get(item)!.occurrence()),
      });
    }

    if (empty.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow(
          "link-text",
          "link(s) with no accessible text",
          // The reason an unconfirmed link is empty is dropped: the row's own
          // label says why it is unconfirmed.
          empty.unconfirmed.map((item) =>
            typeof item === "string" || item.label === SCRIPT_STATE_LABEL ? item : { id: item.id },
          ),
        ),
      );
    }

    if (genericLinks.length > 0) {
      const uniqueGeneric = [...new Set(genericLinks)];
      checks.push({
        name: "link-text-generic",
        status: "warn",
        message: `${genericLinks.length} link(s) with generic text`,
        items: uniqueGeneric.map((text) => ({
          id: text,
          ...pageRegionsField(genericSections.get(text)),
        })),
        componentOccurrences: genericOccurrences,
      });
    }

    if (
      emptyLinks.length === 0 &&
      empty.unconfirmed.length === 0 &&
      genericLinks.length === 0 &&
      links.length > 0
    ) {
      checks.push({
        name: "link-text",
        status: "pass",
        message: "All links have descriptive text",
        details: { linksChecked: links.length },
      });
    }

    return { checks };
  },
};
