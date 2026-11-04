import type { TechFingerprint } from "../types";

export const FONT_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "google-fonts",
    name: "Google Fonts",
    category: "font",
    website: "https://fonts.google.com",
    icon: "google-fonts",
    detectors: [
      { type: "html", pattern: /fonts\.googleapis\.com/i },
      { type: "html", pattern: /fonts\.gstatic\.com/i },
    ],
  },
  {
    id: "adobe-fonts",
    name: "Adobe Fonts",
    category: "font",
    website: "https://fonts.adobe.com",
    icon: "adobe-fonts",
    detectors: [
      { type: "html", pattern: /use\.typekit\.net/i },
      { type: "script-url", pattern: /use\.typekit\.net/i },
    ],
  },
  {
    id: "font-awesome",
    name: "Font Awesome",
    category: "font",
    website: "https://fontawesome.com",
    icon: "font-awesome",
    detectors: [
      // The banner Font Awesome's SVG output carries (`<!--!Font Awesome Free 6.5.1 by @fontawesome ... -->`): a comment read on purpose (#1550).
      { type: "html", pattern: /<!--!?\s*Font Awesome\b/i, comments: true },
      { type: "html", pattern: /fontawesome/i },
      { type: "html", pattern: /fa-(?:solid|regular|light|brands)/i },
      { type: "script-url", pattern: /fontawesome/i },
    ],
  },
];
