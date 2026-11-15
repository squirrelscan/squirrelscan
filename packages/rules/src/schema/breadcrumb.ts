// schema/breadcrumb - BreadcrumbList schema validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { flattenJsonLdNodes, indexJsonLdIds, resolveJsonLdRef } from "@squirrelscan/utils";

import { UNREADABLE_MESSAGE, jsonLdTypes, microdataAndRdfaTypes, typeNames } from "./markup-types";

/**
 * Markup-derived anchors in the breadcrumbs section before a missing schema is a
 * finding. Two, not one: a single link is what one mislabelled anchor looks like,
 * and a real trail (`Home / Docs / Security`) has at least a root link and a parent.
 * Anchors the page classifier's model placed in the section (`sectionSource` of
 * "model") never count: one model guess is not proof the page shows a trail (repo#3365).
 */
const MIN_TRAIL_LINKS = 2;

export const breadcrumbSchemaRule: Rule = {
  meta: {
    id: "schema/breadcrumb",
    name: "Breadcrumb Schema",
    description: "Checks for BreadcrumbList schema on non-homepage",
    solution:
      "BreadcrumbList schema shows navigation path in search results. Structure: BreadcrumbList with itemListElement array of ListItem. Each ListItem needs position (1, 2, 3...), name, and item (URL). The last item (current page) doesn't need a URL. Breadcrumbs help users understand site structure and improve click-through rates.",
    category: "schema",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const url = new URL(ctx.page.url);

    // Skip homepage
    if (url.pathname === "/" || url.pathname === "") {
      checks.push({
        name: "breadcrumb-schema",
        status: "info",
        message: "Homepage - breadcrumbs not typically needed",
      });
      return { checks };
    }

    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let breadcrumbSchema: Record<string, unknown> | null = null;
    const pageNodes: Record<string, unknown>[] = [];

    // Every flattened node of every script, for the nested BreadcrumbList lookup below.
    const allNodes: Record<string, unknown>[] = [];

    for (const script of schemaScripts) {
      // Flattened per script, so a Yoast / Rank Math `@graph` wrapper is
      // descended into rather than read as one typeless node (#317). Per
      // SCRIPT and not over the joined `schema.raw`, because that join can
      // mis-split a pretty-printed block (#1099). Unparseable JSON yields an
      // empty list, which is what the old try/catch was for.
      const schemas = flattenJsonLdNodes(script.textContent || "");
      pageNodes.push(...schemas);

      for (const schema of schemas) {
        allNodes.push(schema);
        // Bare names: `https://schema.org/BreadcrumbList` is the same type, as a
        // string or inside an array.
        if (typeNames(schema["@type"]).some((name) => name.toLowerCase() === "breadcrumblist")) {
          breadcrumbSchema = schema;
          break;
        }
      }
    }

    if (!breadcrumbSchema) {
      // Anchors the classifier's rules placed in the breadcrumbs section show a trail
      // that no structured data describes (#2307). A model-only placement is not
      // counted (repo#3365), and with the classifier off no link carries a section,
      // so both stay the info check.
      const trailLinks = (ctx.parsed.links ?? []).filter(
        (link) => link.section === "breadcrumbs" && link.sectionSource !== "model",
      ).length;
      if (trailLinks >= MIN_TRAIL_LINKS) {
        // A trail declared nested in another node (`WebPage.breadcrumb`), or marked
        // up as microdata or RDFa (older themes), is described, just not as a
        // top-level JSON-LD node, so it is not this finding. Scanned only here: a
        // page with no trail link never pays for the walk.
        const isBreadcrumb = (name: string): boolean => name.toLowerCase() === "breadcrumblist";
        const nested = jsonLdTypes(allNodes);
        const markup = microdataAndRdfaTypes(doc);
        if (!nested.types.some(isBreadcrumb) && !markup.types.some(isBreadcrumb)) {
          // A scan that hit a bound proves nothing about what is absent.
          if (!nested.complete || !markup.complete) {
            checks.push({
              name: "breadcrumb-schema",
              status: "info",
              message: UNREADABLE_MESSAGE,
              details: { trailLinks, inconclusive: true },
            });
            return { checks };
          }
          checks.push({
            name: "breadcrumb-schema",
            status: "fail",
            message: "A breadcrumb trail on the page has no BreadcrumbList schema",
            value: "Add BreadcrumbList JSON-LD that mirrors the trail",
            details: { trailLinks },
          });
          return { checks };
        }
      }
      checks.push({
        name: "breadcrumb-schema",
        status: "info",
        message: "No BreadcrumbList schema found",
        value: "Consider adding for non-homepage",
      });
      return { checks };
    }

    // Check itemListElement
    const items = breadcrumbSchema["itemListElement"];
    if (!items || !Array.isArray(items) || items.length === 0) {
      checks.push({
        name: "breadcrumb-items",
        status: "warn",
        message: "BreadcrumbList has no items",
      });
      return { checks };
    }

    // pub#869: a ListItem may be a node reference (`{"@id": …}`) to a node
    // elsewhere on the page; read the node it names. A dangling reference, a
    // null or a string is judged as written: an item with no position or name.
    const ids = indexJsonLdIds(pageNodes, ctx.page.url);

    // Validate items
    let hasValidItems = true;
    let lastPosition = 0;

    for (const entry of items as unknown[]) {
      const resolved = resolveJsonLdRef(entry, ids, ctx.page.url);
      const item =
        resolved && typeof resolved === "object" && !Array.isArray(resolved)
          ? (resolved as Record<string, unknown>)
          : {};
      const position = item["position"];
      const name = item["name"];

      if (!position || !name) {
        hasValidItems = false;
      }

      if (typeof position === "number" && position !== lastPosition + 1) {
        checks.push({
          name: "breadcrumb-order",
          status: "warn",
          message: "Breadcrumb positions not sequential",
        });
      }
      lastPosition = position as number;
    }

    if (hasValidItems) {
      checks.push({
        name: "breadcrumb-valid",
        status: "pass",
        message: `BreadcrumbList has ${items.length} item(s)`,
      });
    } else {
      checks.push({
        name: "breadcrumb-items",
        status: "warn",
        message: "Some breadcrumb items missing position or name",
      });
    }

    return { checks };
  },
};
