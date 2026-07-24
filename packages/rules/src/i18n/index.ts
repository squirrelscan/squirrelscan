// I18n rules - internationalization checks

import type { Rule } from "../types";

import { hreflangRule } from "./hreflang";
import { langAttributeRule } from "./lang-attribute";

export const rules: Rule[] = [langAttributeRule, hreflangRule];

export { langAttributeRule, hreflangRule };
