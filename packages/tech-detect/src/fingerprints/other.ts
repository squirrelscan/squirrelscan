import type { TechFingerprint } from "../types";
import { inBundle, inBundleWith, inScript, inStyle, resourceAttr, scriptSrc } from "./helpers";

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
  // not stored). Each needs real markup context (a script tag, an inline script, a
  // style block, a resource attribute or the page host), so a tutorial or a blog
  // post that quotes the same strings in prose or code samples does not match.
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
      inStyle(String.raw`#lovable-badge(?:-[a-z]{1,12})?\s*[{,:]`, "#lovable-badge"),
      resourceAttr(
        "img|source",
        "src|srcset|data-src",
        String.raw`https:\/\/storage\.googleapis\.com\/gpt-engineer-file-uploads\/`,
      ),
      // Social image meta: the URL must be the whole start of the value, in either
      // attribute order, so prose in a description that links the bucket is not a hit.
      {
        type: "html",
        pattern:
          /<meta\s(?:[^>]{0,400}\s)?(?:property|name)\s*=\s*["'](?:og|twitter):image["'](?:[^>]{0,400}\s)?content\s*=\s*["']https:\/\/storage\.googleapis\.com\/gpt-engineer-file-uploads\//i,
      },
      {
        type: "html",
        pattern:
          /<meta\s(?:[^>]{0,400}\s)?content\s*=\s*["']https:\/\/storage\.googleapis\.com\/gpt-engineer-file-uploads\/[^"']{0,400}["'](?:[^>]{0,400}\s)?(?:property|name)\s*=\s*["'](?:og|twitter):image["']/i,
      },
    ],
    ignoreComments: true,
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
      inScript(String.raw`base44_access_token`, "base44_access_token"),
      inScript(
        String.raw`\/api\/app-logs\/(?:[0-9a-f]{24}|\$\{\w{1,30}\})\/log-user-in-app`,
        "/api/app-logs/",
      ),
    ],
    ignoreComments: true,
    confidence: "high",
  },
  {
    id: "bolt-new",
    name: "Bolt",
    category: "cms",
    website: "https://bolt.new",
    icon: "bolt-new",
    detectors: [
      // Bolt's app hosting. The page host only: anchored at the URL start, so a
      // look-alike host or a page that links to a .bolt.host app does not match.
      { type: "url-path", pattern: /^https?:\/\/(?:[a-z0-9-]{1,63}\.){1,3}bolt\.host(?:[:/?#]|$)/i },
      // The "Made in Bolt" badge an app can carry: an anchor whose href is the Bolt
      // referral URL AND whose content is the badge (an image or svg, or the words
      // "Made in Bolt"). A plain referral link in a post (`<a href="...?rid=x">try
      // Bolt</a>`) is not the badge. Bolt's checkout product (bolt.com) is a
      // different company and never matches this host.
      {
        type: "html",
        requires: "bolt.new/?rid=",
        pattern:
          /<a\s(?:[^>]{0,400}\s)?href\s*=\s*["']https:\/\/bolt\.new\/\?rid=[A-Za-z0-9_-]{1,64}["'][^>]{0,400}>\s{0,40}(?:<(?:img|svg)\b|Made (?:in|with) Bolt\b)/i,
      },
    ],
    ignoreComments: true,
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
      resourceAttr("link|script|img|source", "href|src", String.raw`\/__replco\/static\/`),
      inStyle(String.raw`url\(\s*["']?\/__replco\/static\/`, "/__replco/static/"),
    ],
    ignoreComments: true,
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
      // Project refs are 20 lowercase alphanumerics: <ref>.supabase.co. A usage
      // signal is a resource tag (never an <a href>), a next/image proxy URL, an
      // inline client config or the CDN client script; `your...` placeholders are
      // not refs.
      resourceAttr(
        "img|source|video|script|link|iframe",
        "src|srcset|data-src|poster|href",
        String.raw`https:\/\/(?!your)[a-z0-9]{20}\.supabase\.co\/(?:storage|rest|auth|realtime|functions|graphql)\/v1`,
      ),
      {
        type: "html",
        pattern:
          /\/_next\/image\?url=https%3A%2F%2F(?!your)[a-z0-9]{20}\.supabase\.co%2F(?:storage|rest|auth|realtime|functions|graphql)%2Fv1/i,
      },
      inScript(
        String.raw`createClient\(\s*["']https:\/\/(?!your)[a-z0-9]{20}\.supabase\.co["']`,
        ".supabase.co",
      ),
      ...scriptSrc(
        String.raw`https:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|esm\.sh)\/@supabase\/supabase-js`,
      ),
      // A bundle. Production minifiers mangle `createClient`, so the anchor is the
      // quoted project URL itself, as a call argument or an object value that
      // pairs with a key literal or a url-named property. The URL is quoted
      // whole (no path, an optional slash), so a link, a docs sentence or a
      // fetch to a path never matches, and the match must start in code.
      inBundle(
        String.raw`["'\x60]https:\/\/(?!your)(?!([a-z0-9])\1{19}\.)[a-z0-9]{20}\.supabase\.co\/?["'\x60]\s*,\s*(?:[\w$]{1,20}\s*[:=]\s*)?["'\x60](?:eyJ[A-Za-z0-9_-]{10,}|sb_(?:publishable|secret)_[A-Za-z0-9_-]{10,})`,
        ".supabase.co",
      ),
      inBundle(
        String.raw`\b(?:supabaseUrl|SUPABASE_URL)["']?\s*[:=]\s*["'\x60]https:\/\/(?!your)(?!([a-z0-9])\1{19}\.)[a-z0-9]{20}\.supabase\.co\/?["'\x60]`,
        ".supabase.co",
      ),
      inBundle(
        String.raw`\bcreateClient\)?\(\s*["'\x60]https:\/\/(?!your)(?!([a-z0-9])\1{19}\.)[a-z0-9]{20}\.supabase\.co\/?["'\x60]\s*,`,
        ".supabase.co",
      ),
      // A bundle that ships supabase-js (its Node.js deprecation notice linking
      // github.com/orgs/supabase/discussions/<n>, or its `sb-${ref}-auth-token`
      // storage key) and quotes a project URL anywhere: the URL may sit in a
      // variable with the key in another chunk, or the key may be a new-format
      // one. The library strings are fixed text no other package ships, so the
      // URL needs no key beside it.
      ...[`"`, `'`].map((quote) =>
        inBundleWith(
          String.raw`${quote}https:\/\/(?!your)(?!([a-z0-9])\1{19}\.)[a-z0-9]{20}\.supabase\.co\/?${quote}`,
          `.supabase.co${quote}`,
          String.raw`github\.com\/orgs\/supabase\/discussions\/\d|["'\x60]sb-\$\{[^}]{1,40}\}-auth-token`,
          ["github.com/orgs/supabase/discussions/", "-auth-token"],
        ),
      ),
    ],
    ignoreComments: true,
    // Base44 apps load images from Base44's own shared Supabase storage; that is
    // the platform's backend, not a Supabase choice of the app's author.
    unlessAny: ["base44"],
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
      { type: "html", pattern: /<script\s(?:[^>]{0,400}\s)?data-clerk-js-script\b/i },
      { type: "html", pattern: /<script\s(?:[^>]{0,400}\s)?data-clerk-publishable-key\s*=\s*["']pk_(?:test|live)_/i },
      // A bundle: the publishable key handed to the provider or client, as an
      // object property (quoted or not), an assignment, or the literal Next.js
      // inlines in place of `process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in a
      // `props.publishableKey || <env>` fallback.
      inBundle(
        String.raw`(?:["'](?:publishableKey|NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY|CLERK_PUBLISHABLE_KEY)["']|\b(?:publishableKey|NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY|CLERK_PUBLISHABLE_KEY))\s*(?:[:=]\s*(?:[\w$.]{1,60}\s*(?:\|\||\?\?)\s*)?|(?:\|\||\?\?)\s*)["'\x60]pk_test_[A-Za-z0-9+/=_-]{20,200}["'\x60]`,
        "pk_test_",
      ),
      inBundle(
        String.raw`(?:["'](?:publishableKey|NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY|CLERK_PUBLISHABLE_KEY)["']|\b(?:publishableKey|NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY|CLERK_PUBLISHABLE_KEY))\s*(?:[:=]\s*(?:[\w$.]{1,60}\s*(?:\|\||\?\?)\s*)?|(?:\|\||\?\?)\s*)["'\x60]pk_live_[A-Za-z0-9+/=_-]{20,200}["'\x60]`,
        "pk_live_",
      ),
    ],
    versionPattern: /@clerk\/clerk-js@(\d+(?:\.\d+){0,2})/i,
    ignoreComments: true,
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
      inScript(
        String.raw`authDomain["']?\s*:\s*["'](?!your|my-project|project)[a-z0-9-]{1,63}\.firebaseapp\.com["']`,
        ".firebaseapp.com",
      ),
      // A bundle: the web app config passed to initializeApp (a key may be quoted).
      inBundle(
        String.raw`(?:["']authDomain["']|\bauthDomain)\s*:\s*["'\x60](?!your|my-project|project)[a-z0-9-]{1,63}\.firebaseapp\.com["'\x60]`,
        ".firebaseapp.com",
      ),
      inBundle(
        String.raw`(?:["']storageBucket["']|\bstorageBucket)\s*:\s*["'\x60](?!your|my-project|project)[a-z0-9-]{1,63}\.appspot\.com["'\x60]`,
        ".appspot.com",
      ),
      inBundle(
        String.raw`(?:["']storageBucket["']|\bstorageBucket)\s*:\s*["'\x60](?!your|my-project|project)[a-z0-9-]{1,63}\.firebasestorage\.app["'\x60]`,
        ".firebasestorage.app",
      ),
    ],
    versionPattern: /\/firebasejs\/(\d+\.\d+\.\d+)\/firebase-/i,
    ignoreComments: true,
    confidence: "high",
  },
];
