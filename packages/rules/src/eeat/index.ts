// E-E-A-T rules - Experience, Expertise, Authoritativeness, Trust (site-scope)
// Author info, credentials, trust signals, YMYL compliance

import type { Rule } from "../types";

import { aboutPageRule } from "./about-page";
import { affiliateDisclosureRule } from "./affiliate-disclosure";
import { authorBylineRule } from "./author-byline";
import { authoritySignalsRule } from "./authority-signals";
import { authorExpertiseRule } from "./author-expertise";
import { citationsRule } from "./citations";
import { contactPageRule } from "./contact-page";
import { contentDatesRule } from "./content-dates";
import { disclaimersRule } from "./disclaimers";
import { editorialPolicyRule } from "./editorial-policy";
import { physicalAddressRule } from "./physical-address";
import { privacyPolicyRule } from "./privacy-policy";
import { termsOfServiceRule } from "./terms-of-service";
import { trustSignalsRule } from "./trust-signals";
import { ymylDetectionRule } from "./ymyl-detection";

export const rules: Rule[] = [
  // Experience
  authorBylineRule,
  contentDatesRule,
  // Expertise
  authorExpertiseRule,
  citationsRule,
  // Authoritativeness
  aboutPageRule,
  editorialPolicyRule,
  authoritySignalsRule,
  // Trust
  contactPageRule,
  physicalAddressRule,
  privacyPolicyRule,
  termsOfServiceRule,
  trustSignalsRule,
  // YMYL
  ymylDetectionRule,
  disclaimersRule,
  affiliateDisclosureRule,
];

export {
  aboutPageRule,
  authoritySignalsRule,
  affiliateDisclosureRule,
  authorBylineRule,
  authorExpertiseRule,
  citationsRule,
  contactPageRule,
  contentDatesRule,
  disclaimersRule,
  editorialPolicyRule,
  physicalAddressRule,
  privacyPolicyRule,
  termsOfServiceRule,
  trustSignalsRule,
  ymylDetectionRule,
};
