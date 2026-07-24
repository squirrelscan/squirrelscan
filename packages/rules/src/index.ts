// @squirrelscan/rules — rule definitions, runner, and categories

export * from "./types";
export * from "./collected-signals";
export * from "./categories";
export * from "./filter";
export * from "./runner";
export * from "./merge";
export * from "./fold";
export * from "./resolution";
export * from "./loader";
export * from "./plugins";
export * from "./cloud";
export {
  APPLICABILITY_MIN_CONFIDENCE,
  type ApplicabilityVerdict,
  ruleApplies,
} from "./applicability";
export { setRequestAsync, setLlmCall } from "./tools";

// Domain re-exports
export * as content from "./content";
export * as links from "./links";
export * as images from "./images";
export * as schema from "./schema";
export * as security from "./security";
export * as integrity from "./integrity";
export * as perf from "./performance";
export * as social from "./social";
export * as crawl from "./crawl";
export * as url from "./url";
export * as mobile from "./mobile";
export * as legal from "./legal";
export * as local from "./local";
export * as video from "./video";
export * as analytics from "./analytics";
export * as eeat from "./eeat";

// Rule modules for iteration
export const RULE_MODULES = [
  "content",
  "links",
  "images",
  "schema",
  "security",
  "integrity",
  "perf",
  "social",
  "crawl",
  "url",
  "mobile",
  "legal",
  "local",
  "video",
  "analytics",
  "eeat",
] as const;
