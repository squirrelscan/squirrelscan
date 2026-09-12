// Structured entity map (#2061) — build, export, render.
//
// Prototype scope: the map is written as a side artifact by `squirrel audit
// --entity-map`. It does not feed the rules, the score, or the report.

export { buildEntityMap } from "./build";
export type { BuildEntityMapOptions, EntityMapPageInput } from "./build";
export { toJsonLd } from "./jsonld";
export { renderEntityMapHtml } from "./html";
export { createEntityMapCollector } from "./collect";
export type { EntityMapCollector } from "./collect";
