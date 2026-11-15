// ax/commerce-readiness - can a shopping agent compare and buy from this shop?
//
// A page rule gated to ecommerce and marketplace sites (`appliesWhen`). Where the Stage-0 profile says
// the site is not a shop, the runner emits one skipped check (it folds across pages) and `run()` never
// executes. `[rule_options."ax/commerce-readiness"] applies = "on" | "off"` overrides detection.
//
// Offer completeness is judged from the page's own structured data (JSON-LD, microdata, RDFa), so it
// reads the same markup as `schema/product`. Feed and checkout-manifest detection is advisory: those
// checks are `info` and never reach the score.

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import {
  collectNestedNodes,
  hasType,
  htmlReadState,
  isFilled,
  makeRefResolver,
  readMicrodata,
  readRdfa,
  type StructuredNode,
} from "../shared/structured-nodes";
import {
  filledAny,
  offersOf,
  priceFilled,
  productAndVariants,
  PRODUCT_TYPES,
  values,
  type Resolve,
} from "../schema/product-evidence";
import { flattenJsonLdNodes } from "@squirrelscan/utils";

export const OFFER_FIELDS = [
  "price",
  "currency",
  "availability",
  "shipping",
  "returns",
  "identifier",
] as const;
export type OfferField = (typeof OFFER_FIELDS)[number];

const FIELD_LABELS: Record<OfferField, string> = {
  price: "price",
  currency: "price currency",
  availability: "availability",
  shipping: "shipping details",
  returns: "return policy",
  identifier: "product identifier (GTIN, MPN or SKU)",
};

const IDENTIFIER_PROPS = ["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "mpn", "sku", "productID"];

export type FieldState = "present" | "absent" | "unknown";

function currencyFilled(offer: StructuredNode, resolve: Resolve): boolean {
  if (isFilled(offer["priceCurrency"])) return true;
  return values(offer, "priceSpecification", resolve).some(
    (spec) =>
      !!spec && typeof spec === "object" && isFilled((spec as StructuredNode)["priceCurrency"]),
  );
}

/** A return policy on the offer or product, or a MerchantReturnPolicy anywhere on the page (organization level). */
function returnsFilled(
  members: StructuredNode[],
  offers: StructuredNode[],
  allNodes: StructuredNode[],
  resolve: Resolve,
): boolean {
  for (const node of [...offers, ...members]) {
    if (filledAny(values(node, "hasMerchantReturnPolicy", resolve))) return true;
  }
  return allNodes.some(
    (n) =>
      hasType(n, "MerchantReturnPolicy") ||
      filledAny(values(n, "hasMerchantReturnPolicy", resolve)),
  );
}

/** Per-field state for one product node. Pure over parsed structured data. */
export function offerFieldStates(
  product: StructuredNode,
  allNodes: StructuredNode[],
  resolve: Resolve,
): Record<OfferField, FieldState> {
  const members = productAndVariants(product, resolve);
  const offers = members.flatMap((m) => offersOf(m, resolve));
  const some = (test: (o: StructuredNode) => boolean): FieldState =>
    offers.some(test) ? "present" : "absent";
  const hasProp = (prop: string) => (o: StructuredNode) => filledAny(values(o, prop, resolve));
  return {
    price: some((o) => priceFilled(o, resolve)),
    currency: some((o) => currencyFilled(o, resolve)),
    availability: some(hasProp("availability")),
    shipping:
      some(hasProp("shippingDetails")) === "present" || allNodes.some(hasProp("shippingDetails"))
        ? "present"
        : "absent",
    returns: returnsFilled(members, offers, allNodes, resolve) ? "present" : "absent",
    identifier: members.some((m) => IDENTIFIER_PROPS.some((p) => isFilled(m[p])))
      ? "present"
      : "absent",
  };
}

const MAX_LINK_ELEMENTS = 2000;
const MAX_HREF_CHARS = 512;

// Agent checkout manifests: detect and inform only, the standards are still competing.
const MANIFEST_PATH = /\/\.well-known\/(ucp|acp\.json|agentic-commerce)(\/|$)/i;
const FEED_PATH =
  /(?:^|\/)(?:(?:products?|merchant|shopping)[-_]?feeds?|google[-_]?(?:shopping|merchant)[\w-]{0,40}|products\.(?:xml|json|csv))(?:\.\w{1,5})?\/?$/i;

function pathOf(href: string): string | null {
  const raw = href.trim().slice(0, MAX_HREF_CHARS);
  if (raw === "") return null;
  try {
    return new URL(raw, "https://placeholder.invalid/").pathname;
  } catch {
    return null;
  }
}

/** Manifest and feed URLs this page links to. Bounded scan, no network. */
export function findCommerceLinks(doc: Document): { manifests: string[]; feeds: string[] } {
  const manifests = new Set<string>();
  const feeds = new Set<string>();
  const els = Array.from(doc.querySelectorAll("link[href], a[href]")).slice(0, MAX_LINK_ELEMENTS);
  for (const el of els) {
    const href = el.getAttribute("href") ?? "";
    const path = pathOf(href);
    if (!path) continue;
    if (MANIFEST_PATH.test(path)) manifests.add(href.trim().slice(0, MAX_HREF_CHARS));
    else if (FEED_PATH.test(path)) feeds.add(href.trim().slice(0, MAX_HREF_CHARS));
  }
  return { manifests: [...manifests].slice(0, 10), feeds: [...feeds].slice(0, 10) };
}

export const commerceReadinessRule: Rule = {
  meta: {
    id: "ax/commerce-readiness",
    name: "Commerce Readiness",
    description:
      "Checks that product pages declare what a shopping agent needs to compare and buy: price and currency, availability, shipping details, a return policy and a product identifier. Also notes product feeds and agent checkout manifests linked from the page",
    solution:
      "Add the missing fields to the page's Product structured data: an Offer with price, priceCurrency and availability, shippingDetails (OfferShippingDetails), hasMerchantReturnPolicy (MerchantReturnPolicy) and a gtin, mpn or sku. Feed and checkout manifest findings are informational only: publish one if you want agents to buy without scraping, and keep it consistent with the pages.",
    category: "ax",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 3,
    // Shops only. Detection can be wrong: `applies = "on"` or `"off"` in [rule_options] overrides it.
    appliesWhen: { siteTypes: ["ecommerce", "marketplace"] },
    optionsSchema: z.object({
      applies: z.enum(["auto", "on", "off"]).default("auto"),
    }),
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks };

    const links = findCommerceLinks(doc);
    if (links.feeds.length > 0) {
      checks.push({
        name: "commerce-feed",
        status: "info",
        message: `Product feed linked from this page (${links.feeds.length})`,
        items: links.feeds.map((f) => ({ id: f, label: f })),
      });
    }
    if (links.manifests.length > 0) {
      checks.push({
        name: "commerce-manifest",
        status: "info",
        message: `Agent checkout manifest linked from this page (${links.manifests.length}). Detected only, not validated`,
        items: links.manifests.map((m) => ({ id: m, label: m })),
      });
    }

    const jsonLd: StructuredNode[] = [];
    let primary: StructuredNode | null = null;
    for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
      const nodes = flattenJsonLdNodes(script.textContent || "");
      jsonLd.push(...nodes);
      if (!primary) primary = nodes.find((n) => hasType(n, ...PRODUCT_TYPES)) ?? null;
    }
    const micro = readMicrodata(doc);
    const rdfa = readRdfa(doc);
    const candidate =
      primary ??
      micro.nodes.find((n) => hasType(n, ...PRODUCT_TYPES)) ??
      rdfa.nodes.find((n) => hasType(n, ...PRODUCT_TYPES)) ??
      null;

    if (!candidate) {
      checks.push({
        name: "offer-completeness",
        status: "info",
        message: "No Product markup on this page, so offer completeness was not judged",
      });
      return { checks };
    }

    const allNodes = [...jsonLd, ...micro.nodes, ...rdfa.nodes];
    const withNested = [...allNodes, ...collectNestedNodes(allNodes)];
    const resolve = makeRefResolver(withNested, ctx.page.url);
    const states = offerFieldStates(candidate, withNested, resolve);

    // An absent field is only proven absent from a complete, supported read.
    const readable = htmlReadState(ctx) === "complete" && !micro.unsupported && !rdfa.unsupported;
    const missing = OFFER_FIELDS.filter((f) => states[f] === "absent");

    if (missing.length === 0) {
      checks.push({
        name: "offer-completeness",
        status: "pass",
        message:
          "Offer declares price, currency, availability, shipping, returns and an identifier",
      });
    } else if (!readable) {
      checks.push({
        name: "offer-completeness",
        status: "info",
        message: `Offer completeness not fully checked: the page was not read completely (${missing.length} field(s) not found)`,
        items: missing.map((f) => ({ id: f, label: FIELD_LABELS[f] })),
      });
    } else {
      checks.push({
        name: "offer-completeness",
        status: "warn",
        message: `Offer is missing ${missing.length} of ${OFFER_FIELDS.length} fields a shopping agent needs`,
        items: missing.map((f) => ({ id: f, label: FIELD_LABELS[f] })),
      });
    }
    return { checks };
  },
};
