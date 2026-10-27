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

export type { Model } from "./model-format";
export type { PageTypeLabel, RegionLabel } from "./rules-fallback";
