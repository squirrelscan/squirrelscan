// links/anchor-text - Link anchor text quality

import { coerceSchemelessUrl } from "@squirrelscan/utils";
import { isConventionalLinkLabel } from "../shared/conventional-link-labels";
import { isGenericInPageLanguage } from "../shared/generic-link-phrases";
import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import {
  addSection,
  mergeSections,
  pageRegionsField,
  sectionMeta,
  withSection,
  type SectionCounts,
} from "./link-section-label";

const MAX_SNIPPET_LEN = 120;

function truncateHtml(html: string): string {
  if (html.length <= MAX_SNIPPET_LEN) return html;
  return `${html.slice(0, MAX_SNIPPET_LEN)}...`;
}

const GENERIC_ANCHORS = [
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "link",
  "this",
  "this link",
  "go",
  "continue",
];

function hasAccessibleName(link: Element, doc: Document): boolean {
  const text = link.textContent?.trim() || "";
  const hasImage = link.querySelector("img");
  const imageAlt = hasImage?.getAttribute("alt") || "";
  if (text || imageAlt) return true;

  const ariaLabel = link.getAttribute("aria-label")?.trim();
  if (ariaLabel) return true;

  const labelledBy = link.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    const hasLabel = ids.some((id) => {
      const el = doc.getElementById(id);
      return el?.textContent?.trim();
    });
    if (hasLabel) return true;
  }

  const title = link.getAttribute("title")?.trim();
  if (title) return true;

  const svg = link.querySelector("svg");
  if (svg) {
    const svgTitle = svg.querySelector("title")?.textContent?.trim();
    const svgAriaLabel = svg.getAttribute("aria-label")?.trim();
    if (svgTitle || svgAriaLabel) return true;
  }

  const roleImg = link.querySelector('[role="img"]');
  if (roleImg?.getAttribute("aria-label")?.trim()) return true;

  return false;
}

/** English always applies; the page language adds its own generic phrases (pub#840). */
function isGeneric(link: Element, lang: string | null | undefined): boolean {
  const raw = link.textContent?.trim() || "";
  const text = raw.toLowerCase();
  if (isConventionalLinkLabel(raw)) return false;
  return GENERIC_ANCHORS.includes(text) || isGenericInPageLanguage(raw, lang);
}

export const anchorTextRule: Rule = {
  meta: {
    id: "links/anchor-text",
    name: "Anchor Text",
    description: "Checks for empty or generic anchor text",
    solution:
      "Descriptive anchor text helps users and search engines understand link destinations. Avoid generic text like 'click here' or 'read more'. Use natural language that describes the target page. For accessibility, anchor text should make sense out of context. Avoid overly long anchor text or keyword stuffing. When a card links to the same target more than once (e.g. an image link and a headline link), only one of those links needs descriptive text — the group is evaluated together, not link by link.",
    category: "links",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const links = doc.querySelectorAll("a[href]");
    const lang = doc.documentElement?.getAttribute("lang");

    // The first href written for each target (#2307).
    const firstHref = new Map<string, string>();

    // Group links by resolved target URL so redundant links to the same
    // destination (image + headline + "Read more") are evaluated as one unit.
    const groups = new Map<string, Element[]>();

    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;
      if (href.startsWith("#")) continue;

      let target: string;
      try {
        target = new URL(href, ctx.page.url).href;
      } catch {
        target = href;
      }
      // Kept for the section lookup below, which reads the href the way the parse stored it.
      if (!firstHref.has(target)) firstHref.set(target, href);

      const group = groups.get(target);
      if (group) group.push(link);
      else groups.set(target, [link]);
    }

    // #2307: where on this page each target's links sit, by resolved URL, built only when a group
    // is flagged. A parse without sections (an old crawl) leaves it empty and the items bare.
    let placed: Map<string, SectionCounts> | undefined;
    const placedOf = (target: string): SectionCounts | undefined => {
      if (!placed) {
        placed = new Map();
        for (const link of ctx.parsed.links ?? []) addSection(placed, link.url, link.section);
      }
      // The parse stores a link under `coerceSchemelessUrl`'s reading (`www.example.org` is a host,
      // not a path), so that is the key for where it sits. Grouping above is unchanged.
      let key = target;
      const href = firstHref.get(target);
      if (href !== undefined) {
        try {
          key = new URL(coerceSchemelessUrl(href.trim()), ctx.page.url).toString();
        } catch {
          // keep the resolved target
        }
      }
      return placed.get(key);
    };

    const emptyAnchors: Array<{ href: string; snippet: string; sections?: SectionCounts }> = [];
    const genericAnchors: string[] = [];
    // The same, per generic anchor text: the item is the text, not a target.
    const genericSections = new Map<string, SectionCounts>();

    for (const [target, groupLinks] of groups) {
      // A group passes if any member carries a descriptive (non-generic) accessible name.
      const hasDescriptiveLink = groupLinks.some(
        (link) => hasAccessibleName(link, doc) && !isGeneric(link, lang),
      );
      if (hasDescriptiveLink) continue;

      const anyAccessible = groupLinks.some((link) => hasAccessibleName(link, doc));

      if (!anyAccessible) {
        const first = groupLinks[0];
        emptyAnchors.push({
          href: target,
          snippet: truncateHtml(first.outerHTML),
          sections: placedOf(target),
        });
        continue;
      }

      const genericLink = groupLinks.find((link) => isGeneric(link, lang));
      const text = genericLink?.textContent?.trim() || "";
      genericAnchors.push(`"${text}"`);
      const here = placedOf(target);
      if (here) {
        let counts = genericSections.get(`"${text}"`);
        if (!counts) genericSections.set(`"${text}"`, (counts = {}));
        mergeSections(counts, here);
      }
    }

    if (emptyAnchors.length > 0) {
      checks.push({
        name: "empty-anchor",
        status: "warn",
        message: `${emptyAnchors.length} link(s) have empty anchor text`,
        items: emptyAnchors.map((a) => ({
          id: a.href,
          snippet: a.snippet,
          ...(a.sections
            ? { label: withSection(a.href, a.sections), meta: sectionMeta(a.sections) }
            : {}),
          // pub#846: the sections it sits in on this page, so the report can scope it to one.
          ...pageRegionsField(a.sections),
        })),
      });
    }

    if (genericAnchors.length > 0) {
      const uniqueAnchors = [...new Set(genericAnchors)];
      checks.push({
        name: "generic-anchor",
        status: "info",
        message: `${genericAnchors.length} link(s) use generic anchor text`,
        items: uniqueAnchors.map((text) => {
          const sections = genericSections.get(text);
          return {
            id: text,
            label: withSection(text, sections),
            ...(sections ? { meta: sectionMeta(sections) } : {}),
            ...pageRegionsField(sections),
          };
        }),
      });
    }

    if (emptyAnchors.length === 0 && genericAnchors.length === 0) {
      checks.push({
        name: "anchor-text",
        status: "pass",
        message: "Link anchor text is descriptive",
      });
    }

    return { checks };
  },
};
