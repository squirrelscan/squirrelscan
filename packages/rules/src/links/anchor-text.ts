// links/anchor-text - Link anchor text quality

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

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

function isGeneric(link: Element): boolean {
  const text = link.textContent?.trim().toLowerCase() || "";
  return GENERIC_ANCHORS.includes(text);
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
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const links = doc.querySelectorAll("a[href]");

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

      const group = groups.get(target);
      if (group) group.push(link);
      else groups.set(target, [link]);
    }

    const emptyAnchors: Array<{ href: string; snippet: string }> = [];
    const genericAnchors: string[] = [];

    for (const [target, groupLinks] of groups) {
      // A group passes if any member carries a descriptive (non-generic) accessible name.
      const hasDescriptiveLink = groupLinks.some(
        (link) => hasAccessibleName(link, doc) && !isGeneric(link),
      );
      if (hasDescriptiveLink) continue;

      const anyAccessible = groupLinks.some((link) => hasAccessibleName(link, doc));

      if (!anyAccessible) {
        const first = groupLinks[0];
        emptyAnchors.push({
          href: target,
          snippet: truncateHtml(first.outerHTML),
        });
        continue;
      }

      const genericLink = groupLinks.find((link) => isGeneric(link));
      const text = genericLink?.textContent?.trim() || "";
      genericAnchors.push(`"${text}"`);
    }

    if (emptyAnchors.length > 0) {
      checks.push({
        name: "empty-anchor",
        status: "warn",
        message: `${emptyAnchors.length} link(s) have empty anchor text`,
        items: emptyAnchors.map((a) => ({
          id: a.href,
          snippet: a.snippet,
        })),
      });
    }

    if (genericAnchors.length > 0) {
      const uniqueAnchors = [...new Set(genericAnchors)];
      checks.push({
        name: "generic-anchor",
        status: "info",
        message: `${genericAnchors.length} link(s) use generic anchor text`,
        items: uniqueAnchors.map((text) => ({ id: text, label: text })),
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
