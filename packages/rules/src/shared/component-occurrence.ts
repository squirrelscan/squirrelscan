import {
  componentSiteOrigin,
  type ComponentOccurrence,
  type RootHint,
  type SubtreeCandidate,
} from "@squirrelscan/core-contracts";
import type { Element } from "linkedom";
import { createHash } from "node:crypto";

type RegionRole = ComponentOccurrence["region"]["role"];
type NestedIn = ComponentOccurrence["region"]["nestedIn"];

/** Safety bound on every upward walk and every ancestor list; real DOMs are far shallower. */
const MAX_ANCESTOR_WALK = 64;
/**
 * Work one page's evidence may cost, in elements visited by the digests, text
 * reads and hint searches that are sized by a subtree (up to about half a
 * microsecond each, so the limit is about half a second). Ordinary pages spend a
 * small share of it: a link is a few elements and a shared region is digested
 * once. A page built so that every faulty element has a huge, distinct ancestor
 * (a deep chain, nested anchors) would otherwise cost the square of its size;
 * once the limit is spent the remaining elements are page-scoped, which is what
 * an element the rule cannot judge already is.
 */
const EVIDENCE_WORK_LIMIT = 1_000_000;

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

/**
 * Per-element memo for {@link stableAttributes}.
 *
 * It splits, filters and sorts a class list and reads six more attributes, and
 * a skeleton calls it once per node — so a block of 1,000 rows pays for the
 * same 3,000 nodes again on every element's ladder. Rules never mutate the DOM
 * they are handed, so the value cannot go stale, and the map is keyed on
 * elements from a per-run document that is released with the rule context.
 */
const stableAttributeCache = new WeakMap<Element, string>();

function stableAttributes(element: Element): string {
  const memoized = stableAttributeCache.get(element);
  if (memoized !== undefined) return memoized;
  const value = buildStableAttributes(element);
  stableAttributeCache.set(element, value);
  return value;
}

function buildStableAttributes(element: Element): string {
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
 * What the elements ABOVE a node say about it, carried down one document pass
 * instead of re-walked from every landmark: the nearest article/main ancestor,
 * and the region roles of the ancestors, nearest first.
 *
 * `nesting` only looks ABOVE a region (`<footer><article><a>` reads as plain
 * site chrome there; the article between the element and its region is
 * {@link RegionScope.below}). `roles` keeps landmarks scoped to their enclosing
 * chrome composition: a navigation inside a header is not the same repair
 * target as an otherwise identical navigation inside a footer, and header
 * siblings must not renumber footer navigation slots on another layout. It is
 * cut at {@link MAX_ANCESTOR_WALK}, so a hostile chain of nested landmarks
 * cannot make every slot key as long as the chain.
 */
interface AncestorState {
  nesting: "article" | "main" | "none";
  roles: readonly RegionRole[];
}

const ROOT_STATE: AncestorState = { nesting: "none", roles: [] };

/** The state a child of `element` inherits. Shared with the parent's when `element` changes nothing. */
function childState(element: Element, state: AncestorState): AncestorState {
  const role = regionRole(element);
  const nesting = isArticle(element) ? "article" : isMain(element) ? "main" : state.nesting;
  if (!role && nesting === state.nesting) return state;
  return {
    nesting,
    roles: role ? [role, ...state.roles].slice(0, MAX_ANCESTOR_WALK) : state.roles,
  };
}

function contextOf(state: AncestorState): string {
  return state.roles.length > 0 ? state.roles.join(">") : "none";
}

/** A landmark as the rest of its page sees it. */
interface LandmarkInfo {
  nesting: NestedIn;
  ancestorContext: string;
  /** `role:N`, N counting the landmarks with the same role, nesting and context in document order. */
  slot: string;
  /**
   * Under {@link MAX_ANCESTOR_WALK} landmarks or more. Real chrome nests a few
   * levels; this is generated or hostile markup, and a region digest per level
   * of it would cost the square of the nesting.
   */
  tooDeep: boolean;
}

/** What one document-order pass over a page records. */
interface RootIndex {
  landmarks: WeakMap<Element, LandmarkInfo>;
  /** Elements in each subtree, itself included. */
  sizes: WeakMap<Element, number>;
}

/**
 * Every landmark under `root`, with its nesting, ancestor context and slot, and
 * the size of every subtree, from ONE iterative document-order pass. The slot of
 * a landmark used to come from a `querySelectorAll("*")` per distinct
 * `role|nesting|context` key, each element of which walked its own ancestors, so
 * a page with many distinct landmark contexts cost keys x elements x depth.
 *
 * `root` itself is not numbered (it was never one of its own peers), but it
 * does count as an ancestor of everything under it.
 */
function indexRoot(root: Element): RootIndex {
  const landmarks = new WeakMap<Element, LandmarkInfo>();
  const counters = new Map<string, number>();
  const order: Element[] = [root];
  // Parallel stacks: an element and the state its ancestors give it.
  const pending: Element[] = [];
  const states: AncestorState[] = [];
  const pushChildren = (parent: Element, state: AncestorState) => {
    const children = [...parent.children] as Element[];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
      states.push(state);
    }
  };
  pushChildren(root, childState(root, ROOT_STATE));
  while (pending.length > 0) {
    const element = pending.pop()!;
    const inherited = states.pop()!;
    order.push(element);
    const role = regionRole(element);
    if (role) {
      const context = contextOf(inherited);
      const key = `${role}|${inherited.nesting}|${context}`;
      const position = (counters.get(key) ?? 0) + 1;
      counters.set(key, position);
      landmarks.set(element, {
        nesting: inherited.nesting,
        ancestorContext: context,
        slot: `${role}:${position}`,
        tooDeep: inherited.roles.length >= MAX_ANCESTOR_WALK,
      });
    }
    pushChildren(element, childState(element, inherited));
  }
  // Document order puts a parent before its children, so walking it backwards
  // finishes every child before the parent that adds it up.
  const sizes = new WeakMap<Element, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const element = order[index]!;
    const size = (sizes.get(element) ?? 0) + 1;
    sizes.set(element, size);
    const parent = element.parentElement;
    if (parent && element !== root) sizes.set(parent, (sizes.get(parent) ?? 0) + size);
  }
  return { landmarks, sizes };
}

/** The nearest landmark at or above an element, and the content ancestry between them. */
interface RegionScope {
  region: Element | null;
  /** An article/main strictly BETWEEN the element and `region`. */
  below: "article" | "main" | undefined;
}

const NO_REGION: RegionScope = { region: null, below: undefined };

/**
 * A structural digest of `element`'s whole subtree, hashed as it is walked.
 *
 * Replaces a 256-node skeleton STRING. The cap was there to bound the string,
 * but it also set `structure-truncated`, which made the region ungroupable —
 * and the regions it hit were the big shared ones. On one WordPress theme it
 * silenced 102 of 235 link-text occurrences, all of them the same mega menu:
 * the budget removed exactly the component the feature exists to find.
 *
 * Streaming removes the cap without ever materialising the string, so cost is
 * one O(nodes) pass. It is iterative because the walk is now unbounded and a
 * deep DOM would otherwise overflow the stack. The token sequence is identical
 * to the old skeleton's, so this is the same identity, just not truncated.
 */
function structuralDigest(element: Element): string {
  const hash = createHash("sha256");
  // A string entry is a literal token; an element entry is expanded in place.
  const stack: (Element | string)[] = [element];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (typeof current === "string") {
      hash.update(current);
      continue;
    }
    hash.update(`${tag(current)}${stableAttributes(current)}(`);
    const children = [...current.children] as Element[];
    // Pushed in reverse so the stack yields `child , child , child )`.
    stack.push(")");
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
      if (index > 0) stack.push(",");
    }
  }
  return `s128:${hash.digest("hex").slice(0, 32)}`;
}

/**
 * The element's path under `root`, nearest levels kept: a page-builder DOM is a
 * few dozen levels deep, and past {@link MAX_ANCESTOR_WALK} the locator reads
 * `\u2026>` instead of naming the rest, so one very deep element costs a bounded
 * string and a bounded walk, not its whole depth.
 */
function elementPath(root: Element, element: Element, cache: ComponentOccurrenceCache): string {
  const parts: string[] = [];
  let reachedRoot = true;
  for (
    let current: Element | null = element;
    current && current !== root;
    current = current.parentElement
  ) {
    if (parts.length >= MAX_ANCESTOR_WALK) {
      reachedRoot = false;
      break;
    }
    parts.push(`${tag(current)}:${cache.siblingTagIndex(current)}`);
  }
  parts.push(reachedRoot ? tag(root) : "\u2026");
  return parts.reverse().join(">");
}

type RegionEvidence = {
  skeleton: string;
  contentHash: string;
  slot: string;
};

/**
 * Rule-run-local DOM cache. Callers create one per run; it is never global, so
 * parsed documents are released with the rule context.
 */
export class ComponentOccurrenceCache {
  readonly regionEvidence = new WeakMap<Element, RegionEvidence>();
  /** Landmarks and subtree sizes of a document, from one pass per root; see {@link indexRoot}. */
  readonly rootIndexes = new WeakMap<Element, RootIndex>();
  /** Elements whose ladder features (signature, text length, hint) have been paid for. */
  private readonly ladderPaid = new WeakSet<Element>();
  private work = 0;
  private workSpent = false;
  /**
   * Upward answers, memoised per element so every faulty element reuses its
   * ancestors' work: each element is resolved once, so all the walks together
   * cost the size of the DOM, not its depth times the number of faulty elements.
   */
  readonly roots = new WeakMap<Element, Element>();
  readonly scopes = new WeakMap<Element, RegionScope>();
  readonly ladderRoots = new WeakMap<Element, Element>();
  /** Per-parent tag positions keep repeated sibling locators linear in the DOM size. */
  readonly siblingTagPositions = new WeakMap<Element, WeakMap<Element, number>>();
  /** Direct-child tag sequence per element; rebuilt per faulty element made a
   * 5,000-link nav quadratic (each link re-walked all 5,000 siblings). */
  readonly childTagSequences = new WeakMap<Element, string>();
  /** Ancestor skeletons and text lengths for the subtree ladder. Every faulty
   * element in one block walks the SAME ancestors, so without this the ladder
   * would re-skeletonize each shared ancestor once per element. */
  readonly subtreeSignatures = new WeakMap<Element, string>();
  readonly textLengths = new WeakMap<Element, number>();
  /** Skeleton string -> digest; bounded by the page's distinct subtree shapes. */
  readonly signatureBySkeleton = new Map<string, string>();
  /** Hints are per ancestor and every element in a block walks the same ones. */
  readonly rootHints = new WeakMap<Element, RootHint | null>();

  /** The topmost element above `element` (or `element` itself). */
  rootOf(element: Element): Element {
    return this.resolveUp(this.roots, element, (current, parent, parentValue) => parentValue ?? current);
  }

  /**
   * `<body>` when `element` sits in one, else the topmost element. The ladder's
   * outer bound for a page with no landmark at all.
   */
  ladderRoot(element: Element): Element {
    return this.resolveUp(this.ladderRoots, element, (current, parent, parentValue) =>
      tag(current) === "body" ? current : (parentValue ?? current),
    );
  }

  /** The nearest landmark at or above `element`, and what lies between them. */
  regionScope(element: Element): RegionScope {
    return this.resolveUp(this.scopes, element, (current, parent, parentScope) => {
      if (regionRole(current)) return { region: current, below: undefined };
      if (!parent || !parentScope || parentScope.region === null) return NO_REGION;
      const region = parentScope.region;
      const below =
        parent === region
          ? undefined
          : isArticle(parent)
            ? "article"
            : isMain(parent)
              ? "main"
              : parentScope.below;
      // Most elements add nothing to what their parent already says.
      return parentScope.below === below ? parentScope : { region, below };
    });
  }

  private rootIndex(element: Element): RootIndex {
    const root = this.rootOf(element);
    let index = this.rootIndexes.get(root);
    if (!index) {
      index = indexRoot(root);
      this.rootIndexes.set(root, index);
      this.landmarkIndexBuilds++;
    }
    return index;
  }

  /** Elements in the subtree rooted at `element`, itself included. */
  subtreeSize(element: Element): number {
    return this.rootIndex(element).sizes.get(element) ?? 1;
  }

  /**
   * Pay `units` of subtree-sized work. False, and every later call false too,
   * once the page's {@link EVIDENCE_WORK_LIMIT} would be passed.
   */
  spend(units: number): boolean {
    if (this.workSpent) return false;
    if (this.work + units > EVIDENCE_WORK_LIMIT) {
      this.workSpent = true;
      return false;
    }
    this.work += units;
    return true;
  }

  /** Pay once for the ladder features of `element`; they are memoised after that. */
  payLadder(element: Element, factor: number): boolean {
    if (this.ladderPaid.has(element)) return true;
    if (!this.spend(factor * this.subtreeSize(element))) return false;
    this.ladderPaid.add(element);
    return true;
  }

  /** Nesting, ancestor context and slot of a landmark, from its document's one pass. */
  landmark(region: Element): LandmarkInfo {
    return (
      this.rootIndex(region).landmarks.get(region) ?? {
        nesting: "none",
        ancestorContext: "none",
        slot: `${regionRole(region) ?? "unknown"}:unknown`,
        tooDeep: false,
      }
    );
  }

  /**
   * Resolve `compute` for `element` from the values of its ancestors, filling the
   * memo for every element it passes. Iterative: the chain is collected upward to
   * the first memoised ancestor, then resolved from the top down.
   */
  private resolveUp<T>(
    memo: WeakMap<Element, T>,
    element: Element,
    compute: (current: Element, parent: Element | null, parentValue: T | undefined) => T,
  ): T {
    const known = memo.get(element);
    if (known !== undefined) return known;
    const chain: Element[] = [];
    let anchor: Element | null = null;
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (memo.has(current)) {
        anchor = current;
        break;
      }
      chain.push(current);
    }
    let parent: Element | null = anchor;
    let parentValue: T | undefined = anchor ? memo.get(anchor) : undefined;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const current = chain[index]!;
      parentValue = compute(current, parent, parentValue);
      memo.set(current, parentValue);
      parent = current;
    }
    return parentValue as T;
  }

  rootHint(element: Element): RootHint | undefined {
    const cached = this.rootHints.get(element);
    if (cached !== undefined) return cached ?? undefined;
    const value = rootHint(element) ?? null;
    this.rootHints.set(element, value);
    return value ?? undefined;
  }
  subtreeSignatureBuilds = 0;

  /**
   * Structurally identical siblings produce the SAME skeleton string, so the
   * digest is memoised by that string as well as by element. A page of 1,000
   * identical rows hashes once instead of a thousand times, which is most of
   * the ladder's cost on a page that has a thousand defects in one block.
   */
  subtreeSignature(element: Element): string {
    const cached = this.subtreeSignatures.get(element);
    if (cached !== undefined) return cached;
    const skeleton = structuralDigest(element);
    let value = this.signatureBySkeleton.get(skeleton);
    if (value === undefined) {
      value = componentHash(skeleton);
      this.signatureBySkeleton.set(skeleton, value);
      this.subtreeSignatureBuilds++;
    }
    this.subtreeSignatures.set(element, value);
    return value;
  }

  textLength(element: Element): number {
    const cached = this.textLengths.get(element);
    if (cached !== undefined) return cached;
    const value = (element.textContent ?? "").replace(/\s+/g, " ").trim().length;
    this.textLengths.set(element, value);
    return value;
  }
  regionBuilds = 0;
  landmarkIndexBuilds = 0;
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

  /** The digest, text hash and slot of a landmark; undefined once the page's work budget is spent. */
  getRegionEvidence(region: Element): RegionEvidence | undefined {
    const cached = this.regionEvidence.get(region);
    if (cached) return cached;
    // The digest and the text read each visit the whole region.
    if (!this.spend(2 * this.subtreeSize(region))) return undefined;
    const evidence = {
      skeleton: structuralDigest(region),
      contentHash: componentHash(region.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      slot: this.landmark(region).slot,
    };
    this.regionEvidence.set(region, evidence);
    this.regionBuilds++;
    return evidence;
  }
}

/**
 * Rungs nearest the faulty element, and rungs nearest the region root.
 *
 * A pure element-upward ladder made DEPTH decide which rungs exist: in one
 * theme's menu, six links sat one level deeper than two others, so the deeper
 * six ran out of budget before reaching the block and promoted at its child.
 * One menu became two components. Anchoring the top of the ladder at the region
 * root instead means any two elements under the same block always share that
 * block's rungs, whatever their depth.
 */
const SUBTREE_NEAR_LEVELS = 4;
const SUBTREE_ROOT_LEVELS = 4;
/**
 * Values that must never ride along in a hint. A heading or aria-label is page
 * text, so it is filtered the way any other emitted text is: addresses, phone
 * numbers, URLs and token-shaped strings are dropped rather than truncated.
 */
const SENSITIVE_HINT_TEXT =
  /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,}\b|\bhttps?:\/\/\S+|\b\+?\d[\d(). -]{7,40}\d\b|\b(?:bearer|token|key|secret)\b\s?[:=]?\s?\S{6,}/i;
const HINT_MAX = 60;
/**
 * Characters of an attribute or heading read at all, and characters tested for
 * sensitive shapes. Both are far past what can be emitted (HINT_MAX - 1) and
 * past an email's longest local part, so the cut hides nothing; it is what keeps
 * a megabyte of crawled text from costing the pattern a megabyte of work.
 */
const HINT_READ_MAX = 1024;
const HINT_TEST_MAX = 256;

/** Bounded, single-line, and dropped entirely when it carries anything sensitive. */
function hintText(value: string | null | undefined): string | undefined {
  const text = (value ?? "")
    .trimStart()
    .slice(0, HINT_READ_MAX)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, HINT_TEST_MAX);
  if (!text || SENSITIVE_HINT_TEXT.test(text)) return undefined;
  return text.length > HINT_MAX ? `${text.slice(0, HINT_MAX - 1)}\u2026` : text;
}

/**
 * An id a human would recognise, not `sp-ppork3` or `wp-block-3f8a91`.
 *
 * Every hyphen/underscore token must be all letters or all digits. A token that
 * MIXES them is a generated suffix: one real theme emitted `sp-ppork3`, which a
 * digit-count rule happily accepted and which says nothing to a reader.
 */
function stableId(value: string | null): string | undefined {
  const id = (value ?? "").trim();
  if (!id || id.length > 40) return undefined;
  const tokens = id.split(/[-_]+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  if (!tokens.every((token) => /^[A-Za-z]+$/.test(token) || /^\d+$/.test(token))) return undefined;
  if (!tokens.some((token) => /^[A-Za-z]{2,}$/.test(token))) return undefined;
  return hintText(id);
}

/**
 * Describe `element` for a person: its own labelling first, then the nearest
 * heading inside it, then the closest heading before it. The inside-first order
 * matters because a block's own heading names the block, while a preceding one
 * only names the section it sits in.
 */
function rootHint(element: Element): RootHint | undefined {
  const hint: RootHint = { tag: tag(element) };
  const id = stableId(element.getAttribute("id"));
  if (id) hint.id = id;
  const label = hintText(element.getAttribute("aria-label"));
  if (label) hint.ariaLabel = label;
  // Only headings INSIDE the root. A preceding heading names whatever section
  // the block happens to sit after, not the block: on one storefront the
  // fallback labelled a sticky product bar "Recent post". A wrong label is
  // worse than none, so there is no fallback.
  let heading: string | undefined;
  for (const node of Array.from(element.querySelectorAll("h1,h2,h3,h4,h5,h6")) as Element[]) {
    heading = hintText(node.textContent);
    if (heading) break;
  }
  if (heading) hint.heading = heading;
  return hint.id || hint.ariaLabel || hint.heading ? hint : undefined;
}

/**
 * The ladder's root when there is no landmark at all.
 *
 * A theme with no header/nav/main/footer gives every element `no-region`, which
 * is most of a WooCommerce page: one real site produced 323 occurrences on 40
 * pages, every one of them unjudgeable. `<body>` is the honest outer bound
 * there, and the text share is measured against it for the same reason.
 */
/**
 * Describe each ancestor between the faulty element and its region root.
 *
 * Rules run one page at a time, so this cannot decide whether a subtree is
 * shared. It records what each ancestor looks like; the report stage, which
 * sees every page, promotes the highest level that recurs. Level 0 (the element
 * itself) is deliberately absent: a candidate rooted at the faulty element can
 * never match a sibling defect in the same block.
 */
function subtreeCandidates(
  element: Element,
  region: Element,
  cache: ComponentOccurrenceCache,
): SubtreeCandidate[] {
  if (!cache.payLadder(region, 1)) return [];
  const regionText = cache.textLength(region);
  if (regionText === 0) return [];
  // One upward pass collects both the ancestors and the path segments. Calling
  // elementPath per level re-walks the chain each time, which is quadratic in
  // the ladder depth for every faulty element on the page.
  const ancestors: Element[] = [];
  const segments: string[] = [`${tag(element)}:${cache.siblingTagIndex(element)}`];
  for (
    let ancestor = element.parentElement;
    ancestor && ancestor !== region && ancestors.length < MAX_ANCESTOR_WALK;
    ancestor = ancestor.parentElement
  ) {
    ancestors.push(ancestor);
    segments.push(`${tag(ancestor)}:${cache.siblingTagIndex(ancestor)}`);
  }
  // Nearest the element, then nearest the region root. Deduped and ordered, so
  // two elements at different depths still share the outer rungs.
  const chosen = new Set<number>();
  for (let index = 0; index < Math.min(SUBTREE_NEAR_LEVELS, ancestors.length); index += 1)
    chosen.add(index);
  for (
    let index = Math.max(0, ancestors.length - SUBTREE_ROOT_LEVELS);
    index < ancestors.length;
    index += 1
  )
    chosen.add(index);
  const candidates: SubtreeCandidate[] = [];
  const rungs = [...chosen].sort((left, right) => left - right);
  // A signature, a text length and a hint search each visit the ancestor's subtree.
  for (const index of rungs) if (!cache.payLadder(ancestors[index]!, 3)) return [];
  for (const index of rungs) {
    const ancestor = ancestors[index]!;
    // The locator for this rung is the element's path through the ancestors
    // below it, rooted at that ancestor's tag.
    const path = [tag(ancestor), ...segments.slice(0, index + 1).reverse()].join(">");
    candidates.push({
      level: index + 1,
      skeletonSignature: cache.subtreeSignature(ancestor),
      locatorFromRoot: path,
      textShareOfRegion: Math.round((cache.textLength(ancestor) / regionText) * 100) / 100,
      ...(cache.rootHint(ancestor) ? { rootHint: cache.rootHint(ancestor) } : {}),
    });
  }
  return candidates;
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
  const scope = cache.regionScope(input.element);
  let region = scope.region ?? undefined;
  let landmark = region ? cache.landmark(region) : undefined;
  const elementDigest = cache.spend(cache.subtreeSize(input.element))
    ? structuralDigest(input.element)
    : undefined;
  let regionEvidence =
    elementDigest !== undefined && region && landmark && !landmark.tooDeep
      ? cache.getRegionEvidence(region)
      : undefined;
  // Page-scoped, like an element with no landmark, and no ladder: a landmark under
  // dozens of landmarks (generated or hostile markup), or a page whose evidence
  // work is spent.
  const unjudgeable = elementDigest === undefined || (region !== undefined && !regionEvidence);
  if (unjudgeable) {
    region = undefined;
    landmark = undefined;
    regionEvidence = undefined;
  }
  const role = region ? regionRole(region)! : "unknown";
  const nesting = landmark ? landmark.nesting : "unknown";
  const ancestorContext = landmark ? landmark.ancestorContext : "unknown";
  // An article header is content, not site chrome. Unknown DOM ancestry remains
  // deliberately page-scoped rather than becoming a speculative component.
  const regionSkeleton = regionEvidence?.skeleton ?? tag(input.element);
  const elementSkeleton =
    elementDigest ?? componentHash(`${tag(input.element)}${stableAttributes(input.element)}`);
  // Ordered most-specific first, so the recorded reason names the actual cause
  // rather than whichever test happened to run first.
  const contentNested =
    region !== undefined &&
    (nesting === "article" || nesting === "main" || scope.below !== undefined);
  const uncertainReason: ComponentOccurrence["uncertainReason"] = !region
    ? "no-region"
    : contentNested
      ? "content-nested"
      : role === "main"
        ? "region-main"
        : undefined;
  const groupable = uncertainReason === undefined;
  const regionStructure = regionSkeleton;
  const elementStructure = elementSkeleton;
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

  // Two cases the rule genuinely cannot judge from one page: an element inside
  // `main`, and a page with no landmarks at all. Both get a ladder so the
  // report stage can decide. A landmark occurrence keeps exactly the evidence
  // it has today, and an article-nested one stays page-scoped.
  const candidates =
    uncertainReason === "region-main" && region
      ? subtreeCandidates(input.element, region, cache)
      : uncertainReason === "no-region" && !unjudgeable
        ? subtreeCandidates(input.element, cache.ladderRoot(input.element), cache)
        : [];

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
    ...(candidates.length > 0 ? { subtreeCandidates: candidates } : {}),
    element: {
      // The region slot separates two otherwise-identical footer/navigation
      // instances on one page without making a page-layout path part of family.
      locator: region
        ? `${regionEvidence!.slot}>${elementPath(region, input.element, cache)}`
        : elementPath(cache.rootOf(input.element), input.element, cache),
      structuralSignature: componentHash(elementStructure),
    },
    defect: { kind: input.kind, values: input.values, valueHashes },
  };
}
