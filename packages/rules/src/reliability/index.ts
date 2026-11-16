// Reliability rules - runtime errors, broken resources, failed requests and forms that lose submissions

import type { Rule } from "../types";

import { brokenFormsRule } from "./broken-forms";
import { brokenResourcesRule } from "./broken-resources";
import { jsErrorsRule } from "./js-errors";

export const rules: Rule[] = [brokenResourcesRule, brokenFormsRule, jsErrorsRule];

export { brokenFormsRule, brokenResourcesRule, jsErrorsRule };
