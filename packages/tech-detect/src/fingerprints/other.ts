import type { Detector, TechFingerprint } from "../types";

/**
 * A script URL matched two ways: anchored at the start of a `script-url` entry,
 * and as the `src` of a real `<script>` tag in the HTML. The engine scans the raw
 * HTML for `script-url` when no script list is passed, so an unanchored pattern
 * would also fire on a code sample or a link in prose; both forms here need a
 * script tag or a whole script URL.
 */
function scriptSrc(urlSource: string): Detector[] {
  return [
    { type: "script-url", pattern: new RegExp(`^${urlSource}`, "i") },
    { type: "html", pattern: new RegExp(`<script\\b[^>]{0,300}\\bsrc\\s*=\\s*["']${urlSource}`, "i") },
  ];
}

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

  // Vibe-coding builders and backend-as-a-service SDKs. Every signal is visible
  // in stored HTML, headers, script URLs or inline config (external JS bodies are
  // not stored). Host patterns are anchored to the start of the URL so a page that
  // only mentions a host in its body never matches through the url-path HTML scan.
  {
    id: "lovable",
    name: "Lovable",
    category: "cms",
    website: "https://lovable.dev",
    icon: "lovable",
    detectors: [
      { type: "meta", name: "author", pattern: /^Lovable$/i },
      { type: "meta", name: "twitter:site", pattern: /^@lovable(?:_dev)?$/i },
      ...scriptSrc(String.raw`(?:https:)?\/\/cdn\.gpteng\.co\/(?:gptengineer|lovable)\.js`),
      ...scriptSrc(String.raw`\/__l5e\/events\.[0-9a-f]{8,64}\.js`),
      { type: "html", pattern: /#lovable-badge\b/ },
      { type: "html", pattern: /storage\.googleapis\.com\/gpt-engineer-file-uploads\//i },
    ],
    confidence: "high",
  },
  {
    id: "base44",
    name: "Base44",
    category: "cms",
    website: "https://base44.com",
    icon: "base44",
    detectors: [
      { type: "url-path", pattern: /^https?:\/\/(?:[a-z0-9-]{1,63}\.){1,3}base44\.app(?:[:/?#]|$)/i },
      { type: "script-content", pattern: /base44_access_token/ },
      { type: "script-content", pattern: /\/api\/app-logs\/[0-9a-f]{24}\/log-user-in-app/ },
    ],
    confidence: "high",
  },
  {
    id: "replit",
    name: "Replit",
    category: "hosting",
    website: "https://replit.com",
    icon: "replit",
    detectors: [
      {
        type: "url-path",
        pattern: /^https?:\/\/(?:[a-z0-9-]{1,63}\.){1,6}(?:replit\.app|repl\.co|replit\.dev)(?:[:/?#]|$)/i,
      },
      ...scriptSrc(String.raw`https:\/\/replit\.com\/public\/js\/replit-dev-banner\.js`),
      { type: "html", pattern: /["'(]\/__replco\/static\//i },
    ],
    confidence: "high",
  },
  {
    id: "v0",
    name: "v0",
    category: "cms",
    website: "https://v0.app",
    icon: "v0",
    detectors: [{ type: "meta", name: "generator", pattern: /^v0\.(?:app|dev)$/i }],
    confidence: "high",
  },
  {
    id: "supabase",
    name: "Supabase",
    category: "other",
    website: "https://supabase.com",
    icon: "supabase",
    detectors: [
      // Project refs are 20 lowercase alphanumerics: <ref>.supabase.co. The path
      // must be one of the platform APIs and the URL must sit in an attribute value
      // (img/link/script) or a next/image proxy parameter, not in prose.
      {
        type: "html",
        pattern:
          /=\s*["']https:\/\/[a-z0-9]{20}\.supabase\.co\/(?:storage|rest|auth|realtime|functions|graphql)\/v1/i,
      },
      {
        type: "html",
        pattern:
          /https%3A%2F%2F[a-z0-9]{20}\.supabase\.co%2F(?:storage|rest|auth|realtime|functions|graphql)%2Fv1/i,
      },
      { type: "script-content", pattern: /createClient\(\s*["']https:\/\/[a-z0-9]{20}\.supabase\.co["']/ },
      ...scriptSrc(
        String.raw`https:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|esm\.sh)\/@supabase\/supabase-js`,
      ),
    ],
    confidence: "high",
  },
  {
    id: "clerk",
    name: "Clerk",
    category: "other",
    website: "https://clerk.com",
    icon: "clerk",
    detectors: [
      ...scriptSrc(String.raw`https:\/\/[a-z0-9.-]{1,120}\/npm\/@clerk\/clerk-js@`),
      ...scriptSrc(String.raw`https:\/\/[a-z0-9-]{1,63}\.clerk\.accounts\.dev\/`),
      { type: "html", pattern: /<script\b[^>]{0,400}\bdata-clerk-js-script\b/i },
      { type: "html", pattern: /\bdata-clerk-publishable-key\s*=\s*["']pk_(?:test|live)_/i },
    ],
    versionPattern: /@clerk\/clerk-js@(\d+(?:\.\d+){0,2})/i,
    confidence: "high",
  },
  {
    id: "firebase",
    name: "Firebase",
    category: "other",
    website: "https://firebase.google.com",
    icon: "firebase",
    detectors: [
      ...scriptSrc(String.raw`https:\/\/www\.gstatic\.com\/firebasejs\/\d`),
      ...scriptSrc(
        String.raw`\/__\/firebase\/(?:\d+(?:\.\d+){0,2}\/)?(?:init\.js|firebase-app(?:-compat)?\.js)`,
      ),
      { type: "script-content", pattern: /authDomain\s*:\s*["'][a-z0-9-]{1,63}\.firebaseapp\.com["']/i },
    ],
    versionPattern: /gstatic\.com\/firebasejs\/(\d+\.\d+\.\d+)/i,
    confidence: "high",
  },
];
