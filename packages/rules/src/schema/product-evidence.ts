// schema/product: per-field evidence for the machine-readable product content
// (name, description, image, price, availability), read from the raw HTML
// already in the rule context. A field is `present`, `absent` or `unknown`:
// `absent` is only said when the product was read completely, so a truncated
// read, a JavaScript-only shell or an unfollowed reference never counts as a
// missing field.

import type { CheckResult, RuleContext } from "../types";

import {
  asList,
  collectNestedNodes,
  hasType,
  htmlReadState,
  isDanglingRef,
  isFilled,
  makeRefResolver,
  readMicrodata,
  readRdfa,
  visibleText,
  type EvidenceSource,
  type ReadState,
  type StructuredNode,
  type UnknownReason,
} from "../shared/structured-nodes";

export const PRODUCT_FIELDS = ["name", "description", "image", "price", "availability"] as const;
export type ProductField = (typeof PRODUCT_FIELDS)[number];

export interface FieldEvidence {
  field: ProductField;
  status: "present" | "absent" | "unknown";
  source?: EvidenceSource;
  reason?: UnknownReason;
}

export interface ProductEvidence {
  read: ReadState;
  /** The representations a product was found in. */
  sources: EvidenceSource[];
  fields: FieldEvidence[];
  /** Whether any Offer was found (so `offers` itself is not missing). */
  hasOffers: boolean;
}

interface Candidate {
  source: EvidenceSource;
  node: StructuredNode;
}

const PRODUCT_TYPES = ["Product", "ProductGroup"];
const MAX_VARIANTS = 200;

type Resolve = (value: unknown) => unknown;

/** A direct property, as a list of resolved values. */
function values(node: StructuredNode, prop: string, resolve: Resolve): unknown[] {
  return asList(node[prop]).map(resolve);
}

function filledAny(list: unknown[]): boolean {
  return list.some((v) => !isDanglingRef(v) && isFilled(v));
}

/** `image`: a URL string, or an ImageObject carrying `url` or `contentUrl`. */
function imageFilled(list: unknown[]): boolean {
  return list.some((v) => {
    if (typeof v === "string") return v.trim() !== "";
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as StructuredNode;
      return isFilled(o["url"]) || isFilled(o["contentUrl"]) || isFilled(o["@id"]) && !isDanglingRef(o);
    }
    return false;
  });
}

/** Every Offer reachable from a node, through AggregateOffer nesting and references. */
function offersOf(node: StructuredNode, resolve: Resolve): StructuredNode[] {
  const out: StructuredNode[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4) return;
    for (const raw of asList(value)) {
      const offer = resolve(raw);
      if (!offer || typeof offer !== "object" || Array.isArray(offer) || seen.has(offer)) continue;
      seen.add(offer);
      out.push(offer as StructuredNode);
      visit((offer as StructuredNode)["offers"], depth + 1);
    }
  };
  visit(node["offers"], 0);
  return out;
}

/** A price is declared by `price`, `lowPrice`, or a `priceSpecification` carrying one. A price of 0 is declared. */
function priceFilled(offer: StructuredNode, resolve: Resolve): boolean {
  if (filledAny([offer["price"], offer["lowPrice"], offer["highPrice"]].filter((v) => v !== undefined))) return true;
  return values(offer, "priceSpecification", resolve).some(
    (spec) => !!spec && typeof spec === "object" && isFilled((spec as StructuredNode)["price"]),
  );
}

/** The product plus, for a ProductGroup, its variants (resolved, bounded). */
function productAndVariants(node: StructuredNode, resolve: Resolve): StructuredNode[] {
  const out: StructuredNode[] = [node];
  for (const raw of values(node, "hasVariant", resolve)) {
    if (out.length > MAX_VARIANTS) break;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) out.push(raw as StructuredNode);
  }
  return out;
}

type Found = "yes" | "no" | "dangling";

function lookup(field: ProductField, members: StructuredNode[], resolve: Resolve): Found {
  let dangling = false;
  for (const member of members) {
    if (field === "price" || field === "availability") {
      for (const offer of offersOf(member, resolve)) {
        if (field === "price" ? priceFilled(offer, resolve) : filledAny(values(offer, "availability", resolve))) return "yes";
      }
      if (asList(member["offers"]).some((o) => isDanglingRef(resolve(o)))) dangling = true;
      continue;
    }
    const list = values(member, field, resolve);
    if (field === "image" ? imageFilled(list) : filledAny(list)) return "yes";
    if (list.some(isDanglingRef)) dangling = true;
  }
  return dangling ? "dangling" : "no";
}

/** An empty JavaScript shell: almost no visible text and scripts that would fill it. */
function looksLikeJsShell(doc: Document): boolean {
  return visibleText(doc).length < 200 && doc.querySelectorAll("script").length > 0;
}

/** Signals that the page is a product page whose markup is built by script. */
function productSignals(ctx: RuleContext, doc: Document): boolean {
  const type = doc.querySelector('meta[property="og:type"]')?.getAttribute("content") ?? "";
  if (/^(og:)?product/i.test(type.trim())) return true;
  if (doc.querySelector('meta[property^="product:"], meta[property^="og:price"]')) return true;
  const st = ctx.siteMetadata?.siteType;
  if (st === "ecommerce" || st === "marketplace") return true;
  return false;
}

function scriptBuildsProduct(doc: Document): boolean {
  for (const s of Array.from(doc.querySelectorAll("script:not([type='application/ld+json'])"))) {
    const t = s.textContent ?? "";
    if (t.length > 0 && t.length < 500_000 && /schema\.org\/Product(?:Group)?\b/.test(t)) return true;
  }
  return false;
}

/**
 * Evidence for the page's product, or null when it has none and no sign that
 * script would add one (the caller keeps its "No Product schema found").
 */
export function readProductEvidence(
  ctx: RuleContext,
  jsonLdNodes: StructuredNode[],
  jsonLdPrimary: StructuredNode | null,
): ProductEvidence | null {
  const doc = ctx.parsed.document;
  if (!doc) return null;
  const read = htmlReadState(ctx);

  const candidates: Candidate[] = [];
  if (jsonLdPrimary) candidates.push({ source: "json-ld", node: jsonLdPrimary });

  const micro = readMicrodata(doc);
  const rdfa = readRdfa(doc);
  for (const n of micro.nodes) if (hasType(n, ...PRODUCT_TYPES)) candidates.push({ source: "microdata", node: n });
  for (const n of rdfa.nodes) if (hasType(n, ...PRODUCT_TYPES)) candidates.push({ source: "rdfa", node: n });

  const allNodes = [...jsonLdNodes, ...collectNestedNodes(jsonLdNodes)];
  const resolve = makeRefResolver(allNodes, ctx.page.url);

  if (candidates.length === 0) {
    // No product in any supported representation. Evidence only when script is
    // likely to build one: then every field is unknown, not missing.
    const rendered = !ctx.page.rendered && read === "complete";
    const shell = rendered && productSignals(ctx, doc) && looksLikeJsShell(doc);
    if (!(shell || (rendered && scriptBuildsProduct(doc)))) return null;
    return {
      read,
      sources: [],
      hasOffers: false,
      fields: PRODUCT_FIELDS.map((field) => ({ field, status: "unknown" as const, reason: "rendered-only" as const })),
    };
  }

  const sources = [...new Set(candidates.map((c) => c.source))];
  const unsupported = micro.unsupported || rdfa.unsupported;
  let hasOffers = false;
  const fields: FieldEvidence[] = PRODUCT_FIELDS.map((field) => {
    let dangling = false;
    for (const { source, node } of candidates) {
      const members = productAndVariants(node, resolve);
      const found = lookup(field, members, resolve);
      if (found === "yes") return { field, status: "present" as const, source };
      if (found === "dangling") dangling = true;
    }
    if (dangling) return { field, status: "unknown" as const, reason: "unresolved-reference" as const };
    if (read !== "complete") return { field, status: "unknown" as const, reason: "incomplete-read" as const };
    if (unsupported) return { field, status: "unknown" as const, reason: "unsupported" as const };
    return { field, status: "absent" as const };
  });
  for (const { node } of candidates) {
    if (productAndVariants(node, resolve).some((m) => offersOf(m, resolve).length > 0)) hasOffers = true;
  }
  return { read, sources, fields, hasOffers };
}

function describe(f: FieldEvidence): string {
  if (f.status === "present") return `present (${f.source})`;
  if (f.status === "absent") return "absent";
  return `unknown (${f.reason})`;
}

/**
 * The informational per-field check. It never warns or fails: the existing
 * `product-required` and `product-offer-details` checks own the missing-field
 * findings, and this one says what was observed and where it was read.
 */
export function fieldEvidenceCheck(evidence: ProductEvidence): CheckResult {
  const counts = { present: 0, absent: 0, unknown: 0 };
  for (const f of evidence.fields) counts[f.status]++;
  return {
    name: "product-field-evidence",
    status: "info",
    message: `Product fields: ${counts.present} present, ${counts.absent} absent, ${counts.unknown} unknown`,
    items: evidence.fields.map((f) => ({ id: f.field, label: describe(f) })),
    details: {
      read: evidence.read,
      sources: evidence.sources,
      fields: Object.fromEntries(
        evidence.fields.map((f) => [f.field, { status: f.status, source: f.source, reason: f.reason }]),
      ),
    },
  };
}
