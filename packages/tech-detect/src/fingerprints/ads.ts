import type { TechFingerprint } from "../types";

export const AD_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "google-adsense",
    name: "Google AdSense",
    category: "ad-network",
    website: "https://adsense.google.com",
    icon: "google-adsense",
    detectors: [
      { type: "script-url", pattern: /pagead2\.googlesyndication\.com/i },
      { type: "html", pattern: /adsbygoogle/i },
      { type: "html", pattern: /data-ad-client/i },
    ],
  },
  {
    id: "google-ad-manager",
    name: "Google Ad Manager",
    category: "ad-network",
    website: "https://admanager.google.com",
    icon: "google-ads",
    detectors: [
      { type: "script-url", pattern: /securepubads\.g\.doubleclick\.net/i },
      { type: "script-url", pattern: /googletag\.pubads/i },
      { type: "html", pattern: /googletag\.cmd/i },
    ],
  },
  {
    id: "google-ads",
    name: "Google Ads",
    category: "ad-network",
    website: "https://ads.google.com",
    icon: "google-ads",
    detectors: [
      { type: "script-url", pattern: /googleads\.g\.doubleclick\.net/i },
      { type: "html", pattern: /google_conversion_id/i },
      { type: "script-url", pattern: /googleadservices\.com/i },
    ],
  },
  {
    id: "facebook-pixel",
    name: "Meta Pixel",
    category: "ad-network",
    website: "https://facebook.com/business",
    icon: "meta",
    detectors: [
      { type: "script-url", pattern: /connect\.facebook\.net.*fbevents/i },
      { type: "html", pattern: /fbq\(['"]init['"]/i },
      { type: "script-content", pattern: /fbq\(['"]init['"]/ },
    ],
  },
];
