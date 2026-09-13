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

export { buildEntityMap } from "./build";
export type { BuildEntityMapOptions, EntityMapPageInput } from "./build";
export { toJsonLd } from "./jsonld";
export { renderEntityMapHtml } from "./html";
export { renderEntityMapMarkdown } from "./markdown";
export { slimEntityMapForPublish } from "./slim";
export { createEntityMapCollector } from "./collect";
export type { EntityMapCollector } from "./collect";

// Re-exported so a consumer of this subpath never has to reach for a second
// package just to type the thing it was handed.
export type {
  EntityMap,
  EntityMapEdge,
  EntityMapJsonLd,
  EntityMapNode,
  EntityMapPage,
  EntityMapSummary,
} from "@squirrelscan/core-contracts/entity-map";
