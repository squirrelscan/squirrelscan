// AI rules - LLM-powered analysis

import type { Rule } from "../types";

import { aiContentRule } from "./ai-content";
import { designReviewRule } from "./design-review";
import { llmParsabilityRule } from "./llm-parsability";
import { pageTypeMatchRule } from "./page-type-match";
import { siteMetadataRule } from "./site-metadata";

export const rules: Rule[] = [
  llmParsabilityRule,
  designReviewRule,
  aiContentRule,
  pageTypeMatchRule,
  siteMetadataRule,
];

export { aiContentRule, designReviewRule, llmParsabilityRule, pageTypeMatchRule, siteMetadataRule };
