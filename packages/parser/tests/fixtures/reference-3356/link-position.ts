// The link position walk as it was before squirrelscan/repo#3356, kept as the
// parity oracle for parse-depth-3356.test.ts: the memoized walk must give every
// anchor the position this did. Not used by the parser.

import type { Element } from "linkedom";

import type { LinkPosition } from "../../../src/extractors/types";

export function referenceDetectLinkPosition(element: Element): LinkPosition {
  let current: Element | null = element;

  while (current) {
    const tagName = current.tagName?.toLowerCase();
    const role = current.getAttribute?.("role")?.toLowerCase();

    // Semantic tag/role groups (same combination & precedence as before).
    if (tagName === "header" || role === "banner") return "header";
    if (tagName === "footer" || role === "contentinfo") return "footer";
    if (tagName === "nav" || role === "navigation") return "nav";
    if (tagName === "aside" || role === "complementary") return "sidebar";
    if (tagName === "main" || tagName === "article" || role === "main") return "content";

    // Class/id pattern groups — only computed when the element actually has a
    // class or id (use getAttribute for className: SVG elements expose an
    // SVGAnimatedString, not a string).
    const rawClass = current.getAttribute?.("class");
    const rawId = current.id;
    if (rawClass || rawId) {
      const className = rawClass ? rawClass.toLowerCase() : "";
      const id = rawId ? rawId.toLowerCase() : "";

      if (className.includes("header") || className.includes("masthead") || id.includes("header")) {
        return "header";
      }
      if (className.includes("footer") || className.includes("colophon") || id.includes("footer")) {
        return "footer";
      }
      if (
        className.includes("nav") ||
        className.includes("menu") ||
        className.includes("navigation") ||
        id.includes("nav")
      ) {
        return "nav";
      }
      if (className.includes("sidebar") || className.includes("aside") || id.includes("sidebar")) {
        return "sidebar";
      }
      if (
        className.includes("content") ||
        className.includes("main") ||
        className.includes("article") ||
        className.includes("post") ||
        id.includes("content") ||
        id.includes("main")
      ) {
        return "content";
      }
    }

    current = current.parentElement;
  }

  return "unknown";
}
