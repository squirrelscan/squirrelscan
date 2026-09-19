import { componentSiteOrigin, type ComponentOccurrence } from "@squirrelscan/core-contracts";
import type { Element } from "linkedom";
import { createHash } from "node:crypto";

type RegionRole = ComponentOccurrence["region"]["role"];

/**
 * A deterministic, non-reversible display key; raw crawler text never leaves
 * the rule.
 *
 * SHA-256 truncated to its first 128 bits. An occurrence carries six of these
 * and a page of 1,000 defective links carries 1,000 occurrences, so the full
 * 64-hex digest was the single largest term in report size — halving it halves
 * the evidence payload with collision odds that stay negligible at corpus
 * scale. The prefix says what the value actually is rather than claiming a full
 * SHA-256: `s128` = SHA-256 truncated to 128 bits.
 */
export function componentHash(value: string): string {
  return `s128:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function tag(element: Element): string {
  return element.tagName.toLowerCase();
}

/**
 * Class tokens that mark PER-PAGE interaction state rather than component
 * identity. The same nav on the same site carries `active`/`is-current` on a
 * different link on every page, so leaving them in would make each page its own
 * variant and grouping would never fire on a real site.
 */
const STATE_CLASS_TOKENS = new Set([
  "active",
  "current",
  "selected",
  "open",
  "opened",
  "expanded",
  "collapsed",
]);

/** True for `active`, `is-active`, `has-open`, `nav--current`, `menu_selected`… */
function isStateClass(token: string): boolean {
  const segments = token.toLowerCase().split(/[-_]+/).filter(Boolean);
  while (segments.length > 1 && (segments[0] === "is" || segments[0] === "has")) {
    segments.shift();
  }
  const last = segments[segments.length - 1];
  return last !== undefined && STATE_CLASS_TOKENS.has(last);
}

function stableAttributes(element: Element): string {
  const id = element.getAttribute("id");
  const role = element.getAttribute("role");
  const classes = (element.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !isStateClass(token))
    .sort()
    .map((value) => `.${value}`);
  // `aria-current`/`aria-expanded` are the ARIA spelling of the same per-page
  // state as the class tokens above, and are excluded for the same reason.
  const semantics = ["lang", "dir", "hidden", "aria-label", "aria-labelledby", "aria-hidden"]
    .map((name) => {
      const value = element.getAttribute(name);
      return value === null ? "" : `[${name}=${value}]`;
    })
    .filter(Boolean);
  // This string is only ever fed to componentHash; no raw crawled attribute
  // value is attached to report evidence.
  return [id ? `#${id}` : "", role ? `[role=${role}]` : "", ...classes, ...semantics]
    .filter(Boolean)
    .join("");
}

function isArticle(element: Element): boolean {
  return tag(element) === "article" || element.getAttribute("role") === "article";
}

function isMain(element: Element): boolean {
  return tag(element) === "main" || element.getAttribute("role") === "main";
}

function regionRole(element: Element): RegionRole | undefined {
  const name = tag(element);
  const role = element.getAttribute("role");
  if (name === "footer" || role === "contentinfo") return "footer";
  if (name === "header" || role === "banner") return "header";
  if (name === "nav" || role === "navigation") return "navigation";
  if (name === "main" || role === "main") return "main";
  return undefined;
}

/**
 * Article/main ancestry strictly BETWEEN `element` and `region`. `nestedIn`
 * below only looks ABOVE the region, so a `<footer><article><a>` reads as plain
 * site chrome and two unrelated articles' links merge into one repair target.
 */
function nestedBelowRegion(
  element: Element,
  region: Element,
): ComponentOccurrence["region"]["nestedIn"] | undefined {
  for (let current = element.parentElement; current && current !== region; current = current.parentElement) {
    if (isArticle(current)) return "article";
    if (isMain(current)) return "main";
  }
  return undefined;
}

function nestedIn(element: Element): ComponentOccurrence["region"]["nestedIn"] {
  for (let current = element.parentElement; current; current = current.parentElement) {
    if (isArticle(current)) return "article";
    if (isMain(current)) return "main";
  }
  return "none";
}

/**
 * Keep landmarks scoped to their enclosing chrome composition. A navigation
 * inside a header is not the same repair target as an otherwise identical
 * navigation inside a footer, and header siblings must not renumber footer
 * navigation slots on another layout.
 */
function semanticAncestorContext(element: Element): string {
  const roles: string[] = [];
  for (let current = element.parentElement; current; current = current.parentElement) {
    const role = regionRole(current);
    if (role) roles.push(role);
  }
  return roles.length > 0 ? roles.join(">") : "none";
}

function childSkeleton(element: Element): { value: string; truncated: boolean } {
  let remaining = 256;
  let truncated = false;
  const visit = (current: Element): string => {
    if (remaining-- <= 0) {
      truncated = true;
      return "…";
    }
    const children = [...current.children] as Element[];
    return `${tag(current)}${stableAttributes(current)}(${children.map(visit).join(",")})`;
  };
  return { value: visit(element), truncated };
}

function elementPath(root: Element, element: Element, cache: ComponentOccurrenceCache): string {
  const parts: string[] = [];
  for (
    let current: Element | null = element;
    current && current !== root;
    current = current.parentElement
  ) {
    parts.push(`${tag(current)}:${cache.siblingTagIndex(current)}`);
  }
  parts.push(tag(root));
  return parts.reverse().join(">");
}

function documentRoot(element: Element): Element {
  let root = element;
  for (let current = element.parentElement; current; current = current.parentElement)
    root = current;
  return root;
}

type RegionEvidence = {
  skeleton: { value: string; truncated: boolean };
  contentHash: string;
  slot: string;
};

/**
 * Rule-run-local DOM cache. Callers create one per run; it is never global, so
 * parsed documents are released with the rule context.
 */
export class ComponentOccurrenceCache {
  readonly regionEvidence = new WeakMap<Element, RegionEvidence>();
  readonly slots = new Map<string, WeakMap<Element, string>>();
  /** Per-parent tag positions keep repeated sibling locators linear in the DOM size. */
  readonly siblingTagPositions = new WeakMap<Element, WeakMap<Element, number>>();
  /** Direct-child tag sequence per element; rebuilt per faulty element made a
   * 5,000-link nav quadratic (each link re-walked all 5,000 siblings). */
  readonly childTagSequences = new WeakMap<Element, string>();
  regionBuilds = 0;
  siblingTagIndexBuilds = 0;
  childTagSequenceBuilds = 0;

  childTagSequence(element: Element): string {
    const cached = this.childTagSequences.get(element);
    if (cached !== undefined) return cached;
    const value = [...(element.children as unknown as Iterable<Element>)].map(tag).join(",");
    this.childTagSequences.set(element, value);
    this.childTagSequenceBuilds++;
    return value;
  }

  siblingTagIndex(element: Element): number {
    const parent = element.parentElement;
    if (!parent) return 1;
    let positions = this.siblingTagPositions.get(parent);
    if (!positions) {
      positions = new WeakMap<Element, number>();
      const byTag = new Map<string, number>();
      for (const child of parent.children as unknown as Iterable<Element>) {
        const childTag = tag(child);
        const index = (byTag.get(childTag) ?? 0) + 1;
        byTag.set(childTag, index);
        positions.set(child, index);
      }
      this.siblingTagPositions.set(parent, positions);
      this.siblingTagIndexBuilds++;
    }
    return positions.get(element) ?? 1;
  }

  getRegionEvidence(
    region: Element,
    role: RegionRole,
    nesting: ComponentOccurrence["region"]["nestedIn"],
    ancestorContext: string,
  ): RegionEvidence {
    const cached = this.regionEvidence.get(region);
    if (cached) return cached;
    const root = documentRoot(region);
    const slotKey = `${role}|${nesting}|${ancestorContext}`;
    let slots = this.slots.get(slotKey);
    if (!slots) {
      slots = new WeakMap<Element, string>();
      // Article/main-local landmarks are not peers of site chrome. Their slot
      // must not shift a footer/navigation identity on another page layout.
      const peers = [...root.querySelectorAll("*")].filter(
        (element) =>
          regionRole(element as Element) === role &&
          nestedIn(element as Element) === nesting &&
          semanticAncestorContext(element as Element) === ancestorContext,
      ) as Element[];
      peers.forEach((peer, index) => slots!.set(peer, `${role}:${index + 1}`));
      this.slots.set(slotKey, slots);
    }
    const evidence = {
      skeleton: childSkeleton(region),
      contentHash: componentHash(region.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      slot: slots.get(region) ?? `${role}:unknown`,
    };
    this.regionEvidence.set(region, evidence);
    this.regionBuilds++;
    return evidence;
  }
}

function findRegion(element: Element): Element | undefined {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (regionRole(current)) return current;
  }
  return undefined;
}

export function componentOccurrence(
  input: {
    pageUrl: string;
    /** The fetched/final URL determines site identity; pageUrl preserves source membership. */
    observedUrl?: string;
    rendered: boolean;
    element: Element;
    kind: ComponentOccurrence["defect"]["kind"];
    values: Record<string, string | number>;
    sensitiveValues?: Record<string, string>;
  },
  cache = new ComponentOccurrenceCache(),
): ComponentOccurrence {
  const region = findRegion(input.element);
  const role = region ? regionRole(region)! : "unknown";
  const nesting = region ? nestedIn(region) : "unknown";
  const ancestorContext = region ? semanticAncestorContext(region) : "unknown";
  // An article header is content, not site chrome. Unknown DOM ancestry remains
  // deliberately page-scoped rather than becoming a speculative component.
  const regionEvidence = region
    ? cache.getRegionEvidence(region, role, nesting, ancestorContext)
    : undefined;
  const regionSkeleton = regionEvidence?.skeleton ?? {
    value: tag(input.element),
    truncated: false,
  };
  const elementSkeleton = childSkeleton(input.element);
  // Ordered most-specific first, so the recorded reason names the actual cause
  // rather than whichever test happened to run first.
  const contentNested =
    region !== undefined &&
    (nesting === "article" || nesting === "main" || nestedBelowRegion(input.element, region) !== undefined);
  const uncertainReason: ComponentOccurrence["uncertainReason"] = !region
    ? "no-region"
    : contentNested
      ? "content-nested"
      : role === "main"
        ? "region-main"
        : regionSkeleton.truncated || elementSkeleton.truncated
          ? "structure-truncated"
          : undefined;
  const groupable = uncertainReason === undefined;
  const regionStructure = regionSkeleton.value;
  const elementStructure = elementSkeleton.value;
  const contentHash = regionEvidence?.contentHash ?? componentHash("");
  const pageHash = componentHash(input.pageUrl);
  // Derived ONCE, here, and recorded on the occurrence below; every consumer
  // reads it back rather than deriving its own. See `componentSiteOrigin`.
  const origin = componentSiteOrigin(input.observedUrl ?? input.pageUrl);
  // Family must be stricter than "same tag": a footer with no id or class would
  // otherwise merge with every other site footer of the same nesting. The direct
  // child tag sequence is the cheapest shape that separates them and, unlike the
  // full skeleton, does not move when a nested element changes.
  const childTagSequence = cache.childTagSequence(region ?? input.element);
  const familyStructure = `${role}|${nesting}|${ancestorContext}|${tag(region ?? input.element)}${stableAttributes(region ?? input.element)}|(${childTagSequence})`;
  const familyKey = groupable ? componentHash(`${origin}|${familyStructure}`) : `page:${pageHash}`;
  // Variant is a STRUCTURAL identity. Region text is reported separately as
  // `contentHash`; folding it in here made any per-page string in a footer
  // (a date, a breadcrumb, a page number) split every page into its own variant.
  const variantStructure = `${familyStructure}|${regionStructure}`;
  const variantKey = groupable ? componentHash(variantStructure) : `page:${pageHash}`;
  const valueHashes = Object.fromEntries(
    Object.entries({ ...input.values, ...input.sensitiveValues }).map(([key, value]) => [
      key,
      componentHash(String(value)),
    ]),
  );

  return {
    version: 1,
    pageUrl: input.pageUrl,
    siteOrigin: origin,
    provenance: { source: "page-dom", rendered: input.rendered },
    groupable,
    confidence: groupable ? "observed" : "uncertain",
    ...(uncertainReason ? { uncertainReason } : {}),
    region: { role, nestedIn: nesting, structuralSignature: componentHash(regionStructure) },
    family: { key: familyKey, structuralSignature: componentHash(familyStructure) },
    variant: { key: variantKey, structuralSignature: componentHash(variantStructure), contentHash },
    element: {
      // The region slot separates two otherwise-identical footer/navigation
      // instances on one page without making a page-layout path part of family.
      locator: region
        ? `${regionEvidence!.slot}>${elementPath(region, input.element, cache)}`
        : elementPath(documentRoot(input.element), input.element, cache),
      structuralSignature: componentHash(elementStructure),
    },
    defect: { kind: input.kind, values: input.values, valueHashes },
  };
}
