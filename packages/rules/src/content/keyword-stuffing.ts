// content/keyword-stuffing - Excessive keyword repetition detection

import { getDomainWithoutSuffix } from "tldts";
import { z } from "zod";

import { primaryLangSubtag } from "../shared/generic-link-phrases";
import type { Rule, RuleContext, RuleResult, CheckResult, ParsedPage } from "../types";
import { getTextExcludingScripts } from "./text-content";

export const optionsSchema = z.object({
  density_threshold: z.number().default(3).describe("Keyword density percentage threshold"),
  min_occurrences: z.number().default(5).describe("Minimum word occurrences to flag"),
  whitelist: z
    .array(z.string())
    .default([])
    .describe("Words to ignore; the site's own brand name is already ignored"),
});

// Prefixes and suffixes launch domains wrap around a product name
// (getacme.com, acmehq.com, tryacme.app).
const DOMAIN_PREFIXES = ["get", "try", "use", "join", "hey", "with", "go"];
const DOMAIN_SUFFIXES = ["hq", "app", "labs", "lab", "ai", "io", "inc"];

// English applies on every page to preserve the rule's existing behaviour
// when lang is absent or unknown. A recognised page language adds its own
// grammatical filler, using the same primary-subtag parsing as link-text.
function wordSet(...groups: string[]): ReadonlySet<string> {
  return new Set(groups.flatMap((group) => group.split(" ")));
}

const COMMON_WORDS = wordSet(
  "the and that have for not with you this but from they will would there their what about which when make can like been more some than them other into could just also",
  // Function words / generic verbs (#695) that read as high density on
  // ordinary pages, never as a real SEO target.
  "your our his her its who whom whose get here very such same each any all most much many even still yet",
);

const LANGUAGE_STOP_WORDS = new Map<string, ReadonlySet<string>>([
  [
    "de",
    wordSet(
      "aber alle allem allen aller alles als also ander andere anderem anderen anderer anderes auch auf aus bei bin bis bist damit dann das dass dein deine dem den denn der des die dies diese",
      "ein eine einem einen einer eines etwas hat haben hier ich ihr ihre ist jede kein keine man mehr mein meine mit nach nicht noch nun nur oder sein seine sind solche und uns unser",
      "vom von war waren was wenn wer wie wir wird zum zur",
    ),
  ],
  [
    "es",
    wordSet(
      "algo algunas algunos ante antes aquel aqui bajo bien cada como con contra cual cuando del desde donde durante ella ellas ellos entre era eran esta estas este estos fue fueron",
      "hacia hasta hay las los mas mientras muy nada nos nosotros otra otras otro otros para pero poco por porque que quien ser sin sobre son sus tanto tiene todo todos una unas uno unos",
    ),
  ],
  [
    "fr",
    wordSet(
      "alors aucun aussi autre aux avec avoir car ceci cela ces cette comme dans des donc elle elles encore entre est eux faire fois ils les leur leurs mais mes moins mon nos notre nous",
      "par parce pas peut plus pourquoi quand que quel quelle qui sans ses son sont sous sur tous tout tres une vos votre vous",
    ),
  ],
  [
    "pt",
    wordSet(
      "ainda algo algumas alguns assim ate bem cada como com contra das dela dele deles depois desde dos durante ela elas ele eles entre essa essas esse esses esta estas este estes foi foram",
      "isso isto mais mas mesmo muito nao nas nos nossa nosso numa onde outra outras outro outros para pela pelas pelo pelos por porque qual quando que quem sem ser seus sua suas sobre sao tem todo todos uma umas uns voce voces",
    ),
  ],
  [
    "it",
    wordSet(
      "alcune alcuni altro anche ancora avere che chi come con contro cui dagli dai dal dalla dalle degli dei del della delle dentro deve dove due era erano essere fare fra gli hanno lei loro",
      "mai molto nei nel nella nelle noi non ogni per pero piu quale quando questa queste questi questo sara senza sia siamo sono sua sue sul sulla tra tutti tutto una uno voi",
    ),
  ],
  [
    "nl",
    wordSet(
      "aan alle als bij dan dat deze die dit door een had hebben heeft hem het hier hij hoe hun kan maar meer met mij moet naar niet nog ook ons onze over tot uit van veel voor want",
      "waren was wat wel werd worden zal zijn zonder zou",
    ),
  ],
]);

/**
 * The site's own brand / product name as lowercase word tokens, from the page's
 * registrable domain label plus any `og:site_name` / `application-name` token
 * that also appears in that label. A one-product landing page repeats its own
 * name because that is what the page is for, so these never count as stuffing.
 *
 * Anchored on the domain on purpose: a site name is page-controlled text, and a
 * spam page could set it to the keyword it stuffs. A name token only counts when
 * the site's own domain carries it too.
 */
export function brandTerms(
  pageUrl: string,
  doc: NonNullable<ParsedPage["document"]>
): Set<string> {
  const terms = new Set<string>();
  let label = "";
  try {
    label = (getDomainWithoutSuffix(new URL(pageUrl).hostname) || "").toLowerCase();
  } catch {
    return terms;
  }
  // Only a single-word label is a brand token: "cheap-plumber-london" names
  // keywords, not a brand, and never matched one [a-z]{3,} token anyway.
  if (!/^[a-z]{3,}$/.test(label)) return terms;
  terms.add(label);
  for (const prefix of DOMAIN_PREFIXES) {
    if (label.startsWith(prefix) && label.length - prefix.length >= 3) {
      terms.add(label.slice(prefix.length));
    }
  }
  for (const suffix of DOMAIN_SUFFIXES) {
    if (label.endsWith(suffix) && label.length - suffix.length >= 3) {
      terms.add(label.slice(0, -suffix.length));
    }
  }

  const names = [
    doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content"),
    doc.querySelector('meta[name="application-name"]')?.getAttribute("content"),
  ];
  for (const name of names) {
    for (const word of name?.toLowerCase().match(/[a-z]{3,}/g) || []) {
      if (label.includes(word)) terms.add(word);
    }
  }
  return terms;
}

export const keywordStuffingRule: Rule = {
  meta: {
    id: "content/keyword-stuffing",
    name: "Keyword Stuffing",
    description: "Detects excessive keyword repetition in content",
    solution:
      "Keyword stuffing is repeating words unnaturally to manipulate rankings. Search engines penalize this practice. Write naturally for users first. Use keywords where they fit naturally. Aim for 1-2% keyword density at most. Use synonyms and related terms instead of repeating the exact same phrase. Focus on providing value, not gaming algorithms.",
    category: "content",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Get text content
    const body = doc.querySelector("body");
    if (!body) {
      checks.push({
        name: "keyword-stuffing",
        status: "skipped",
        message: "No body content to analyze",
      });
      return { checks };
    }

    // Body text with script/style/noscript excluded (non-mutating — the parsed
    // document is shared across all rules for this page).
    const text = getTextExcludingScripts(body);
    const words = text.toLowerCase().match(/[a-z]{3,}/g) || [];

    if (words.length < 100) {
      checks.push({
        name: "keyword-stuffing",
        status: "info",
        message: "Content too short for keyword density analysis",
      });
      return { checks };
    }

    // Count word frequency
    const wordCounts = new Map<string, number>();
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }

    // Find words with high density, excluding English common words and the
    // grammatical filler for the page's declared language (#1042).
    const pageStopWords = LANGUAGE_STOP_WORDS.get(
      primaryLangSubtag(doc.documentElement?.getAttribute("lang")),
    );

    // Repeated generic nav/CTA labels ("Learn more" x11 cards) are a UI
    // component, not organic content — don't count their words toward
    // density (#695). Deliberately an ALLOWLIST of known boilerplate phrases
    // (not "any repeated short anchor text"): a spam page repeating a real
    // commercial keyword as anchor text ("emergency plumber" x20) must still
    // count fully toward density, so genuine anchor-text stuffing still flags.
    const GENERIC_CTA_LABELS = new Set([
      "learn more",
      "read more",
      "see more",
      "view more",
      "show more",
      "load more",
      "find out more",
      "get started",
      "sign up",
      "sign in",
      "log in",
      "contact us",
      "click here",
      "shop now",
      "buy now",
      "add to cart",
      "view details",
      "view all",
      "see all",
      "book now",
      "get a quote",
      "request a quote",
      "subscribe",
      "join now",
      "try for free",
      "try it free",
      "get in touch",
      "call now",
      "download now",
      "next page",
      "previous page",
      "back to top",
    ]);
    const ctaLabelCounts = new Map<string, number>();
    for (const el of doc.querySelectorAll("a, button")) {
      // Nested <a><button>Learn more</button></a> matches BOTH elements but
      // renders the phrase once — count only the outermost (review, #695).
      if (el.parentElement?.closest("a, button")) continue;
      const label = (el.textContent || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!GENERIC_CTA_LABELS.has(label)) continue;
      ctaLabelCounts.set(label, (ctaLabelCounts.get(label) || 0) + 1);
    }

    const ctaWordDeductions = new Map<string, number>();
    let ctaWordTotal = 0;
    for (const [label, occurrences] of ctaLabelCounts) {
      for (const word of label.match(/[a-z]{3,}/g) || []) {
        ctaWordDeductions.set(word, (ctaWordDeductions.get(word) || 0) + occurrences);
        ctaWordTotal += occurrences;
      }
    }

    const organicTotal = words.length - ctaWordTotal;

    const suspiciousWords: { word: string; count: number; density: number }[] = [];

    // User-configured whitelist (lowercase for matching)
    const whitelist = new Set(opts.whitelist.map((w) => w.toLowerCase()));
    // The site's own brand / product name is not a keyword it is stuffing.
    for (const term of brandTerms(ctx.page.url, doc)) whitelist.add(term);

    if (organicTotal > 0) {
      for (const [word, rawCount] of wordCounts) {
        if (COMMON_WORDS.has(word) || pageStopWords?.has(word)) continue;
        if (whitelist.has(word)) continue;

        const count = rawCount - (ctaWordDeductions.get(word) ?? 0);
        if (count <= 0) continue;

        const density = (count / organicTotal) * 100;
        if (density > opts.density_threshold && count > opts.min_occurrences) {
          suspiciousWords.push({ word, count, density });
        }
      }
    }

    // Sort by density
    suspiciousWords.sort((a, b) => b.density - a.density);

    if (suspiciousWords.length > 0) {
      checks.push({
        name: "keyword-stuffing",
        status: "warn",
        message: `${suspiciousWords.length} word(s) may be overused`,
        items: suspiciousWords.map((w) => ({
          id: w.word,
          label: `"${w.word}" (${w.density.toFixed(1)}%)`,
          meta: { count: w.count, density: w.density },
        })),
      });
    } else {
      checks.push({
        name: "keyword-stuffing",
        status: "pass",
        message: "No keyword stuffing detected",
      });
    }

    return { checks };
  },
};
