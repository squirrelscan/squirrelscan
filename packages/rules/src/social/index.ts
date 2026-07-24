// Social rules - social media sharing optimization
// og-tags and twitter-cards will be moved here, plus new rules

import type { Rule } from "../types";

import { ogImageSizeRule } from "./og-image-size";
import { ogUrlMatchRule } from "./og-url-match";
import { shareButtonsRule } from "./share-buttons";
import { socialProfilesRule } from "./social-profiles";

export const rules: Rule[] = [
  ogImageSizeRule,
  ogUrlMatchRule,
  socialProfilesRule,
  shareButtonsRule,
];

export {
  ogImageSizeRule,
  ogUrlMatchRule,
  shareButtonsRule,
  socialProfilesRule,
};
