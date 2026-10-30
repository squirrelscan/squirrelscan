// @squirrelscan/page-classifier: region, page type and section purpose for a parsed page.
//
// One featurizer, one artifact (up to three LightGBM heads), one fallback. A result carries
// {label, confidence, source}; `source` is provenance, so consumers display it and never branch on it.
// See README.md for the contract.

export {
  classifyDocument,
  classifyPage,
  tryLoadModel,
  type ClassifyOptions,
  type ClassifyTimings,
  type CommentSectionRef,
  type NodePrediction,
  type PageClassification,
  type Prediction,
  type SectionPrediction,
  type Source,
} from "./predict";

export {
  elementPlacer,
  type Placement,
  type RegionPlacement,
  type SectionPlacement,
} from "./placement";

export { FEATURIZER_VERSION } from "./featurize";

/**
 * Bump when the classifier's rules or labelling logic change in a way that can change a label
 * without a new model artifact (the URL homepage rule, the rules fallback). 1 predates the stamp;
 * 2 is the first stamped version. It is part of the version stamped on every parsed page, so each
 * bump makes EVERY user's next crawl fetch every cached page once, unconditionally (pagesUnchanged
 * and bytesCacheSaved read 0 for that run). Bump only for a change that must relabel pages already
 * cached, and say so in the CHANGELOG.
 */
export const CLASSIFIER_RULES_VERSION = 2;

export type { Model } from "./model-format";
export type { PageTypeLabel, RegionLabel } from "./rules-fallback";
