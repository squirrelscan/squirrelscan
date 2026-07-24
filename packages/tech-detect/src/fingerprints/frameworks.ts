import type { TechFingerprint } from "../types";

export const FRAMEWORK_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "react",
    name: "React",
    category: "framework",
    website: "https://react.dev",
    icon: "react",
    detectors: [
      { type: "html", pattern: /__REACT_DEVTOOLS_GLOBAL_HOOK__/ },
      { type: "html", pattern: /_reactRootContainer/ },
      { type: "html", pattern: /data-reactroot/i },
      {
        type: "script-url",
        pattern: /react(?:-dom)?(?:\.production|\.development)?\.(?:min\.)?js/i,
      },
      { type: "script-content", pattern: /__REACT_DEVTOOLS_GLOBAL_HOOK__/ },
    ],
    versionPattern: /react@(\d+\.\d+\.\d+)/i,
  },
  {
    id: "nextjs",
    name: "Next.js",
    category: "framework",
    website: "https://nextjs.org",
    icon: "nextjs",
    detectors: [
      { type: "html", pattern: /__NEXT_DATA__/ },
      { type: "html", pattern: /_next\/static\// },
      { type: "script-url", pattern: /_next\// },
      { type: "header", name: "x-powered-by", pattern: /Next\.js/i },
    ],
    versionPattern: /Next\.js\s*v?(\d[\d.]*)/i,
  },
  {
    id: "vue",
    name: "Vue.js",
    category: "framework",
    website: "https://vuejs.org",
    icon: "vue",
    detectors: [
      { type: "html", pattern: /data-v-[a-f0-9]+/ },
      { type: "html", pattern: /__VUE__/ },
      { type: "script-content", pattern: /__VUE__/ },
      { type: "script-url", pattern: /vue(?:\.runtime)?(?:\.global)?(?:\.prod)?\.(?:min\.)?js/i },
    ],
    versionPattern: /vue@(\d+\.\d+\.\d+)/i,
  },
  {
    id: "nuxt",
    name: "Nuxt",
    category: "framework",
    website: "https://nuxt.com",
    icon: "nuxt",
    detectors: [
      { type: "html", pattern: /__NUXT__/ },
      { type: "html", pattern: /_nuxt\// },
      { type: "script-url", pattern: /_nuxt\// },
    ],
    versionPattern: /nuxt@(\d+\.\d+\.\d+)/i,
  },
  {
    id: "angular",
    name: "Angular",
    category: "framework",
    website: "https://angular.dev",
    icon: "angular",
    detectors: [
      // Bare `ng-app`/`ng-` substrings false-positive on Tailwind class soup
      // (`tracking-app`, `leading-none`, `tracking-tight`) and URL slugs — #1097.
      // ng-app is anchored to whitespace/`<` before it so it only matches a
      // real HTML attribute (AngularJS 1.x bootstrap), not a word ending in
      // "...ng-app" — including the HTML5-safe `data-ng-app`/`x-ng-app` forms,
      // the documented recommended way to validate pre-2016 AngularJS.
      // ng-star-inserted is anchored to a class="..." context so a bare
      // prose/code-sample mention doesn't match. zone.js is anchored to a
      // path segment so it doesn't match unrelated bundles like
      // "timezone.js" — the trailing anchor also accepts a quote char (not
      // just end-of-string/`?`/`#`) because matchDetector falls back to
      // testing script-url detectors against full HTML whenever
      // input.scripts is absent (the production path for every non-home
      // sampled page), where a src="/zone.js" is followed by a closing
      // quote, not string-end. Detection is headerless HTML-string scanning (no DOM),
      // so a page whose markup literally contains real Angular attribute
      // syntax — inside an HTML comment, an inline <script> string literal,
      // or an unescaped <pre><code> sample — still detects; that residual is
      // inherent to every html-type detector here (ng-version=" has the same
      // exposure) and isn't specific to this fix.
      { type: "html", pattern: /ng-version="/ },
      {
        type: "html",
        // Quote-type-aware (not `[^"']*`) so content containing the opposite
        // quote char between `class=` and the token (e.g. an arbitrary
        // Tailwind value with an apostrophe) doesn't break the match.
        // Anchored to `[\s<"']` immediately before `class` so it only matches
        // a real attribute NAME start — bare `class\s*=` also matched any
        // attribute whose name merely ends in "class" (Vuetify's
        // `content-class="ng-star-inserted"`, `wrapperClass=`, `dataclass=`;
        // `\b` doesn't help since `-` is a non-word boundary character).
        pattern:
          /[\s<"']class\s*=\s*(?:"[^"]*\bng-star-inserted\b[^"]*"|'[^']*\bng-star-inserted\b[^']*')/i,
      },
      { type: "html", pattern: /[\s<](?:data-|x-)?ng-app(?:=|[\s>])/i },
      { type: "script-url", pattern: /@angular\/core/i },
      { type: "script-url", pattern: /(?:^|\/)zone(?:-evergreen)?(?:\.min)?\.js(?:[?#"']|$)/i },
      { type: "script-content", pattern: /getAllAngularRootElements/ },
    ],
    versionPattern: /ng-version="(\d+\.\d+\.\d+)"/,
  },
  {
    id: "svelte",
    name: "Svelte",
    category: "framework",
    website: "https://svelte.dev",
    icon: "svelte",
    detectors: [
      { type: "html", pattern: /class="svelte-[a-z0-9]+"/i },
      { type: "script-content", pattern: /__svelte/ },
      { type: "script-content", pattern: /SvelteComponent/ },
    ],
    versionPattern: /svelte@(\d+\.\d+\.\d+)/i,
  },
  {
    id: "astro",
    name: "Astro",
    category: "framework",
    website: "https://astro.build",
    icon: "astro",
    detectors: [
      { type: "meta", name: "generator", pattern: /Astro/i },
      { type: "html", pattern: /astro-island/i },
      { type: "html", pattern: /astro-slot/i },
    ],
    versionPattern: /Astro\s*v?([\d.]+)/i,
  },
  {
    id: "remix",
    name: "Remix",
    category: "framework",
    website: "https://remix.run",
    icon: "remix",
    detectors: [
      { type: "html", pattern: /__remixContext/ },
      { type: "html", pattern: /__remixManifest/ },
      { type: "script-content", pattern: /__remixContext/ },
    ],
  },
  {
    id: "gatsby",
    name: "Gatsby",
    category: "framework",
    website: "https://gatsbyjs.com",
    icon: "gatsby",
    detectors: [
      { type: "meta", name: "generator", pattern: /Gatsby/i },
      { type: "html", pattern: /___gatsby/ },
      { type: "html", pattern: /gatsby-image/ },
    ],
    versionPattern: /Gatsby\s*([\d.]+)/i,
  },
  {
    id: "htmx",
    name: "htmx",
    category: "framework",
    website: "https://htmx.org",
    icon: "htmx",
    detectors: [
      { type: "script-url", pattern: /htmx(?:\.min)?\.js/i },
      { type: "html", pattern: /hx-(?:get|post|put|delete|patch)=/i },
    ],
  },
];
