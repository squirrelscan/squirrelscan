// Re-emit the collapsed entity map as JSON-LD (#2061).
//
// This is the export a user pastes into a schema validator or hands a CMS
// plugin: one `@graph` member per collapsed node, with the cross-page
// references rewritten as `{"@id": …}`. Nodes the site never gave an `@id` get
// a generated, stable one derived from the site URL.

import type { EntityMap, EntityMapJsonLd, EntityMapNode } from "@squirrelscan/core-contracts/entity-map";

/**
 * FNV-1a over the node key. Only needs to be stable and collision-resistant
 * enough to disambiguate two entities that slugify identically — not
 * cryptographic, and deliberately dependency-free so this file stays portable.
 */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function slugify(value: string): string {
  // The first pass collapses every run of non-alphanumerics to ONE dash, so the
  // trims below need no quantifier. `/^-+|-+$/` here would be a polynomial
  // backtracking risk on a site-controlled name, and this input is exactly that.
  // Clipping before the trims also removes a dash the clip itself introduced.
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-/, "")
    .replace(/-$/, "");
  return slug.length > 0 ? slug : "entity";
}

/**
 * The `@id` a node is published under: its own when the site declared one,
 * otherwise `<site>#entity-<slug>-<hash>`.
 */
function publishedId(node: EntityMapNode, siteUrl: string): string {
  if (node.id) return node.id;
  const label = node.name ?? node.types[0] ?? "entity";
  const fragment = `entity-${slugify(label)}-${shortHash(node.key)}`;
  try {
    const url = new URL(siteUrl);
    url.hash = fragment;
    return url.href;
  } catch {
    return `#${fragment}`;
  }
}

/** Dangling targets are not nodes; their key still carries the raw `@id`. */
function targetId(targetKey: string, byKey: Map<string, EntityMapNode>, siteUrl: string): string {
  const node = byKey.get(targetKey);
  if (node) return publishedId(node, siteUrl);
  return targetKey.startsWith("id:") ? targetKey.slice(3) : targetKey;
}

/**
 * Convert an entity map into a JSON-LD document.
 *
 * Members appear in the map's node order (sorted by key), and each member's
 * properties are written in a fixed order, so the export is as deterministic as
 * the map it came from.
 */
export function toJsonLd(map: EntityMap): EntityMapJsonLd {
  const byKey = new Map(map.nodes.map((node) => [node.key, node] as const));

  // predicate -> ids, per source node.
  const references = new Map<string, Map<string, string[]>>();
  for (const edge of map.edges) {
    let perSource = references.get(edge.source);
    if (!perSource) {
      perSource = new Map();
      references.set(edge.source, perSource);
    }
    const ids = perSource.get(edge.predicate);
    const id = targetId(edge.target, byKey, map.site);
    if (ids) {
      if (!ids.includes(id)) ids.push(id);
    } else {
      perSource.set(edge.predicate, [id]);
    }
  }

  const graph: Record<string, unknown>[] = map.nodes.map((node) => {
    // Built with literal keys plus predicate names from a fixed allowlist, so
    // no attacker-chosen key is ever bracket-assigned onto this object.
    const member: Record<string, unknown> = {
      "@id": publishedId(node, map.site),
      "@type": node.types.length === 1 ? node.types[0] : node.types,
    };

    const { name, url, logo, image, sameAs, telephone, email, address, description } =
      node.properties;
    if (name !== undefined) member.name = name;
    if (url !== undefined) member.url = url;
    if (logo !== undefined) member.logo = logo;
    if (image !== undefined) member.image = image.length === 1 ? image[0] : image;
    if (sameAs !== undefined) member.sameAs = sameAs;
    if (telephone !== undefined) member.telephone = telephone;
    if (email !== undefined) member.email = email;
    if (address !== undefined) member.address = address;
    if (description !== undefined) member.description = description;

    const perSource = references.get(node.key);
    if (perSource) {
      for (const predicate of [...perSource.keys()].sort()) {
        const ids = perSource.get(predicate) ?? [];
        // `sameAs` already lives in `properties` as plain strings; an edge only
        // exists when the profile URL is itself a declared node, and merging the
        // two representations would produce a mixed string/object array.
        if (predicate === "sameAs" && sameAs !== undefined) continue;
        const refs = ids.map((id) => ({ "@id": id }));
        member[predicate] = refs.length === 1 ? refs[0] : refs;
      }
    }

    return member;
  });

  return { "@context": "https://schema.org", "@graph": graph };
}
