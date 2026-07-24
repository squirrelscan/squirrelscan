import type { TechFingerprint } from "../types";

export const OTHER_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "jquery",
    name: "jQuery",
    category: "other",
    website: "https://jquery.com",
    icon: "jquery",
    detectors: [
      { type: "script-url", pattern: /jquery(?:\.min)?\.js/i },
      { type: "script-content", pattern: /jQuery\.fn\.jquery/ },
    ],
    versionPattern: /jquery[.-]v?(\d+\.\d+\.\d+)/i,
  },
  {
    id: "bootstrap",
    name: "Bootstrap",
    category: "other",
    website: "https://getbootstrap.com",
    icon: "bootstrap",
    detectors: [
      { type: "script-url", pattern: /bootstrap(?:\.bundle)?(?:\.min)?\.js/i },
      { type: "html", pattern: /bootstrap\.min\.css/i },
    ],
    versionPattern: /bootstrap[/@](\d+\.\d+\.\d+)/i,
  },
  {
    id: "tailwindcss",
    name: "Tailwind CSS",
    category: "other",
    website: "https://tailwindcss.com",
    icon: "tailwindcss",
    detectors: [
      { type: "html", pattern: /tailwind/i },
      { type: "script-url", pattern: /tailwindcss/i },
    ],
    confidence: "medium",
  },
  {
    id: "youtube-embed",
    name: "YouTube Embed",
    category: "video",
    website: "https://youtube.com",
    icon: "youtube",
    detectors: [
      { type: "html", pattern: /youtube\.com\/embed\//i },
      { type: "html", pattern: /youtube-nocookie\.com\/embed\//i },
    ],
  },
  {
    id: "vimeo-embed",
    name: "Vimeo Embed",
    category: "video",
    website: "https://vimeo.com",
    icon: "vimeo",
    detectors: [
      { type: "html", pattern: /player\.vimeo\.com\/video\//i },
    ],
  },
  {
    id: "wistia",
    name: "Wistia",
    category: "video",
    website: "https://wistia.com",
    icon: "wistia",
    detectors: [
      { type: "script-url", pattern: /fast\.wistia\.(com|net)/i },
      { type: "html", pattern: /wistia_embed/i },
    ],
  },
  {
    id: "cookiebot",
    name: "Cookiebot",
    category: "widget",
    website: "https://cookiebot.com",
    icon: "cookiebot",
    detectors: [
      { type: "script-url", pattern: /consent\.cookiebot\.com/i },
      { type: "html", pattern: /CookieConsent/i },
    ],
  },
  {
    id: "onetrust",
    name: "OneTrust",
    category: "widget",
    website: "https://onetrust.com",
    icon: "onetrust",
    detectors: [
      { type: "script-url", pattern: /cdn\.cookielaw\.org/i },
      { type: "html", pattern: /optanon/i },
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    category: "other",
    website: "https://sentry.io",
    icon: "sentry",
    detectors: [
      { type: "script-url", pattern: /browser\.sentry-cdn\.com/i },
      { type: "script-content", pattern: /Sentry\.init/ },
      { type: "html", pattern: /sentry\.init/i },
    ],
  },
  {
    id: "datadog-rum",
    name: "Datadog RUM",
    category: "other",
    website: "https://datadoghq.com",
    icon: "datadog",
    detectors: [
      { type: "script-url", pattern: /datadog-rum/i },
      { type: "html", pattern: /DD_RUM\.init/i },
    ],
  },
];
