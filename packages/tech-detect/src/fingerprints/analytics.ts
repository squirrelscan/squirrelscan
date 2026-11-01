import type { TechFingerprint } from "../types";
import { inBundle, inBundleString } from "./helpers";

export const ANALYTICS_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "google-analytics-4",
    name: "Google Analytics 4",
    category: "analytics",
    website: "https://analytics.google.com",
    icon: "google-analytics",
    detectors: [
      { type: "script-url", pattern: /gtag\/js\?id=G-/i },
      { type: "html", pattern: /gtag\(['"]config['"],\s*['"]G-/i },
      { type: "script-content", pattern: /gtag\(['"]config['"],\s*['"]G-/i },
    ],
  },
  {
    id: "google-analytics-ua",
    name: "Google Analytics (Universal)",
    category: "analytics",
    website: "https://analytics.google.com",
    icon: "google-analytics",
    detectors: [
      { type: "script-url", pattern: /google-analytics\.com\/analytics\.js/i },
      { type: "html", pattern: /UA-\d{4,}-\d+/ },
      { type: "script-url", pattern: /gtag\/js\?id=UA-/i },
    ],
    confidence: "medium",
  },
  {
    id: "posthog",
    name: "PostHog",
    category: "analytics",
    website: "https://posthog.com",
    icon: "posthog",
    detectors: [
      { type: "script-url", pattern: /us\.i\.posthog\.com/i },
      { type: "script-url", pattern: /eu\.i\.posthog\.com/i },
      { type: "script-url", pattern: /app\.posthog\.com/i },
      { type: "html", pattern: /posthog\.init/i },
      { type: "script-content", pattern: /posthog\.init/i },
    ],
  },
  {
    id: "mixpanel",
    name: "Mixpanel",
    category: "analytics",
    website: "https://mixpanel.com",
    icon: "mixpanel",
    detectors: [
      { type: "script-url", pattern: /cdn\.mxpnl\.com/i },
      { type: "html", pattern: /mixpanel\.init/i },
      { type: "script-content", pattern: /mixpanel\.init/i },
    ],
  },
  {
    id: "amplitude",
    name: "Amplitude",
    category: "analytics",
    website: "https://amplitude.com",
    icon: "amplitude",
    detectors: [
      { type: "script-url", pattern: /cdn\.amplitude\.com/i },
      { type: "html", pattern: /amplitude\.init/i },
      { type: "script-content", pattern: /amplitude\.init/i },
    ],
  },
  {
    id: "plausible",
    name: "Plausible",
    category: "analytics",
    website: "https://plausible.io",
    icon: "plausible",
    detectors: [
      { type: "script-url", pattern: /plausible\.io\/js\//i },
      { type: "html", pattern: /data-domain=.{0,600}plausible/i },
    ],
  },
  {
    id: "hotjar",
    name: "Hotjar",
    category: "analytics",
    website: "https://hotjar.com",
    icon: "hotjar",
    detectors: [
      { type: "script-url", pattern: /static\.hotjar\.com/i },
      { type: "html", pattern: /hj\(['"]init['"]/i },
      { type: "script-content", pattern: /hotjar\.com/ },
    ],
  },
  {
    id: "heap",
    name: "Heap",
    category: "analytics",
    website: "https://heap.io",
    icon: "heap",
    detectors: [
      { type: "script-url", pattern: /cdn\.heapanalytics\.com/i },
      { type: "html", pattern: /heap\.load/i },
    ],
  },
  {
    id: "clarity",
    name: "Microsoft Clarity",
    category: "analytics",
    website: "https://clarity.microsoft.com",
    icon: "clarity",
    detectors: [
      { type: "script-url", pattern: /clarity\.ms/i },
      { type: "html", pattern: /clarity\(['"]set['"]/i },
      // The standard loader bundled into a first-party script: `t.src="https://www.clarity.ms/tag/"+i`, the
      // `setAttribute("src", ...)` form or a template literal. The assignment is code, the URL after it is a string, so
      // the match starts in code and a docs string, comment or prose that only names the URL does not match (#1488).
      inBundle(
        String.raw`(?:\.src\s*=|setAttribute\s*\(\s*["']src["']\s*,)\s*["'\x60](?:https?:)?\/\/(?:www\.)?clarity\.ms\/tag\/`,
        "clarity.ms/tag/",
      ),
      // The standard snippet as the text of an inline script a framework renders: a template literal `__html:` or a
      // `children:'...'` of a `next/script` props object. The quotes of the loader may be escaped in a JSON-style
      // string, and a docs string that only shows the snippet is still rejected (#1509).
      inBundleString(
        String.raw`\.src\s*=\s*\\?["'\x60](?:https?:)?\\?\/\\?\/(?:www\.)?clarity\.ms\\?\/tag\\?\/`,
        "clarity.ms",
        // The standard snippet's own signature, or a script element created and given the loader in the same string.
        /function\s*\(\s*c\s*,\s*l\s*,\s*a\s*,\s*r\s*,\s*i\s*,\s*t\s*,\s*y\s*\)|createElement\s*\(\s*\\?["'\x60]script\\?["'\x60]\s*\)/,
      ),
    ],
  },
  {
    id: "fathom",
    name: "Fathom Analytics",
    category: "analytics",
    website: "https://usefathom.com",
    icon: "fathom",
    detectors: [
      { type: "script-url", pattern: /cdn\.usefathom\.com/i },
      { type: "html", pattern: /data-site=.{0,600}usefathom/i },
    ],
  },
  {
    id: "matomo",
    name: "Matomo",
    category: "analytics",
    website: "https://matomo.org",
    icon: "matomo",
    detectors: [
      { type: "script-url", pattern: /matomo\.js/i },
      { type: "html", pattern: /_paq\.push/i },
      { type: "script-content", pattern: /_paq\.push/ },
    ],
  },
];
