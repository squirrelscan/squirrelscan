// Gaps rules - keyword & content gap analysis (cloud-backed, DataForSEO-fed)

import type { Rule } from "../types";

import { contentGapsRule } from "./content";
import { keywordGapsRule } from "./keywords";

export const rules: Rule[] = [keywordGapsRule, contentGapsRule];

export { contentGapsRule, keywordGapsRule };
