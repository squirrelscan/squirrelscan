// performance/js-libraries - Detect known JS libraries and versions
// Detects client-side JavaScript libraries and known vulnerabilities

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Known library detection patterns
interface LibraryPattern {
  name: string;
  // URL patterns for script src matching
  urlPatterns: RegExp[];
  // Inline code patterns for detection in bundled/inline code
  inlinePatterns: RegExp[];
  // Patterns to extract version numbers
  versionPatterns: RegExp[];
  // Known vulnerabilities
  vulnerability?: {
    maxVersion: string;
    severity: "low" | "medium" | "high" | "critical";
    cve?: string;
    description: string;
  }[];
}

const libraryPatterns: LibraryPattern[] = [
  // === Core Frameworks ===
  {
    name: "jQuery",
    urlPatterns: [
      /jquery[.-]?(\d+\.\d+\.\d+)?\.(?:min\.)?js/i,
      /jquery@/i,
      /\/jquery\//i,
    ],
    inlinePatterns: [
      /jQuery\.fn\.jquery/,
      /\$\.fn\.jquery/,
      /["']jquery["']\s*:/i,
    ],
    versionPatterns: [
      /jquery[.-]v?(\d+\.\d+\.\d+)/i,
      /jQuery\s+v?(\d+\.\d+\.\d+)/,
      /jquery\/(\d+\.\d+\.\d+)\//i,
      /jquery@(\d+\.\d+\.\d+)/i,
    ],
    vulnerability: [
      {
        maxVersion: "3.5.0",
        severity: "medium",
        cve: "CVE-2020-11022",
        description: "XSS vulnerability in jQuery.htmlPrefilter",
      },
      {
        maxVersion: "1.12.0",
        severity: "high",
        cve: "CVE-2015-9251",
        description: "Multiple XSS vulnerabilities",
      },
    ],
  },
  {
    name: "React",
    urlPatterns: [/react[.-]?(\d+)?\.(?:min\.)?js/i, /react-dom/i, /react@/i],
    inlinePatterns: [
      /__REACT_DEVTOOLS_GLOBAL_HOOK__/,
      /_reactRootContainer/,
      /react\.development/i,
      /react\.production/i,
      /\["__reactFiber/,
    ],
    versionPatterns: [
      /react\/(\d+\.\d+\.\d+)/i,
      /react@(\d+\.\d+\.\d+)/i,
      /react-dom@(\d+\.\d+\.\d+)/i,
    ],
  },
  {
    name: "Vue.js",
    urlPatterns: [/vue[.-]?(\d+)?\.(?:min\.)?js/i, /vue@/i, /\/vue\//i],
    inlinePatterns: [
      /__VUE__/,
      /__vue__/,
      /Vue\.version/,
      /vue\.runtime/i,
      /\$mount\(/,
    ],
    versionPatterns: [/vue\/(\d+\.\d+\.\d+)/i, /vue@(\d+\.\d+\.\d+)/i],
  },
  {
    name: "Angular",
    urlPatterns: [
      /angular[.-]?(\d+)?\.(?:min\.)?js/i,
      /@angular\/core/i,
      /angular@/i,
    ],
    inlinePatterns: [
      /ng-version/,
      /getAllAngularRootElements/,
      /\["ɵcmp"\]/,
      /__ANGULAR_DEVTOOLS_GLOBAL__/,
    ],
    versionPatterns: [
      /angular\/(\d+\.\d+\.\d+)/i,
      /@angular\/core@(\d+\.\d+\.\d+)/i,
      /ng-version="(\d+\.\d+\.\d+)"/,
    ],
  },
  {
    name: "Svelte",
    urlPatterns: [/svelte[.-]?(\d+)?\.(?:min\.)?js/i, /svelte@/i],
    inlinePatterns: [/__svelte/i, /SvelteComponent/, /svelte\/internal/],
    versionPatterns: [/svelte\/(\d+\.\d+\.\d+)/i, /svelte@(\d+\.\d+\.\d+)/i],
  },
  {
    name: "Next.js",
    urlPatterns: [/next[.-]?(\d+)?\.(?:min\.)?js/i, /next@/i, /_next\//],
    inlinePatterns: [/__NEXT_DATA__/, /__next/, /next\/router/],
    versionPatterns: [/next\/(\d+\.\d+\.\d+)/i, /next@(\d+\.\d+\.\d+)/i],
  },
  {
    name: "Nuxt",
    urlPatterns: [/nuxt[.-]?(\d+)?\.(?:min\.)?js/i, /nuxt@/i, /_nuxt\//],
    inlinePatterns: [/__NUXT__/, /__nuxt/, /nuxt\/app/],
    versionPatterns: [/nuxt\/(\d+\.\d+\.\d+)/i, /nuxt@(\d+\.\d+\.\d+)/i],
  },

  // === UI Frameworks ===
  {
    name: "Bootstrap",
    urlPatterns: [
      /bootstrap[.-]?(\d+)?\.(?:min\.)?js/i,
      /bootstrap\.bundle/i,
      /bootstrap@/i,
    ],
    inlinePatterns: [/bootstrap\/js/, /\.modal\(/, /\.tooltip\(/],
    versionPatterns: [
      /bootstrap\/(\d+\.\d+\.\d+)/i,
      /bootstrap@(\d+\.\d+\.\d+)/i,
    ],
    vulnerability: [
      {
        maxVersion: "4.3.1",
        severity: "medium",
        cve: "CVE-2019-8331",
        description: "XSS vulnerability in tooltip/popover",
      },
    ],
  },
  {
    name: "Tailwind CSS",
    urlPatterns: [/tailwind[.-]?(\d+)?\.(?:min\.)?(?:css|js)/i, /tailwindcss/i],
    inlinePatterns: [], // Tailwind is typically CSS-only or build-time
    versionPatterns: [
      /tailwindcss\/(\d+\.\d+\.\d+)/i,
      /tailwindcss@(\d+\.\d+\.\d+)/i,
    ],
  },

  // === Utility Libraries ===
  {
    name: "Lodash",
    urlPatterns: [/lodash[.-]?(\d+)?\.(?:min\.)?js/i, /lodash@/i, /lodash-es/i],
    inlinePatterns: [/_\.VERSION/, /lodash\./, /\["lodash"\]/],
    versionPatterns: [
      /lodash\/(\d+\.\d+\.\d+)/i,
      /lodash@(\d+\.\d+\.\d+)/i,
      /lodash-es@(\d+\.\d+\.\d+)/i,
    ],
    vulnerability: [
      {
        maxVersion: "4.17.20",
        severity: "high",
        cve: "CVE-2021-23337",
        description: "Prototype pollution vulnerability",
      },
    ],
  },
  {
    name: "Underscore.js",
    urlPatterns: [/underscore[.-]?(\d+)?\.(?:min\.)?js/i, /underscore@/i],
    inlinePatterns: [/_\.VERSION/, /underscore\.js/],
    versionPatterns: [/underscore\/(\d+\.\d+\.\d+)/i],
  },

  // === Date/Time ===
  {
    name: "Moment.js",
    urlPatterns: [
      /moment[.-]?(\d+)?\.(?:min\.)?js/i,
      /moment-with-locales/i,
      /moment@/i,
    ],
    inlinePatterns: [/moment\.version/, /moment\(/, /\.locale\(/],
    versionPatterns: [/moment\/(\d+\.\d+\.\d+)/i, /moment@(\d+\.\d+\.\d+)/i],
  },
  {
    name: "Day.js",
    urlPatterns: [/dayjs[.-]?(\d+)?\.(?:min\.)?js/i, /dayjs@/i],
    inlinePatterns: [/dayjs\(/, /\$d\.getTime/],
    versionPatterns: [/dayjs\/(\d+\.\d+\.\d+)/i, /dayjs@(\d+\.\d+\.\d+)/i],
  },

  // === HTTP/Ajax ===
  {
    name: "Axios",
    urlPatterns: [/axios[.-]?(\d+)?\.(?:min\.)?js/i, /axios@/i],
    inlinePatterns: [/axios\./, /\.interceptors\./],
    versionPatterns: [/axios\/(\d+\.\d+\.\d+)/i, /axios@(\d+\.\d+\.\d+)/i],
  },

  // === State Management ===
  {
    name: "Redux",
    urlPatterns: [/redux[.-]?(\d+)?\.(?:min\.)?js/i, /redux@/i],
    inlinePatterns: [
      /__REDUX_DEVTOOLS_EXTENSION__/,
      /createStore/,
      /combineReducers/,
    ],
    versionPatterns: [/redux\/(\d+\.\d+\.\d+)/i, /redux@(\d+\.\d+\.\d+)/i],
  },

  // === Visualization ===
  {
    name: "D3.js",
    urlPatterns: [/d3[.-]?(\d+)?\.(?:min\.)?js/i, /d3@/i],
    inlinePatterns: [/d3\.select/, /d3\.scale/, /d3\.axis/],
    versionPatterns: [/d3\/(\d+\.\d+\.\d+)/i, /d3@(\d+\.\d+\.\d+)/i],
  },
  {
    name: "Chart.js",
    urlPatterns: [/chart[.-]?(\d+)?\.(?:min\.)?js/i, /chart\.js/i],
    inlinePatterns: [/new Chart\(/, /Chart\.register/],
    versionPatterns: [
      /chart\.js\/(\d+\.\d+\.\d+)/i,
      /chart\.js@(\d+\.\d+\.\d+)/i,
    ],
  },
  {
    name: "Three.js",
    urlPatterns: [/three[.-]?(\d+)?\.(?:min\.)?js/i, /three@/i],
    inlinePatterns: [/THREE\./, /WebGLRenderer/, /PerspectiveCamera/],
    versionPatterns: [/three\/(\d+\.\d+\.\d+)/i, /three@(\d+\.\d+\.\d+)/i],
  },

  // === Animation ===
  {
    name: "GSAP",
    urlPatterns: [/gsap[.-]?(\d+)?\.(?:min\.)?js/i, /gsap@/i],
    inlinePatterns: [/gsap\./, /TweenMax/, /TweenLite/, /TimelineMax/],
    versionPatterns: [/gsap\/(\d+\.\d+\.\d+)/i, /gsap@(\d+\.\d+\.\d+)/i],
  },

  // === Legacy/Problematic ===
  {
    name: "Prototype.js",
    urlPatterns: [/prototype[.-]?(\d+)?\.(?:min\.)?js/i],
    inlinePatterns: [/Prototype\.Version/, /\$\$\(/],
    versionPatterns: [/Prototype\.Version\s*=\s*['"](\d+\.\d+\.\d+)['"]/],
    vulnerability: [
      {
        maxVersion: "1.7.3",
        severity: "high",
        description: "Multiple vulnerabilities, unmaintained library",
      },
    ],
  },
  {
    name: "MooTools",
    urlPatterns: [/mootools[.-]?(\d+)?\.(?:min\.)?js/i],
    inlinePatterns: [/MooTools\./, /\.addEvent\(/],
    versionPatterns: [/mootools\/(\d+\.\d+\.\d+)/i],
  },
  {
    name: "YUI",
    urlPatterns: [/yui[.-]?(\d+)?\.(?:min\.)?js/i],
    inlinePatterns: [/YUI\.version/, /YUI\(/],
    versionPatterns: [/YUI\.version\s*=\s*['"](\d+\.\d+\.\d+)['"]/],
    vulnerability: [
      {
        maxVersion: "3.18.1",
        severity: "medium",
        description: "End of life, no security updates",
      },
    ],
  },
];

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map((p) => Number.parseInt(p, 10));
  const parts2 = v2.split(".").map((p) => Number.parseInt(p, 10));

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

export const jsLibrariesRule: Rule = {
  meta: {
    id: "perf/js-libraries",
    name: "JS Libraries",
    description:
      "Detects JavaScript libraries and checks for known vulnerabilities",
    solution:
      "Keep JavaScript libraries updated to their latest versions. Outdated libraries may contain security vulnerabilities that attackers can exploit. Consider replacing large libraries like jQuery with modern vanilla JavaScript or smaller alternatives. Use npm audit or Snyk to monitor dependencies for vulnerabilities.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    const html = ctx.page.html;
    if (!doc || !html) return { checks: [] };

    const checks: CheckResult[] = [];
    const detectedLibraries: Array<{
      name: string;
      version?: string;
      source?: string;
      vulnerable?: boolean;
      vulnerability?: string;
      cve?: string;
    }> = [];

    // Collect all script sources and inline scripts
    const scriptSources: string[] = [];
    const inlineScripts: string[] = [];

    const scripts = doc.querySelectorAll("script");
    for (const script of scripts) {
      const src = script.getAttribute("src");
      if (src) {
        scriptSources.push(src);
      }
      const content = script.textContent;
      if (content && content.length > 50) {
        inlineScripts.push(content);
      }
    }

    // Also check script content from site data if available
    if (ctx.site?.scripts) {
      for (const script of ctx.site.scripts) {
        if (script.url) {
          scriptSources.push(script.url);
        }
        if (script.content && script.content.length > 50) {
          inlineScripts.push(script.content);
        }
      }
    }

    // Check HTML for runtime markers (framework signatures in DOM)
    const htmlContent = html;

    // Check for libraries
    for (const lib of libraryPatterns) {
      let detected = false;
      let detectedVersion: string | undefined;
      let detectionSource: string | undefined;

      // Check script URLs
      for (const src of scriptSources) {
        for (const pattern of lib.urlPatterns) {
          if (pattern.test(src)) {
            detected = true;
            detectionSource = "script URL";
            // Try to extract version from URL
            for (const vp of lib.versionPatterns) {
              const match = src.match(vp);
              if (match?.[1]) {
                detectedVersion = match[1];
                break;
              }
            }
            break;
          }
        }
        if (detected && detectedVersion) break;
      }

      // Check inline/bundled scripts for library signatures
      if (!detected && lib.inlinePatterns.length > 0) {
        for (const content of inlineScripts) {
          for (const pattern of lib.inlinePatterns) {
            if (pattern.test(content)) {
              detected = true;
              detectionSource = "inline code";
              // Try to extract version from content
              for (const vp of lib.versionPatterns) {
                const match = content.match(vp);
                if (match?.[1]) {
                  detectedVersion = match[1];
                  break;
                }
              }
              break;
            }
          }
          if (detected) break;
        }
      }

      // Check HTML for framework signatures (e.g., ng-version attribute)
      if (!detected && lib.inlinePatterns.length > 0) {
        for (const pattern of lib.inlinePatterns) {
          if (pattern.test(htmlContent)) {
            detected = true;
            detectionSource = "HTML markers";
            // Try to extract version from HTML
            for (const vp of lib.versionPatterns) {
              const match = htmlContent.match(vp);
              if (match?.[1]) {
                detectedVersion = match[1];
                break;
              }
            }
            break;
          }
        }
      }

      if (detected) {
        const libraryInfo: (typeof detectedLibraries)[0] = {
          name: lib.name,
          source: detectionSource,
        };

        if (detectedVersion) {
          libraryInfo.version = detectedVersion;

          // Check for vulnerabilities
          if (lib.vulnerability) {
            for (const vuln of lib.vulnerability) {
              if (compareVersions(detectedVersion, vuln.maxVersion) <= 0) {
                libraryInfo.vulnerable = true;
                libraryInfo.vulnerability = vuln.description;
                libraryInfo.cve = vuln.cve;
                break;
              }
            }
          }
        }

        // Avoid duplicates
        if (!detectedLibraries.some((l) => l.name === lib.name)) {
          detectedLibraries.push(libraryInfo);
        }
      }
    }

    // Report findings
    if (detectedLibraries.length > 0) {
      const vulnerableLibs = detectedLibraries.filter((l) => l.vulnerable);

      if (vulnerableLibs.length > 0) {
        checks.push({
          name: "js-libraries-vulnerable",
          status: "fail",
          message: `${vulnerableLibs.length} library/libraries with known vulnerabilities`,
          items: vulnerableLibs.map((l) => ({
            id: `${l.name}${l.version ? ` v${l.version}` : ""}`,
            label: l.vulnerability,
            meta: { cve: l.cve },
          })),
        });
      }

      checks.push({
        name: "js-libraries-detected",
        status: vulnerableLibs.length > 0 ? "warn" : "info",
        message: `${detectedLibraries.length} JavaScript library/libraries detected`,
        items: detectedLibraries.map((l) => ({
          id: `${l.name}${l.version ? ` v${l.version}` : ""}`,
          label: l.vulnerable ? "vulnerable" : l.source,
        })),
      });
    } else {
      checks.push({
        name: "js-libraries",
        status: "info",
        message: "No common JavaScript libraries detected",
      });
    }

    return { checks };
  },
};
