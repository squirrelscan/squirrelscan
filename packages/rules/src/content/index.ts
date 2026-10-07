// Content rules - content quality checks

import type { Rule } from "../types";

import { articleLinksRule } from "./article-links";
import { authorInfoRule } from "./author-info";
import { brokenHtmlRule } from "./broken-html";
import { dateAgreementRule } from "./date-agreement";
import { devLeakageRule } from "./dev-leakage";
import { duplicateDescriptionRule } from "./duplicate-description";
import { duplicateTitleRule } from "./duplicate-title";
import { freshnessRule } from "./freshness";
import { headingHierarchyRule } from "./heading-hierarchy";
import { hiddenTextRule } from "./hidden-text";
import { keywordStuffingRule } from "./keyword-stuffing";
import { metaInBodyRule } from "./meta-in-body";
import { mojibakeRule } from "./mojibake";
import { mimeTypeRule } from "./mime-type";
import { placeholderContactRule } from "./placeholder-contact";
import { placeholderMediaRule } from "./placeholder-media";
import { placeholderTextRule } from "./placeholder-text";
import { contentQualityRule } from "./quality";
import { readingLevelRule } from "./reading-level";
import { staleCopyrightRule } from "./stale-copyright";
import { thinVsSiteNormRule } from "./thin-vs-site-norm";
import { titlePatternOutlierRule } from "./title-pattern-outlier";
import { unrenderedMarkupRule } from "./unrendered-markup";
import { wordCountRule } from "./word-count";

export const rules: Rule[] = [
  articleLinksRule,
  headingHierarchyRule,
  wordCountRule,
  contentQualityRule,
  duplicateTitleRule,
  duplicateDescriptionRule,
  keywordStuffingRule,
  hiddenTextRule,
  brokenHtmlRule,
  readingLevelRule,
  freshnessRule,
  authorInfoRule,
  metaInBodyRule,
  mimeTypeRule,
  mojibakeRule,
  staleCopyrightRule,
  thinVsSiteNormRule,
  titlePatternOutlierRule,
  dateAgreementRule,
  placeholderTextRule,
  placeholderMediaRule,
  unrenderedMarkupRule,
  devLeakageRule,
  placeholderContactRule,
];

export {
  articleLinksRule,
  authorInfoRule,
  brokenHtmlRule,
  contentQualityRule,
  dateAgreementRule,
  devLeakageRule,
  duplicateDescriptionRule,
  duplicateTitleRule,
  freshnessRule,
  headingHierarchyRule,
  hiddenTextRule,
  keywordStuffingRule,
  metaInBodyRule,
  mimeTypeRule,
  mojibakeRule,
  placeholderContactRule,
  placeholderMediaRule,
  placeholderTextRule,
  readingLevelRule,
  staleCopyrightRule,
  thinVsSiteNormRule,
  titlePatternOutlierRule,
  unrenderedMarkupRule,
  wordCountRule,
};
