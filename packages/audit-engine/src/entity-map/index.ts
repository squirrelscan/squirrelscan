// Structured entity map (#2061) — build, export, render.
//
// The whole surface the cloud side consumes lives behind this ONE subpath
// export (`@squirrelscan/audit-engine/entity-map`). The private API must not
// import the engine root, so anything it needs is re-exported here rather than
// from `../index`.
//
// Built on every audit and every analyze (#2091), stored in the project store,
// and carried on the report so all six formats can render it. Report-only: no
// rule reads it and it never touches the health score.
//
// EVERYTHING here must reach no further than `@squirrelscan/core-contracts`.
// The streaming collector deliberately is NOT re-exported: it takes a
// `SiteContextPage`, and that one type import pulls `../adapter` — and with it
// the crawler, rules and threat-intel packages — into the type graph of every
// consumer of this barrel. The private API compiles with a different lib/types
// set, so those packages fail to typecheck there (missing `Bun`, a different
// DOM lib, a `.yml` module) for reasons that have nothing to do with the map.
// A crawl-side consumer imports `@squirrelscan/audit-engine/entity-map/collect`
// instead. (#2094)

export { buildEntityMap, createEntityMapBuilder } from "./build";
export type {
  BuildEntityMapOptions,
  EntityMapBuilder,
  EntityMapPageInput,
} from "./build";
export { diffEntityMaps } from "./diff";
export type { DiffEntityMapsOptions } from "./diff";
export { toJsonLd } from "./jsonld";
export { renderEntityMapHtml } from "./html";
export { renderEntityMapMarkdown } from "./markdown";
export { slimEntityMapForPublish } from "./slim";

// Re-exported so a consumer of this subpath never has to reach for a second
// package just to type the thing it was handed.
export type {
  EntityMap,
  EntityMapDiff,
  EntityMapEdge,
  EntityMapJsonLd,
  EntityMapNode,
  EntityMapPage,
  EntityMapSummary,
} from "@squirrelscan/core-contracts/entity-map";
