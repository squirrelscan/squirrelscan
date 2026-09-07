// Gaps payload builder — derives the keyword-gaps / content-gaps site-unit
// request payloads from crawl artifacts + config. Pure adaptation: the prefetch
// phase (@squirrelscan/audit-engine) dispatches these; no HTTP here.

import {
  detachFromPage,
  type CloudSitePayloads,
} from "@squirrelscan/audit-engine";
import { SERVICE_LIMITS } from "@squirrelscan/core-contracts";

import type { SiteContextPage } from "@/audit/adapter";
import type { Config } from "@/config";

import { getHostname } from "@/utils/url";

/** Seeds shorter than this are noise (single chars, stray symbols). */
const MIN_SEED_LENGTH = 3;
/** Seeds longer than this are full sentences, not keywords. */
const MAX_SEED_LENGTH = 80;
/** Title segments are split on these site-name separators; first segment wins. */
const TITLE_SEPARATORS = /\s*[|·—–]\s*|\s+-\s+/;

export type GapsPayloads = Pick<
  CloudSitePayloads,
  "keyword-gaps" | "content-gaps"
>;

interface GapsRuleOptions {
  country?: string;
  language?: string;
  competitors?: string[];
}

/** Apex-ish domain for the audit target: hostname minus a leading `www.`. */
function apexDomain(baseUrl: string): string {
  const host = getHostname(baseUrl).toLowerCase().replace(/\.+$/, "");
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** Narrow `rule_options[<ruleId>]` (Record<string, unknown>) to the gaps options. */
function gapsOptions(config: Config, ruleId: string): GapsRuleOptions {
  const raw = config.rule_options[ruleId] ?? {};
  const opts: GapsRuleOptions = {};
  if (typeof raw.country === "string" && raw.country)
    opts.country = raw.country;
  if (typeof raw.language === "string" && raw.language)
    opts.language = raw.language;
  if (Array.isArray(raw.competitors)) {
    const competitors = raw.competitors
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim())
      .slice(0, SERVICE_LIMITS.gapsMaxCompetitors);
    if (competitors.length > 0) opts.competitors = competitors;
  }
  return opts;
}

/** First title segment before a site-name separator ("Pricing | Acme" → "Pricing"). */
function cleanSeed(text: string): string | null {
  const segment = (text.split(TITLE_SEPARATORS)[0] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (segment.length < MIN_SEED_LENGTH || segment.length > MAX_SEED_LENGTH)
    return null;
  return segment;
}

/** Seed keywords / covered topics from page titles + h1s (dedup, ≤50). */
function collectSeeds(siteContext: SiteContextPage[]): string[] {
  const state = createSeedState();
  absorbSeeds(state, siteContext);
  return state.seeds;
}

export interface SeedState {
  seeds: string[];
  seen: Set<string>;
}

export function createSeedState(): SeedState {
  return { seeds: [], seen: new Set<string>() };
}

/**
 * {@link collectSeeds}' body over caller-owned state, so the ≤50 seed cap and
 * the dedupe set span page batches instead of resetting on each one (#1913).
 * A seed is a title/h1 substring, so it pins the page it was read off (#240)
 * unless detached — and on the streamed path that page is dropped immediately
 * after this returns.
 */
export function absorbSeeds(
  state: SeedState,
  siteContext: SiteContextPage[]
): void {
  const { seeds, seen } = state;
  if (seeds.length >= SERVICE_LIMITS.gapsMaxSeeds) return;
  for (const { page, parsed } of siteContext) {
    if (!parsed || page.status < 200 || page.status >= 300) continue;
    const candidates = [parsed.meta.title ?? "", ...parsed.h1.texts];
    for (const candidate of candidates) {
      const seed = cleanSeed(candidate);
      if (!seed) continue;
      const key = seed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push(detachFromPage(seed, "cloud-payload"));
      if (seeds.length >= SERVICE_LIMITS.gapsMaxSeeds) return;
    }
  }
}

/**
 * Build the gaps site-unit payloads. Returns an empty object (no dispatch →
 * `not-prefetched`, no charge) when the target has no usable domain or the
 * crawl yielded no usable titles/h1s to seed the analysis with.
 */
export function buildGapsPayloads(
  siteContext: SiteContextPage[],
  baseUrl: string,
  config: Config
): GapsPayloads {
  return buildGapsPayloadsFromSeeds(collectSeeds(siteContext), baseUrl, config);
}

/**
 * {@link buildGapsPayloads} over seeds gathered elsewhere — the streamed
 * pre-rules walk accumulates them batch by batch (#1913).
 */
export function buildGapsPayloadsFromSeeds(
  seeds: string[],
  baseUrl: string,
  config: Config
): GapsPayloads {
  const domain = apexDomain(baseUrl);
  if (!domain || seeds.length === 0) return {};

  const keywordOpts = gapsOptions(config, "gaps/keywords");
  const contentOpts = gapsOptions(config, "gaps/content");

  return {
    "keyword-gaps": {
      domain,
      country: keywordOpts.country,
      language: keywordOpts.language,
      competitors: keywordOpts.competitors,
      seedKeywords: seeds,
    },
    "content-gaps": {
      domain,
      country: contentOpts.country,
      language: contentOpts.language,
      competitors: contentOpts.competitors,
      coveredTopics: seeds,
    },
  };
}
