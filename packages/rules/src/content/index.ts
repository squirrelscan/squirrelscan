// Content rules - content quality checks

import type { Rule } from "../types";

import { articleLinksRule } from "./article-links";
import { authorInfoRule } from "./author-info";
import { brokenHtmlRule } from "./broken-html";
import { duplicateDescriptionRule } from "./duplicate-description";
import { duplicateTitleRule } from "./duplicate-title";
import { freshnessRule } from "./freshness";
import { headingHierarchyRule } from "./heading-hierarchy";
import { keywordStuffingRule } from "./keyword-stuffing";
import { metaInBodyRule } from "./meta-in-body";
import { mimeTypeRule } from "./mime-type";
import { contentQualityRule } from "./quality";
import { readingLevelRule } from "./reading-level";
import { wordCountRule } from "./word-count";

export const rules: Rule[] = [
  articleLinksRule,
  headingHierarchyRule,
  wordCountRule,
  contentQualityRule,
  duplicateTitleRule,
  duplicateDescriptionRule,
  keywordStuffingRule,
  brokenHtmlRule,
  readingLevelRule,
  freshnessRule,
  authorInfoRule,
  metaInBodyRule,
  mimeTypeRule,
];

export {
  articleLinksRule,
  authorInfoRule,
  brokenHtmlRule,
  contentQualityRule,
  duplicateDescriptionRule,
  duplicateTitleRule,
  freshnessRule,
  headingHierarchyRule,
  keywordStuffingRule,
  metaInBodyRule,
  mimeTypeRule,
  readingLevelRule,
  wordCountRule,
};
