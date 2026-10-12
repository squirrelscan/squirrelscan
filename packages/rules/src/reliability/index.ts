// Reliability rules - runtime errors, broken resources and failed requests

import type { Rule } from "../types";

import { brokenResourcesRule } from "./broken-resources";

export const rules: Rule[] = [brokenResourcesRule];

export { brokenResourcesRule };
