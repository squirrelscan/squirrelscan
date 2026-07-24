// Core rules - fundamental SEO checks

import type { Rule } from "../types";

import { canonicalRule } from "./canonical";
import { canonicalHeaderRule } from "./canonical-header";
import { charsetRule } from "./charset";
import { doctypeRule } from "./doctype";
import { faviconRule } from "./favicon";
import { h1Rule } from "./h1";
import { metaDescriptionRule } from "./meta-description";
import { metaTitleRule } from "./meta-title";
import { nosnippetRule } from "./nosnippet";
import { ogTagsRule } from "./og-tags";
import { robotsMetaRule } from "./robots-meta";
import { titleUniqueRule } from "./title-unique";
import { twitterCardsRule } from "./twitter-cards";

export const rules: Rule[] = [
  doctypeRule,
  charsetRule,
  metaTitleRule,
  metaDescriptionRule,
  canonicalRule,
  canonicalHeaderRule,
  h1Rule,
  robotsMetaRule,
  nosnippetRule,
  ogTagsRule,
  twitterCardsRule,
  faviconRule,
  titleUniqueRule,
];

// Re-export individual rules
export {
  canonicalHeaderRule,
  canonicalRule,
  charsetRule,
  doctypeRule,
  faviconRule,
  h1Rule,
  metaDescriptionRule,
  metaTitleRule,
  nosnippetRule,
  ogTagsRule,
  robotsMetaRule,
  titleUniqueRule,
  twitterCardsRule,
};
