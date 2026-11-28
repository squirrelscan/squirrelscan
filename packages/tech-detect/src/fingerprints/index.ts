import type { TechFingerprint } from "../types";

import { AD_FINGERPRINTS } from "./ads";
import { ANALYTICS_FINGERPRINTS } from "./analytics";
import { CDN_FINGERPRINTS } from "./cdn";
import { CHAT_FINGERPRINTS } from "./chat";
import { CMS_FINGERPRINTS } from "./cms";
import { FONT_FINGERPRINTS } from "./fonts";
import { FRAMEWORK_FINGERPRINTS } from "./frameworks";
import { GENERATED_FINGERPRINTS } from "./generated";
import { HOSTING_FINGERPRINTS } from "./hosting";
import { OTHER_FINGERPRINTS } from "./other";
import { PAYMENT_FINGERPRINTS } from "./payments";
import { SECURITY_FINGERPRINTS } from "./security";
import { SERVER_FINGERPRINTS } from "./servers";
import { STACK_FINGERPRINTS } from "./stack";
import { TAG_MANAGER_FINGERPRINTS } from "./tag-managers";
import { WAPPALYZER_MIT_FINGERPRINTS } from "./wappalyzer-mit";
import { WORDPRESS_FINGERPRINTS } from "./wordpress";

export const ALL_FINGERPRINTS: TechFingerprint[] = [
  ...CMS_FINGERPRINTS,
  ...FRAMEWORK_FINGERPRINTS,
  ...ANALYTICS_FINGERPRINTS,
  ...CDN_FINGERPRINTS,
  ...SERVER_FINGERPRINTS,
  ...HOSTING_FINGERPRINTS,
  ...TAG_MANAGER_FINGERPRINTS,
  ...PAYMENT_FINGERPRINTS,
  ...CHAT_FINGERPRINTS,
  ...AD_FINGERPRINTS,
  ...SECURITY_FINGERPRINTS,
  ...FONT_FINGERPRINTS,
  ...OTHER_FINGERPRINTS,
  ...WORDPRESS_FINGERPRINTS,
  ...STACK_FINGERPRINTS,
  // Researched, adversarially-reviewed extension set (see ./generated.ts).
  ...GENERATED_FINGERPRINTS,
  // Ported from the MIT-licensed Wappalyzer snapshot (#2422), registered last so a curated fingerprint wins a tie.
  ...WAPPALYZER_MIT_FINGERPRINTS,
];

export {
  CMS_FINGERPRINTS,
  FRAMEWORK_FINGERPRINTS,
  ANALYTICS_FINGERPRINTS,
  CDN_FINGERPRINTS,
  SERVER_FINGERPRINTS,
  HOSTING_FINGERPRINTS,
  TAG_MANAGER_FINGERPRINTS,
  PAYMENT_FINGERPRINTS,
  CHAT_FINGERPRINTS,
  AD_FINGERPRINTS,
  SECURITY_FINGERPRINTS,
  FONT_FINGERPRINTS,
  OTHER_FINGERPRINTS,
  WORDPRESS_FINGERPRINTS,
  STACK_FINGERPRINTS,
  GENERATED_FINGERPRINTS,
  WAPPALYZER_MIT_FINGERPRINTS,
};
