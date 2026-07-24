// Legal rules - compliance checks
// privacy policy, cookie consent, terms of service

import type { Rule } from "../types";

import { cookieConsentRule } from "./cookie-consent";
import { privacyPolicyRule } from "./privacy-policy";
import { subprocessorDisclosureRule } from "./subprocessor-disclosure";
import { termsOfServiceRule } from "./terms-of-service";

export const rules: Rule[] = [
  privacyPolicyRule,
  cookieConsentRule,
  subprocessorDisclosureRule,
  termsOfServiceRule,
];

export { subprocessorDisclosureRule };
