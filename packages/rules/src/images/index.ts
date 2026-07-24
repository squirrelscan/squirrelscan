// Images rules - image optimization checks

import type { Rule } from "../types";

import { altTextRule } from "./alt-text";
import { aspectMismatchRule } from "./aspect-mismatch";
import { brokenImagesRule } from "./broken-images";
import { dimensionsRule } from "./dimensions";
import { figureFigcaptionRule } from "./figure-figcaption";
import { filenameQualityRule } from "./filename-quality";
import { imageFileSizeRule } from "./image-file-size";
import { lazyLoadingRule } from "./lazy-loading";
import { modernFormatRule } from "./modern-format";
import { offscreenLazyRule } from "./offscreen-lazy";
import { optimizedRule } from "./optimized";
import { pictureElementRule } from "./picture-element";
import { responsiveSizeRule } from "./responsive-size";
import { srcsetRule } from "./srcset";
import { svgInlineRule } from "./svg-inline";

// Legacy exports for backwards compatibility
export * from "./images";

export const rules: Rule[] = [
  altTextRule,
  dimensionsRule,
  aspectMismatchRule,
  modernFormatRule,
  srcsetRule,
  responsiveSizeRule,
  lazyLoadingRule,
  offscreenLazyRule,
  optimizedRule,
  imageFileSizeRule,
  filenameQualityRule,
  svgInlineRule,
  brokenImagesRule,
  figureFigcaptionRule,
  pictureElementRule,
];

export {
  altTextRule,
  aspectMismatchRule,
  brokenImagesRule,
  dimensionsRule,
  figureFigcaptionRule,
  filenameQualityRule,
  imageFileSizeRule,
  lazyLoadingRule,
  modernFormatRule,
  offscreenLazyRule,
  optimizedRule,
  pictureElementRule,
  responsiveSizeRule,
  srcsetRule,
  svgInlineRule,
};
