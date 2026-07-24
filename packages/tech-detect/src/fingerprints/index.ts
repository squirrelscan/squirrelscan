import type { TechFingerprint } from "../types";
import { CMS_FINGERPRINTS } from "./cms";
import { FRAMEWORK_FINGERPRINTS } from "./frameworks";
import { ANALYTICS_FINGERPRINTS } from "./analytics";
import { CDN_FINGERPRINTS } from "./cdn";
import { SERVER_FINGERPRINTS } from "./servers";
import { HOSTING_FINGERPRINTS } from "./hosting";
import { TAG_MANAGER_FINGERPRINTS } from "./tag-managers";
import { PAYMENT_FINGERPRINTS } from "./payments";
import { CHAT_FINGERPRINTS } from "./chat";
import { AD_FINGERPRINTS } from "./ads";
import { SECURITY_FINGERPRINTS } from "./security";
import { FONT_FINGERPRINTS } from "./fonts";
import { OTHER_FINGERPRINTS } from "./other";
import { GENERATED_FINGERPRINTS } from "./generated";

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
  // Researched, adversarially-reviewed extension set (see ./generated.ts).
  ...GENERATED_FINGERPRINTS,
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
  GENERATED_FINGERPRINTS,
};
