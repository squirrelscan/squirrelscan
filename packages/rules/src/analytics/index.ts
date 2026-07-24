// Analytics rules - tracking & measurement checks
// GTM presence, consent mode

import type { Rule } from "../types";

import { consentModeRule } from "./consent-mode";
import { gtmPresentRule } from "./gtm-present";

export const rules: Rule[] = [gtmPresentRule, consentModeRule];
