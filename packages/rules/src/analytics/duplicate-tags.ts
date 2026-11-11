// analytics/duplicate-tags - the same analytics tag installed more than once on a page

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

interface Platform {
  key: string;
  label: string;
  idLabel: string;
}

const GA4: Platform = { key: "ga4", label: "Google Analytics 4", idLabel: "measurement ID" };
const GTM: Platform = { key: "gtm", label: "Google Tag Manager", idLabel: "container ID" };
const PLAUSIBLE: Platform = { key: "plausible", label: "Plausible", idLabel: "site" };
const FATHOM: Platform = { key: "fathom", label: "Fathom", idLabel: "site ID" };
const MATOMO: Platform = { key: "matomo", label: "Matomo", idLabel: "site ID" };
const SEGMENT: Platform = { key: "segment", label: "Segment", idLabel: "write key" };
const MIXPANEL: Platform = { key: "mixpanel", label: "Mixpanel", idLabel: "project token" };
const AMPLITUDE: Platform = { key: "amplitude", label: "Amplitude", idLabel: "API key" };
const HEAP: Platform = { key: "heap", label: "Heap", idLabel: "app ID" };
const HOTJAR: Platform = { key: "hotjar", label: "Hotjar", idLabel: "site ID" };
const CLARITY: Platform = { key: "clarity", label: "Microsoft Clarity", idLabel: "project ID" };

/** Report order: stable, so the same page always yields the same checks. */
const PLATFORMS: Platform[] = [GA4, GTM, PLAUSIBLE, FATHOM, MATOMO, SEGMENT, MIXPANEL, AMPLITUDE, HEAP, HOTJAR, CLARITY];

/**
 * Two kinds of evidence per (platform, id). `loader` is the script or frame that
 * fetches the tag; `init` is its companion: the inline call that configures it, or the GTM noscript frame. A standard
 * install is one of each (GA4 loader plus `config`, GTM script plus noscript
 * frame), so the install count is the larger of the two, not their sum.
 */
interface Tally {
  platform: Platform;
  id: string;
  loader: number;
  init: number;
}

const GTM_ID = String.raw`GTM-[A-Z0-9]{3,}`;
const GA4_ID = String.raw`G-[A-Z0-9]{4,}`;

function qs(url: string, name: string): string | null {
  const m = new RegExp(`[?&]${name}=([^&#\\s"']+)`, "i").exec(url);
  return m ? m[1]! : null;
}

export const duplicateTagsRule: Rule = {
  meta: {
    id: "analytics/duplicate-tags",
    name: "Duplicate Analytics Tags",
    description: "Checks that no analytics tag is installed more than once on a page",
    solution:
      "Load each analytics tag once per page. A tag added in the site template and again through a tag manager or a plugin counts every pageview and event twice. Remove one of the installs: keep the one your team controls and delete the other from the template, the plugin settings or the tag manager container.",
    category: "analytics",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const tallies = new Map<string, Tally>();
    const bump = (platform: Platform, id: string, kind: "loader" | "init") => {
      const key = `${platform.key}\u0000${id.toLowerCase()}`;
      let t = tallies.get(key);
      if (!t) {
        t = { platform, id, loader: 0, init: 0 };
        tallies.set(key, t);
      }
      t[kind]++;
    };

    // Loader scripts and noscript frames. <link rel=preload|preconnect> is never read.
    for (const script of doc.querySelectorAll("script[src]")) {
      const src = script.getAttribute("src") || "";
      let m: RegExpExecArray | null;
      if (/googletagmanager\.com\/gtm\.js/i.test(src)) {
        const id = qs(src, "id");
        if (id && new RegExp(`^${GTM_ID}$`, "i").test(id)) bump(GTM, id, "loader");
      } else if (/googletagmanager\.com\/gtag\/js/i.test(src)) {
        const id = qs(src, "id");
        if (id && new RegExp(`^${GA4_ID}$`, "i").test(id)) bump(GA4, id, "loader");
      } else if (/plausible/i.test(src) && /\.js(\?|#|$)/i.test(src)) {
        const id = script.getAttribute("data-domain") || /\/pa-([\w-]+)\.js/i.exec(src)?.[1];
        if (id) bump(PLAUSIBLE, id, "loader");
      } else if (/fathom/i.test(src) && /\.js(\?|#|$)/i.test(src)) {
        const id = script.getAttribute("data-site");
        if (id) bump(FATHOM, id, "loader");
      } else if ((m = /cdn\.segment\.(?:com|io)\/analytics\.js\/v1\/([\w-]+)\/analytics(?:\.min)?\.js/i.exec(src))) {
        bump(SEGMENT, m[1]!, "loader");
      } else if ((m = /cdn\.(?:eu\.)?amplitude\.com\/script\/([\w-]+)\.js/i.exec(src))) {
        bump(AMPLITUDE, m[1]!, "loader");
      } else if ((m = /heapanalytics\.com\/js\/heap-([\w-]+)\.js/i.exec(src))) {
        bump(HEAP, m[1]!, "loader");
      } else if ((m = /static\.hotjar\.com\/c\/hotjar-([\w-]+)\.js/i.exec(src))) {
        bump(HOTJAR, m[1]!, "loader");
      } else if ((m = /clarity\.ms\/tag\/([\w-]+)/i.exec(src))) {
        bump(CLARITY, m[1]!, "loader");
      }
    }

    for (const frame of doc.querySelectorAll("iframe[src]")) {
      const src = frame.getAttribute("src") || "";
      if (!/googletagmanager\.com\/ns\.html/i.test(src)) continue;
      const id = qs(src, "id");
      if (id && new RegExp(`^${GTM_ID}$`, "i").test(id)) bump(GTM, id, "init");
    }

    // Inline snippets. Each inline <script> counts a given (platform, id) once per call.
    for (const script of doc.querySelectorAll("script:not([src])")) {
      const type = (script.getAttribute("type") || "").toLowerCase();
      if (/json|importmap|speculationrules/.test(type)) continue;
      const text = script.textContent || "";
      if (!text) continue;
      const each = (re: RegExp, platform: Platform, kind: "loader" | "init" = "init") => {
        for (const m of text.matchAll(re)) if (m[1]) bump(platform, m[1], kind);
      };

      each(new RegExp(String.raw`gtag\s*\(\s*['"]config['"]\s*,\s*['"](${GA4_ID})['"]`, "gi"), GA4);
      // The standard GTM snippet names its container as the last argument; the
      // gtm.js URL in the same script proves it is the loader and not a mention.
      if (/googletagmanager\.com\/gtm\.js/i.test(text)) {
        each(new RegExp(String.raw`['"](${GTM_ID})['"]\s*\)`, "gi"), GTM, "loader");
      }
      each(/\[\s*['"]setSiteId['"]\s*,\s*['"]?(\d+)['"]?\s*\]/gi, MATOMO);
      each(/\banalytics\.load\s*\(\s*['"]([\w-]+)['"]/gi, SEGMENT);
      each(/\bmixpanel\.init\s*\(\s*['"]([\w-]+)['"]/gi, MIXPANEL);
      each(/\bamplitude\.init\s*\(\s*['"]([\w-]+)['"]/gi, AMPLITUDE);
      each(/\bheap\.load\s*\(\s*['"]([\w-]+)['"]/gi, HEAP);
      each(/\bhjid\s*:\s*['"]?(\d+)/gi, HOTJAR);
      if (/clarity\.ms\/tag/i.test(text)) {
        each(/['"]clarity['"]\s*,\s*['"]script['"]\s*,\s*['"]([\w-]+)['"]/gi, CLARITY);
      }
    }

    const checks: CheckResult[] = [];
    const duplicates: Tally[] = [];
    for (const t of tallies.values()) {
      // Platforms where only one half is possible (Plausible, Fathom, Matomo,
      // Mixpanel, Hotjar inline) still take the larger count.
      if (Math.max(t.loader, t.init) > 1) duplicates.push(t);
    }
    duplicates.sort(
      (a, b) =>
        PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) ||
        (a.id.toLowerCase() < b.id.toLowerCase() ? -1 : a.id.toLowerCase() > b.id.toLowerCase() ? 1 : 0),
    );

    for (const t of duplicates) {
      const count = Math.max(t.loader, t.init);
      checks.push({
        name: "duplicate-tags",
        status: "warn",
        message: `${t.platform.label} ${t.platform.idLabel} ${t.id} is installed ${count} times`,
        value: count,
        items: [{ id: t.id, label: t.platform.label }],
      });
    }

    if (checks.length === 0) {
      checks.push({
        name: "duplicate-tags",
        status: "pass",
        message: "No analytics tag is installed more than once",
      });
    }
    return { checks };
  },
};
