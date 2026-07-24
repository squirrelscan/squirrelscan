import type { TechFingerprint } from "../types";

export const TAG_MANAGER_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "google-tag-manager",
    name: "Google Tag Manager",
    category: "tag-manager",
    website: "https://tagmanager.google.com",
    icon: "gtm",
    detectors: [
      { type: "script-url", pattern: /googletagmanager\.com\/gtm\.js/i },
      { type: "html", pattern: /GTM-[A-Z0-9]+/i },
      { type: "html", pattern: /google_tag_manager/i },
    ],
  },
  {
    id: "segment",
    name: "Segment",
    category: "tag-manager",
    website: "https://segment.com",
    icon: "segment",
    detectors: [
      { type: "script-url", pattern: /cdn\.segment\.com/i },
      { type: "html", pattern: /analytics\.load\(/i },
      { type: "script-content", pattern: /analytics\.load\(/ },
    ],
  },
  {
    id: "tealium",
    name: "Tealium",
    category: "tag-manager",
    website: "https://tealium.com",
    icon: "tealium",
    detectors: [
      { type: "script-url", pattern: /tags\.tiqcdn\.com/i },
      { type: "html", pattern: /utag\.js/i },
    ],
  },
];
