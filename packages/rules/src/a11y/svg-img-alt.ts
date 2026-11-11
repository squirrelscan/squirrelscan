// a11y/svg-img-alt - an inline <svg role="img"> needs an accessible name (#1699)

import { getAttrCI, hasAttrCI } from "@squirrelscan/utils";

import { elementSelector } from "../element-path";
import {
  createStaticVisibility,
  sortUnnamedControls,
  unconfirmedRow,
} from "../shared/static-hidden";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const SNIPPET_MAX_CHARS = 160;
const CHECK = "svg-img-alt";

/** The first token of `role`, lower-cased: `role="img presentation"` is an img to a browser that knows `img`. */
function roleOf(svg: Element): string {
  return (getAttrCI(svg, "role") ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
}

/** A direct `<title>` child with text. A title nested deeper (inside a `<g>`) does not name the svg. */
function hasDirectTitle(svg: Element): boolean {
  for (const child of Array.from(svg.childNodes)) {
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (el.tagName.toLowerCase() === "title" && (el.textContent ?? "").trim() !== "") return true;
  }
  return false;
}

/** Whether `aria-labelledby` resolves, in this document, to at least one element with text. */
function labelledByResolves(doc: Document, value: string): boolean {
  for (const id of value.trim().split(/\s+/)) {
    if (id === "") continue;
    const target = doc.getElementById(id);
    if (target && (target.textContent ?? "").trim() !== "") return true;
  }
  return false;
}

/** What `a11y/aria-labels` reads for a clickable svg: it reports one with none of these, so this rule leaves it to it. */
function ariaLabelsReportsIt(svg: Element): boolean {
  if (!hasAttrCI(svg, "onclick") && !hasAttrCI(svg, "tabindex")) return false;
  return !svg.getAttribute("aria-label") && !svg.getAttribute("aria-labelledby") && !svg.querySelector("title");
}

/** The opening tag of the svg, cut: the attributes are what locates it, not its content. */
function openingTag(svg: Element): string {
  const html = svg.outerHTML ?? "";
  const end = html.indexOf(">");
  const tag = (end >= 0 ? html.slice(0, end + 1) : html).replace(/\s+/g, " ");
  return tag.length > SNIPPET_MAX_CHARS ? `${tag.slice(0, SNIPPET_MAX_CHARS - 1)}…` : tag;
}

/** Why an svg has no name, or null when it has one. */
export function svgNameProblem(doc: Document, svg: Element): "no-name" | "labelledby-missing" | null {
  if (hasDirectTitle(svg)) return null;
  if ((svg.getAttribute("aria-label") ?? "").trim() !== "") return null;
  const labelledBy = svg.getAttribute("aria-labelledby");
  if (labelledBy !== null && labelledBy.trim() !== "") {
    return labelledByResolves(doc, labelledBy) ? null : "labelledby-missing";
  }
  return "no-name";
}

export const svgImgAltRule: Rule = {
  meta: {
    id: "a11y/svg-img-alt",
    name: "SVG Image Alternative Text",
    description: 'Checks that an inline <svg role="img"> has an accessible name',
    solution:
      'A screen reader announces an <svg role="img"> as an image. With no name it reads "image" or skips it, so a chart, logo or icon that carries meaning is lost. Give it a name: a <title> as its first child (and aria-labelledby pointing at its id for the widest support), an aria-label, or an aria-labelledby that points at text on the page. An aria-labelledby whose id is not on the page names nothing. A decorative svg should not have role="img": use aria-hidden="true" or role="presentation" instead. An svg with no role, or hidden from view (the hidden attribute, aria-hidden, a closed dialog, an inline display:none), is not checked. A clickable svg (onclick or tabindex) with no name is reported by a11y/aria-labels, not twice.',
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 6,
    itemSelectors: true,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const visibility = createStaticVisibility({ ariaHidden: true });
    const unnamed = sortUnnamedControls<{ id: string; snippet: string; label: string; selector?: string }>(visibility);
    let assessed = 0;

    for (const svg of doc.querySelectorAll("svg")) {
      if (roleOf(svg) !== "img") continue;
      // Hidden from view is out of the accessibility tree: not assessed (counted by the sorter if unnamed).
      if (visibility.visibility(svg).state === "hidden") continue;
      assessed++;
      const problem = svgNameProblem(doc, svg);
      if (problem === null) continue;
      if (ariaLabelsReportsIt(svg)) {
        assessed--;
        continue;
      }
      const path = elementSelector(svg);
      unnamed.add(svg, {
        id: path,
        snippet: openingTag(svg),
        label:
          problem === "labelledby-missing"
            ? "aria-labelledby points at an id that is not on the page, or at text-less content"
            : "no <title>, aria-label or aria-labelledby",
        ...(ctx.wantsItemSelectors ? { selector: path } : {}),
      });
    }

    if (unnamed.failures.length > 0) {
      checks.push({
        name: CHECK,
        status: "fail",
        message: `${unnamed.failures.length} <svg role="img"> element(s) without an accessible name`,
        value: unnamed.failures.length,
        items: unnamed.failures.slice(0, 10),
        ...(unnamed.failures.length > 10 ? { details: { additional: unnamed.failures.length - 10 } } : {}),
      });
    }
    if (unnamed.unconfirmed.length > 0) {
      checks.push(unconfirmedRow(CHECK, '<svg role="img"> element(s) without an accessible name', unnamed.unconfirmed));
    }
    if (assessed > 0 && unnamed.failures.length === 0 && unnamed.unconfirmed.length === 0) {
      checks.push({
        name: CHECK,
        status: "pass",
        message: 'All <svg role="img"> elements have accessible names',
        details: { svgChecked: assessed },
      });
    }
    return { checks };
  },
};
