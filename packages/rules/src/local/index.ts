// Local rules - local SEO checks (site-scope)
// NAP consistency, local business schema, geo meta

import type { Rule } from "../types";

import { geoMetaRule } from "./geo-meta";
import { napConsistencyRule } from "./nap-consistency";
import { serviceAreaRule } from "./service-area";

export const rules: Rule[] = [napConsistencyRule, geoMetaRule, serviceAreaRule];

export { geoMetaRule, napConsistencyRule, serviceAreaRule };
