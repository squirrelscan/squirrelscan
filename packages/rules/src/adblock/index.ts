import type { Rule } from "../types";

import { blockedLinksRule } from "./blocked-links";
import { elementHidingRule } from "./element-hiding";
import { privacyBlockedRule } from "./privacy-blocked";

export const rules: Rule[] = [elementHidingRule, blockedLinksRule, privacyBlockedRule];
