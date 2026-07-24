// schema/local-business - LocalBusiness schema validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { LOCAL_BUSINESS_TYPES, type LocalBusinessType } from "@squirrelscan/utils/constants";
import { flattenJsonLdNodes } from "@squirrelscan/utils";

// "address" is intentionally NOT required here — service-area businesses
// (#700) legitimately have no public street address; the address-vs-areaServed
// check below handles that requirement instead.
const REQUIRED_PROPS = ["name"];
const RECOMMENDED_PROPS = ["telephone", "openingHours", "image", "priceRange"];

function isLocalBusinessType(type: unknown): boolean {
  if (typeof type === "string") return LOCAL_BUSINESS_TYPES.includes(type as LocalBusinessType);
  return (
    Array.isArray(type) && type.some((t) => LOCAL_BUSINESS_TYPES.includes(t as LocalBusinessType))
  );
}

// A node with descriptive fields carries its own data; a bare `{"@id": ...}`
// is only a reference and must be resolved against the flattened graph
// before it counts — otherwise a dangling/wrong-type reference would pass.
function hasOwnDescriptiveFields(node: Record<string, unknown>): boolean {
  return Boolean(
    node["name"] ||
    node["geoRadius"] ||
    node["geoMidpoint"] ||
    node["address"] ||
    node["postalCode"] ||
    // GeoShape geometry forms (Google-documented SAB markup)
    node["polygon"] ||
    node["circle"] ||
    node["box"] ||
    node["line"],
  );
}

function resolveAreaServedNode(
  node: Record<string, unknown>,
  idMap: Map<string, Record<string, unknown>>,
  seen: Set<string> = new Set(),
): Record<string, unknown> | null {
  if (hasOwnDescriptiveFields(node)) return node;
  const id = node["@id"];
  if (typeof id !== "string" || seen.has(id)) return null;
  seen.add(id);
  const referenced = idMap.get(id);
  return referenced ? resolveAreaServedNode(referenced, idMap, seen) : null;
}

// A service-area declaration (areaServed / legacy serviceArea) may be plain
// text ("Sydney NSW"), an array of either, a structured Place / GeoShape /
// AdministrativeArea node, or an `@id` reference to one elsewhere in the
// @graph — accept all forms per Google's SAB guidance (#700).
function hasServiceArea(value: unknown, idMap: Map<string, Record<string, unknown>>): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((v) => hasServiceArea(v, idMap));
  if (typeof value === "object") {
    // resolveAreaServedNode only returns nodes that already carry descriptive fields
    return resolveAreaServedNode(value as Record<string, unknown>, idMap) != null;
  }
  return false;
}

export const localBusinessSchemaRule: Rule = {
  meta: {
    id: "schema/local-business",
    name: "LocalBusiness Schema",
    description: "Validates LocalBusiness schema for local SEO",
    solution:
      "LocalBusiness schema helps your business appear in local search and Google Maps. Required: name, plus either a full PostalAddress (streetAddress, addressLocality, postalCode) for a storefront, or areaServed for a service-area business (SAB) with no public storefront: Google supports omitting the address when areaServed is declared. Include telephone, openingHours (use OpeningHoursSpecification for complex hours), geo coordinates, and priceRange. Match data with your Google Business Profile.",
    category: "schema",
    scope: "page",
    severity: "warning",
    weight: 6,
    // LocalBusiness schema only applies to real-world local businesses. Skip with
    // a visible reason for global SaaS / blogs. Offline / no-metadata runs as today.
    appliesWhen: { requiresLocalBusiness: true },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    if (!ctx.parsed.document) return { checks: [] };

    // Flattened (handles @graph-wrapped LocalBusiness nodes, e.g. Yoast sites).
    const raw = ctx.parsed.schema.raw;
    const nodes = raw ? flattenJsonLdNodes(raw) : [];
    const businessSchema = nodes.find((node) => isLocalBusinessType(node["@type"])) ?? null;

    if (!businessSchema) {
      checks.push({
        name: "local-business-schema",
        status: "info",
        message: "No LocalBusiness schema found",
      });
      return { checks };
    }

    // Check required properties
    const missing: string[] = [];
    for (const prop of REQUIRED_PROPS) {
      if (!businessSchema[prop]) {
        missing.push(prop);
      }
    }

    if (missing.length > 0) {
      checks.push({
        name: "local-business-required",
        status: "warn",
        message: `LocalBusiness schema missing required properties`,
        items: missing.map((prop) => ({ id: prop })),
      });
    } else {
      checks.push({
        name: "local-business-required",
        status: "pass",
        message: "LocalBusiness schema has required properties",
      });
    }

    // Check address completeness — unchanged from pre-#700 behavior when an
    // address IS present (an informal string address still reports missing
    // structured subfields, same as before this rule accepted areaServed).
    const rawAddress = businessSchema["address"];
    // An empty candidates array (`address: []`) counts as no address (#724) so
    // the SAB location check below offers the address-vs-areaServed guidance.
    const hasAddress = Array.isArray(rawAddress) ? rawAddress.length > 0 : Boolean(rawAddress);
    if (hasAddress) {
      // Some generators wrap the single PostalAddress in an array (#711); unwrap
      // and pass if ANY entry is complete, matching the areaServed `.some()` seam.
      const candidates = Array.isArray(rawAddress) ? rawAddress : [rawAddress];
      const subfields = ["streetAddress", "addressLocality", "postalCode"];
      const missingPerCandidate = candidates.map((candidate) => {
        // Null/non-object entries (e.g. `address: [null]`) count as fully missing.
        if (!candidate || typeof candidate !== "object") return subfields;
        const address = candidate as Record<string, unknown>;
        return subfields.filter((prop) => !address[prop]);
      });

      if (!missingPerCandidate.some((m) => m.length === 0)) {
        const addressMissing = missingPerCandidate[0] ?? subfields;
        checks.push({
          name: "local-business-address",
          status: "warn",
          message: `Address incomplete`,
          items: addressMissing.map((prop) => ({ id: prop })),
        });
      }
    }

    // Address vs service area (#700): a service-area business (SAB) with no
    // public storefront may omit the address if it declares where it operates
    // instead. Only flag when NEITHER is present — offer both paths.
    if (!hasAddress) {
      const idMap = new Map<string, Record<string, unknown>>();
      for (const node of nodes) {
        const id = node["@id"];
        if (typeof id === "string") idMap.set(id, node);
      }

      const areaServed =
        hasServiceArea(businessSchema["areaServed"], idMap) ||
        hasServiceArea(businessSchema["serviceArea"], idMap);

      if (areaServed) {
        checks.push({
          name: "local-business-location",
          status: "pass",
          message:
            "Service-area business detected: areaServed declared, no public address required",
        });
      } else {
        checks.push({
          name: "local-business-location",
          status: "warn",
          message: "LocalBusiness schema has no address or service area",
          value:
            "Storefronts: add a PostalAddress (streetAddress, addressLocality, postalCode). Service-area businesses with no public storefront: add areaServed instead.",
        });
      }
    }

    // Check geo coordinates
    if (!businessSchema["geo"]) {
      checks.push({
        name: "local-business-geo",
        status: "info",
        message: "LocalBusiness missing geo coordinates",
        value: "Add GeoCoordinates for map placement",
      });
    }

    // Check recommended props
    const missingRec = RECOMMENDED_PROPS.filter((p) => !businessSchema![p]);
    if (missingRec.length > 0) {
      checks.push({
        name: "local-business-recommended",
        status: "info",
        message: `LocalBusiness could include recommended properties`,
        items: missingRec.map((prop) => ({ id: prop })),
      });
    }

    return { checks };
  },
};
