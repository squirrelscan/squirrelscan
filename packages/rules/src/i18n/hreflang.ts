// i18n/hreflang - Checks for hreflang tags

import type { Rule, RuleContext, RuleResult, CheckResult, CheckItem } from "../types";

import { documentUrl } from "../shared/redirect-evidence";

// ISO 639-1 two-letter language codes, plus the legacy iw, in and ji that
// Google still accepts. Three-letter codes (ISO 639-2/3) are accepted by shape.
const LANGUAGES_639_1 = new Set(
  (
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz " +
    "ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik " +
    "io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml " +
    "mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd " +
    "se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi " +
    "vo wa wo xh yi yo za zh zu iw in ji"
  ).split(" "),
);

// ISO 3166-1 alpha-2 region codes, plus XK (Kosovo, user-assigned, in common use).
const REGIONS_3166_1 = new Set(
  (
    "ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz " +
    "ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr " +
    "ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp " +
    "ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms " +
    "mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs " +
    "ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw " +
    "tz ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw xk"
  ).split(" "),
);

/**
 * Why an hreflang value is not `x-default` or `language[-script][-region]`, or
 * null when it is. Case-insensitive. Checks code format only.
 */
function hreflangProblem(raw: string): { reason: string; suggestion?: string } | null {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower === "x-default") return null;

  if (value.includes("_")) {
    const fixed = value
      .split("_")
      .map((part, i) => (i === 0 ? part.toLowerCase() : part.length === 2 ? part.toUpperCase() : part))
      .join("-");
    return { reason: "uses an underscore instead of a hyphen", suggestion: fixed };
  }

  const parts = lower.split("-");
  const lang = parts[0] ?? "";
  if (!/^[a-z]{2,3}$/.test(lang)) {
    return { reason: "language is not a 2 or 3 letter code" };
  }
  if (lang.length === 2 && !LANGUAGES_639_1.has(lang)) {
    return { reason: `"${lang}" is not an ISO 639-1 language code` };
  }

  let i = 1;
  if (i < parts.length && /^[a-z]{4}$/.test(parts[i] ?? "")) i++;
  if (i < parts.length) {
    const region = parts[i] ?? "";
    if (/^[a-z]{2}$/.test(region)) {
      if (!REGIONS_3166_1.has(region)) {
        return {
          reason: `"${region.toUpperCase()}" is not an ISO 3166-1 region code`,
          ...(region === "uk" ? { suggestion: [...parts.slice(0, i), "GB"].join("-") } : {}),
        };
      }
    } else if (!/^\d{3}$/.test(region)) {
      return { reason: `"${region}" is not a script, region or UN M.49 code` };
    }
    i++;
  }
  if (i < parts.length) {
    return { reason: "has subtags after the region; hreflang takes language, script and region only" };
  }
  return null;
}

export const hreflangRule: Rule = {
  meta: {
    id: "i18n/hreflang",
    name: "Hreflang Tags",
    description: "Checks for hreflang link elements",
    solution:
      "Hreflang tags tell search engines about language and regional variations of pages, preventing duplicate content issues and ensuring users see the right version. Add hreflang link tags for each language/region version of a page. Include x-default for the fallback. Every page referenced should link back to all variants (bidirectional). Use correct ISO language and country codes.",
    category: "i18n",
    scope: "page",
    verdictScope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const hreflangs = doc.querySelectorAll('link[rel="alternate"][hreflang]');

    if (hreflangs.length === 0) {
      // This is only informational - not all pages need hreflang
      checks.push({
        name: "hreflang",
        status: "info",
        message:
          "No hreflang tags found (not required for single-language sites)",
        value: null,
      });
      return { checks };
    }

    // pub#827: a URL the crawl followed through an HTTP redirect is stored
    // with its target's response, so the self reference names the URL the
    // redirect ended on, never the one that redirected.
    const selfUrl = documentUrl(ctx.page);

    // Check for x-default
    let hasXDefault = false;
    let hasSelfReference = false;
    const languages: string[] = [];
    const invalidCodes: CheckItem[] = [];

    for (const link of hreflangs) {
      const hreflang = (link as Element).getAttribute("hreflang");
      const href = (link as Element).getAttribute("href");

      if (hreflang) {
        languages.push(hreflang);
        const problem = hreflangProblem(hreflang);
        if (problem) {
          invalidCodes.push({
            id: hreflang,
            label: problem.suggestion
              ? `${problem.reason}; use ${problem.suggestion}`
              : problem.reason,
          });
        }
        if (hreflang === "x-default") {
          hasXDefault = true;
        }
        // Check if this is self-referencing
        if (href) {
          try {
            const linkUrl = new URL(href, selfUrl);
            const pageUrl = new URL(selfUrl);
            if (linkUrl.href === pageUrl.href) {
              hasSelfReference = true;
            }
          } catch {
            // Ignore URL parsing errors
          }
        }
      }
    }

    if (!hasXDefault) {
      checks.push({
        name: "hreflang-xdefault",
        status: "warn",
        message: "No x-default hreflang found",
        value: null,
      });
    }

    if (!hasSelfReference) {
      checks.push({
        name: "hreflang-self",
        status: "warn",
        message: "No self-referencing hreflang found",
        value: null,
      });
    }

    if (invalidCodes.length > 0) {
      checks.push({
        name: "hreflang-codes",
        status: "warn",
        message: `${invalidCodes.length} invalid hreflang code(s): ${invalidCodes.map((c) => c.id).join(", ")}`,
        value: invalidCodes.length,
        items: invalidCodes,
      });
    }

    checks.push({
      name: "hreflang",
      status: "pass",
      message: `${hreflangs.length} hreflang tag(s) found`,
      items: languages.map((lang) => ({ id: lang })),
    });

    return { checks };
  },
};
