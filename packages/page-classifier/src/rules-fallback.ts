// The deterministic path. The MODEL is primary and this is the fallback, used when the artifact is missing, invalid or built for
// another featurizer version, when a prediction is below threshold, or when the
// time budget is spent.
//
// It produces the same output contract as the model, so a consumer never
// branches on `source` except to display it. A missing model degrades
// attribution; it never changes whether a finding is detected.
//
// This is the same reading of the markup the training labels were derived from,
// minus the parts that only make sense across a whole dataset. It runs on one
// page inside the CLI.

import type { NodeFeatures } from "./featurize";
import { SECTIONING_TAGS } from "./featurize";

export type RegionLabel =
  | "site_header"
  | "footer"
  | "navigation"
  | "sidebar"
  | "main_content"
  | "content_block"
  | "article_chrome"
  | "form"
  | "search"
  | "dialog"
  /** Header, footer, navigation or sidebar, when the model is sure of the group but not of which
   *  (region-groups.ts). Never produced by the rules path. */
  | "site_chrome"
  | "unknown";

/** The 11 classes the model head emits, plus "unknown" for the rules path.
 *
 * `legal` and `pricing` are model-only: no schema.org type maps to either, so
 * the deterministic path can never produce them. That gap is exactly why the
 * page-type head is trained on curated labels instead of schema-derived ones --
 * many schema-less pages are legal or pricing. */
export type PageTypeLabel =
  | "article"
  | "listing_index"
  | "docs"
  | "product_detail"
  | "about"
  | "contact"
  | "legal"
  | "pricing"
  | "homepage"
  | "product_listing"
  | "other"
  | "unknown";

const ROLE_REGION: Record<string, RegionLabel> = {
  banner: "site_header",
  contentinfo: "footer",
  navigation: "navigation",
  complementary: "sidebar",
  main: "main_content",
  search: "search",
  form: "form",
  dialog: "dialog",
  alertdialog: "dialog",
};

const TAG_REGION: Record<string, RegionLabel> = {
  nav: "navigation",
  aside: "sidebar",
  main: "main_content",
  search: "search",
  form: "form",
  dialog: "dialog",
};

/**
 * The region a node's own markup declares, or "unknown".
 *
 * `<header>` and `<footer>` are decided by nesting, as the training labels decide
 * them: inside sectioning content they are that section's own chrome, not the site's.
 */
/**
 * Does this node declare its own region, as opposed to inheriting one?
 *
 * An explicit ARIA landmark role or a landmark tag ON THE NODE ITSELF is a
 * statement by the page author, and the runtime treats it as ground truth
 * rather than asking the model to second-guess it.
 */
export function declaresOwnRegion(node: NodeFeatures): boolean {
  if (ROLE_REGION[node.role]) return true;
  if (TAG_REGION[node.tag]) return true;
  return node.tag === "header" || node.tag === "footer";
}

export function ruleRegion(
  node: NodeFeatures,
  byId: ReadonlyMap<number, NodeFeatures>,
): RegionLabel {
  const role = ROLE_REGION[node.role];
  if (role) return role;
  const tag = TAG_REGION[node.tag];
  if (tag) return tag;
  if (node.tag === "header" || node.tag === "footer") {
    return hasSectioningAncestor(node, byId)
      ? "article_chrome"
      : node.tag === "header"
        ? "site_header"
        : "footer";
  }
  // Containment: a non-landmark inside <main> is a block of the page's content.
  let current = byId.get(node.parentCandidateId);
  let guard = 0;
  while (current && guard++ < 256) {
    const parentRole = ROLE_REGION[current.role] ?? TAG_REGION[current.tag];
    if (parentRole === "main_content") return "content_block";
    if (parentRole) return "unknown";
    if (current.tag === "header" || current.tag === "footer") return "unknown";
    current = byId.get(current.parentCandidateId);
  }
  return "unknown";
}

function hasSectioningAncestor(
  node: NodeFeatures,
  byId: ReadonlyMap<number, NodeFeatures>,
): boolean {
  let current = byId.get(node.parentCandidateId);
  let guard = 0;
  while (current && guard++ < 256) {
    if (SECTIONING_TAGS.has(current.tag)) return true;
    current = byId.get(current.parentCandidateId);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Page type
// ---------------------------------------------------------------------------

const SCHEMA_TYPE_MAP: Record<string, PageTypeLabel> = {
  article: "article",
  newsarticle: "article",
  blogposting: "article",
  liveblogposting: "article",
  report: "article",
  scholarlyarticle: "article",
  techarticle: "docs",
  apireference: "docs",
  howto: "docs",
  product: "product_detail",
  productgroup: "product_detail",
  individualproduct: "product_detail",
  vehicle: "product_detail",
  aboutpage: "about",
  contactpage: "contact",
  collectionpage: "listing_index",
  blog: "listing_index",
  itemlist: "listing_index",
  faqpage: "other",
  qapage: "other",
  profilepage: "other",
  searchresultspage: "other",
};

const OG_TYPE_MAP: Record<string, PageTypeLabel> = {
  article: "article",
  book: "article",
  product: "product_detail",
  "product.item": "product_detail",
  "product.group": "product_detail",
};

interface SchemaDocument {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
  querySelectorAll(selector: string): Iterable<{
    textContent: string | null;
    getAttribute(name: string): string | null;
  }>;
}

/**
 * Page type from the page's own structured data, or from the URL for the one
 * case that is genuinely a URL rule.
 *
 * `homepage` comes from the URL here: the path being "/" (or the root
 * `/index.html` document, see {@link isRootPath}) is a rule that can simply be stated. The artifact's page-type head also has a `homepage` class,
 * but predict.ts never returns it for a non-root URL (selectPageType picks the
 * best other class, or falls back to this function), so no non-root page is
 * ever labelled `homepage`, from the model or from the rules.
 */
export function rulePageType(document: SchemaDocument, url: string): PageTypeLabel {
  const types = new Set<string>();
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = (script.textContent ?? "").trim();
    if (!raw) continue;
    try {
      collectTypes(JSON.parse(raw), types, 0);
    } catch {
      // Malformed JSON-LD is common and is not a signal either way.
    }
  }
  const classes = new Set<PageTypeLabel>();
  for (const type of types) {
    const mapped = SCHEMA_TYPE_MAP[type];
    if (mapped) classes.add(mapped);
  }
  if (classes.size > 1) classes.delete("other");
  if (classes.has("listing_index") && classes.has("product_detail")) {
    // A CollectionPage of Products. The model has no such class (14 training
    // pages), so the rule reports the listing rather than inventing one.
    classes.delete("product_detail");
  }
  if (classes.size === 1) return [...classes][0]!;

  if (isRootPath(url) && (types.has("website") || types.has("organization"))) return "homepage";

  const og = (document.querySelector('meta[property="og:type"]')?.getAttribute("content") ?? "")
    .trim()
    .toLowerCase();
  const fromOg = OG_TYPE_MAP[og];
  if (fromOg) return fromOg;
  if (isRootPath(url)) return "homepage";
  return "unknown";
}

/**
 * The one root document name that is the site's home page (pub#902). Measured on 628 live sites
 * that serve a document there (`/` against `/index.html`, hosts that answer any path with the home
 * page excluded): the page was the same page as `/` on 558, 0.889 (lower 95% bound 0.862); setting
 * aside 38 blank or error answers (5 error titles, 33 near-empty), 558 of 590, 0.946 (lower bound
 * 0.924). The bar the issue set was 0.90, so this is a judgement call, recorded on #902. `index.htm`, `index.php`, `default.*` and `home.*`
 * did not clear 0.90 (index.php 0.79, index.htm 0.52, the rest 0.0 to 0.5), so they stay
 * as they were. The match is exact and case-sensitive, like the sample.
 */
const ROOT_DOCUMENT_PATH = "/index.html";

/** True for "/", an empty path and the root `/index.html` document. Exported because
 *  predict.ts applies the homepage rule ahead of the model, not only as a fallback. */
export function isRootPath(url: string): boolean {
  try {
    // The platform parser normalizes backslashes for special schemes before
    // exposing the path, matching how browsers interpret those URLs. The query and
    // the fragment are not part of the path.
    const path = new URL(url).pathname;
    return path === "/" || path === ROOT_DOCUMENT_PATH;
  } catch {
    return false;
  }
}

const NESTED_KEYS = ["@graph", "mainentity", "mainentityofpage", "about", "itemlistelement"];

function collectTypes(value: unknown, into: Set<string>, depth: number): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 50)) collectTypes(entry, into, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (lower === "@type" || lower === "type") {
      const list =
        typeof entry === "string"
          ? [entry]
          : Array.isArray(entry)
            ? entry.filter((v): v is string => typeof v === "string")
            : [];
      for (const type of list) into.add((type.split(/[/#:]/).pop() ?? type).trim().toLowerCase());
      continue;
    }
    if (NESTED_KEYS.includes(lower)) collectTypes(entry, into, depth + 1);
  }
}
