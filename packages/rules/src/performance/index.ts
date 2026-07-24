// Performance rules barrel export

import type { Rule } from "../types";

import { animatedContentRule } from "./animated-content";
import { badCachingRule } from "./bad-caching";
import { browserRequiredRule } from "./browser-required";
import { cacheHeadersRule } from "./cache-headers";
import { carouselHiddenEagerRule } from "./carousel-hidden-eager";
import { clsHintsRule } from "./cls-hints";
import { compressionRule } from "./compression";
import { criticalRequestChainsRule } from "./critical-request-chains";
import { cssFileSizeRule } from "./css-file-size";
import { jsFileSizeRule } from "./js-file-size";
export * from "./cwv";
import { domSizeRule } from "./dom-size";
import { duplicateJsRule } from "./duplicate-js";
import { fontDeliveryRule } from "./font-delivery";
import { fontLoadingRule } from "./font-loading";
import { http2Rule } from "./http2";
import { inpHintsRule } from "./inp-hints";
import { jsLibrariesRule } from "./js-libraries";
import { jsRedirectsRule } from "./js-redirects";
import { lazyAboveFoldRule } from "./lazy-above-fold";
import { lcpFetchpriorityRule } from "./lcp-fetchpriority";
import { lcpHintsRule } from "./lcp-hints";
import { legacyJsRule } from "./legacy-js";
import { preconnectRule } from "./preconnect";
import { renderBlockingRule } from "./render-blocking";
import { sourceMapsRule } from "./source-maps";
import { totalByteWeightRule } from "./total-byte-weight";
import { ttfbRule } from "./ttfb";
import { unminifiedCssRule } from "./unminified-css";
import { unminifiedJsRule } from "./unminified-js";

export const rules: Rule[] = [
  lcpHintsRule,
  lcpFetchpriorityRule,
  clsHintsRule,
  inpHintsRule,
  fontLoadingRule,
  fontDeliveryRule,
  preconnectRule,
  renderBlockingRule,
  lazyAboveFoldRule,
  carouselHiddenEagerRule,
  cssFileSizeRule,
  jsFileSizeRule,
  domSizeRule,
  ttfbRule,
  jsRedirectsRule,
  jsLibrariesRule,
  sourceMapsRule,
  unminifiedCssRule,
  unminifiedJsRule,
  totalByteWeightRule,
  cacheHeadersRule,
  compressionRule,
  badCachingRule,
  http2Rule,
  animatedContentRule,
  legacyJsRule,
  duplicateJsRule,
  criticalRequestChainsRule,
  browserRequiredRule,
];

export {
  animatedContentRule,
  badCachingRule,
  browserRequiredRule,
  cacheHeadersRule,
  carouselHiddenEagerRule,
  criticalRequestChainsRule,
  clsHintsRule,
  compressionRule,
  cssFileSizeRule,
  domSizeRule,
  duplicateJsRule,
  fontDeliveryRule,
  fontLoadingRule,
  jsFileSizeRule,
  http2Rule,
  inpHintsRule,
  jsLibrariesRule,
  jsRedirectsRule,
  lazyAboveFoldRule,
  lcpFetchpriorityRule,
  lcpHintsRule,
  legacyJsRule,
  preconnectRule,
  renderBlockingRule,
  sourceMapsRule,
  totalByteWeightRule,
  ttfbRule,
  unminifiedCssRule,
  unminifiedJsRule,
};
