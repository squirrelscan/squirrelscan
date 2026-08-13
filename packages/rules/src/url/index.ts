// URL rules - URL structure analysis
// length, hyphens, lowercase, parameters

import type { Rule } from "../types";

import { urlHyphensRule } from "./hyphens";
import { urlLengthRule } from "./length";
import { urlLowercaseRule } from "./lowercase";
import { urlParametersRule } from "./parameters";
import { slugConventionRule } from "./slug-convention";
import { slugKeywordsRule } from "./slug-keywords";
import { specialCharsRule } from "./special-chars";
import { stopWordsRule } from "./stop-words";
import { trailingSlashRule } from "./trailing-slash";

export const rules: Rule[] = [
  urlLengthRule,
  slugKeywordsRule,
  urlHyphensRule,
  urlLowercaseRule,
  trailingSlashRule,
  urlParametersRule,
  specialCharsRule,
  stopWordsRule,
  slugConventionRule,
];

export {
  slugConventionRule,
  slugKeywordsRule,
  specialCharsRule,
  stopWordsRule,
  trailingSlashRule,
  urlHyphensRule,
  urlLengthRule,
  urlLowercaseRule,
  urlParametersRule,
};
