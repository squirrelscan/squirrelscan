// Gaps rules - keyword & content gap analysis and content recommendations (cloud-backed)

import type { Rule } from "../types";

import { contentGapsRule } from "./content";
import { keywordGapsRule } from "./keywords";
import { contentRecommendationsRule } from "./recommendations";

export const rules: Rule[] = [keywordGapsRule, contentGapsRule, contentRecommendationsRule];

export { contentGapsRule, contentRecommendationsRule, keywordGapsRule };
