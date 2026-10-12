// Reliability rules - runtime errors, broken resources, failed requests and forms that lose submissions

import type { Rule } from "../types";

import { brokenFormsRule } from "./broken-forms";
import { brokenResourcesRule } from "./broken-resources";

export const rules: Rule[] = [brokenResourcesRule, brokenFormsRule];

export { brokenFormsRule, brokenResourcesRule };
