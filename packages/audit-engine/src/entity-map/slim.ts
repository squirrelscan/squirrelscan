// Bound an entity map for a copy that travels (#2091).
//
// The projection itself lives in `@squirrelscan/core-contracts/entity-map-project`,
// because `@squirrelscan/report` needs it for the viewer payload and the engine
// depends on report, never the reverse. This module is the engine's door onto
// it, so existing importers keep their import path.

export {
  projectEntityMap,
  slimEntityMapForPublish,
  slimEntityMapForViewer,
} from "@squirrelscan/core-contracts/entity-map-project";
