// AI rules - LLM-powered analysis

import type { Rule } from "../types";

import { aiContentRule } from "./ai-content";
import { llmParsabilityRule } from "./llm-parsability";
import { pageTypeMatchRule } from "./page-type-match";
import { siteMetadataRule } from "./site-metadata";

export const rules: Rule[] = [
  llmParsabilityRule,
  aiContentRule,
  pageTypeMatchRule,
  siteMetadataRule,
];

export { aiContentRule, llmParsabilityRule, pageTypeMatchRule, siteMetadataRule };
