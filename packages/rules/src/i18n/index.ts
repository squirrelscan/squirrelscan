// I18n rules - internationalization checks

import type { Rule } from "../types";

import { hreflangRule } from "./hreflang";
import { hreflangTargetsRule } from "./hreflang-targets";
import { langAttributeRule } from "./lang-attribute";

export const rules: Rule[] = [langAttributeRule, hreflangRule, hreflangTargetsRule];

export { langAttributeRule, hreflangRule, hreflangTargetsRule };
