// adblock/blocked-links - links/resources blocked by EasyList network rules
// (cloud-backed, site-scope — server matches against the full EasyList)

import { z } from "zod";

import { getDomain } from "tldts";

import type { BlocklistCheckResponse, BlocklistMatch } from "@squirrelscan/core-contracts";

import { getHostname } from "@squirrelscan/utils";

import type { CheckResult, ParsedPage, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

const MAX_SOURCE_PAGES = 5;

// Cap the resource URL shown in the warning MESSAGE (full URLs can be 200+
// chars). The item's `id` always keeps the FULL URL.
const MAX_MESSAGE_URL_LEN = 80;

/**
 * Resource URL for display in the warning message, truncated to keep messages
 * readable. When truncation occurs we append a short hash of the full URL so two
 * distinct resources that share an 80-char prefix still yield distinct messages
 * (report grouping merges by digit-normalized message, so collisions would
 * collapse two different findings into one).
 */
function truncateMessageUrl(url: string): string {
  if (url.length <= MAX_MESSAGE_URL_LEN) return url;
  return `${url.slice(0, MAX_MESSAGE_URL_LEN)}…~${shortHash(url)}`;
}

/**
 * Stable short hash of a string, encoded as lowercase letters only (FNV-1a →
 * base-26). Letters survive report grouping's digit-normalization (`\d+ → #`),
 * so the disambiguator it adds to a truncated URL is never normalized away.
 */
function shortHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let n = h >>> 0;
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  } while (n > 0);
  return out;
}

export const optionsSchema = z.object({
  maxMatchesToReport: z
    .number()
    .default(10)
    .describe("Maximum blocked links to report in detail"),
});

/**
 * Friendly descriptions for common ad / tracking vendors, keyed by
 * registrable domain. Used to explain WHAT a blocked resource is in each
 * per-script warning (e.g. "ads-twitter.com — X/Twitter ad pixel"). Unknown
 * domains fall back to the bare hostname.
 */
// Precedence: a host-specific key (e.g. connect.facebook.net) wins over a
// registrable-domain key (facebook.net) — see describeBlockedResource lookup.
const VENDOR_DESCRIPTIONS: Record<string, string> = {
  "ads-twitter.com": "X/Twitter ad pixel",
  "doubleclick.net": "Google DoubleClick ad server",
  "googlesyndication.com": "Google AdSense / ad syndication",
  "googleadservices.com": "Google Ads conversion tracking",
  "google-analytics.com": "Google Analytics",
  "googletagmanager.com": "Google Tag Manager",
  "googletagservices.com": "Google ad tag services",
  "facebook.com": "Meta/Facebook pixel",
  "facebook.net": "Meta/Facebook SDK",
  "connect.facebook.net": "Meta/Facebook pixel",
  "fbcdn.net": "Meta/Facebook assets",
  "scorecardresearch.com": "Comscore audience tracker",
  "quantserve.com": "Quantcast measurement",
  "criteo.com": "Criteo retargeting",
  "criteo.net": "Criteo retargeting",
  "taboola.com": "Taboola content ads",
  "outbrain.com": "Outbrain content ads",
  "adnxs.com": "AppNexus/Xandr ad exchange",
  "amazon-adsystem.com": "Amazon ad system",
  "hotjar.com": "Hotjar session tracking",
  "bing.com": "Microsoft/Bing ads",
  "clarity.ms": "Microsoft Clarity analytics",
  "snapchat.com": "Snap Pixel",
  "tiktok.com": "TikTok pixel",
  "pinterest.com": "Pinterest tag",
  "linkedin.com": "LinkedIn Insight tag",
  "licdn.com": "LinkedIn Insight tag",
  "segment.com": "Segment analytics",
  "segment.io": "Segment analytics",
  "mixpanel.com": "Mixpanel analytics",
  "amplitude.com": "Amplitude analytics",
  "fullstory.com": "FullStory session replay",
  "mouseflow.com": "Mouseflow session replay",
  "newrelic.com": "New Relic monitoring",
  "nr-data.net": "New Relic monitoring",
  "optimizely.com": "Optimizely experiments",
  "hubspot.com": "HubSpot tracking",
  "hs-analytics.net": "HubSpot analytics",
  "hs-scripts.com": "HubSpot tracking",
  "intercom.io": "Intercom messenger",
  "intercomcdn.com": "Intercom messenger",
  "cloudflareinsights.com": "Cloudflare Web Analytics",
};

/**
 * Human label for a blocked resource: "<host> — <vendor>" when the registrable
 * domain is a recognised vendor, otherwise the hostname alone. Falls back to
 * the raw value for non-URL matches.
 */
export function describeBlockedResource(url: string): string {
  const host = getHostname(url);
  if (!host) return url;
  const registrable = getDomain(url) ?? host;
  // Host-specific entries (e.g. connect.facebook.net) win over the broader
  // registrable-domain entry (facebook.net) when both are listed.
  const vendor = VENDOR_DESCRIPTIONS[host] ?? VENDOR_DESCRIPTIONS[registrable];
  return vendor ? `${host} — ${vendor}` : host;
}

/**
 * Pages whose parsed links / images / script srcs reference `url` (capped).
 *
 * Site-scope blocklist matches are most often `<script src>` resources, which
 * are NOT captured in `parsed.links` (anchors) or `parsed.images`. We therefore
 * also consult the fetched-scripts map (`ctx.site.scripts`, url → sourcePages)
 * and, as a last resort, scan each page's parsed document for a matching
 * `script[src]`. Without this, blocking scripts reported "0 pages affected".
 */
export function findSourcePages(ctx: RuleContext, url: string): string[] {
  const pages = new Set<string>();
  const add = (page: string): boolean => {
    pages.add(page);
    return pages.size >= MAX_SOURCE_PAGES;
  };

  // Pre-attributed script resources: the crawler records which pages loaded
  // each external script. This is the most reliable source — when the resource
  // is a known fetched script, its recorded sourcePages are authoritative.
  const scriptSources = ctx.site?.scripts?.find((s) => s.url === url)?.sourcePages;
  if (scriptSources && scriptSources.length > 0) {
    return scriptSources.slice(0, MAX_SOURCE_PAGES);
  }

  // Streaming (#1021): each page's `<script src>` list was captured at page-time
  // (parsed.links/images are DOM-free scalars, always available). Fall back to
  // scanning the live document (v1) when no collected signals are present.
  const collectedScripts = scriptSrcsByUrl(ctx);
  for (const page of ctx.site?.pages ?? []) {
    const parsed = page.parsed;
    const referenced =
      parsed.links.some((l) => l.url === url) ||
      parsed.images.some((i) => i.src === url) ||
      (collectedScripts
        ? (collectedScripts.get(page.url)?.includes(url) ?? false)
        : documentReferencesScript(parsed.document, url));
    if (referenced && add(page.url)) break;
  }
  return [...pages];
}

/** Raw `<script src>` attribute values on ONE page's live DOM — shared by the
 *  page-time collector (#1021 E-E2) and the legacy `documentReferencesScript`. */
export function pageScriptSrcs(doc: NonNullable<ParsedPage["document"]>): string[] {
  const srcs: string[] = [];
  try {
    for (const script of doc.querySelectorAll("script[src]")) {
      const src = script.getAttribute("src");
      if (src !== null) srcs.push(src);
    }
  } catch {
    // linkedom edge cases — treat as no scripts.
  }
  return srcs;
}

// Memoize the per-page scriptSrc lookup for one collected-signals object so
// findSourcePages (called once per blocked resource) doesn't rebuild it per call.
const scriptSrcLookupCache = new WeakMap<object, Map<string, string[]>>();
function scriptSrcsByUrl(ctx: RuleContext): Map<string, string[]> | null {
  const collected = ctx.collectedSignals;
  if (!collected) return null;
  let lookup = scriptSrcLookupCache.get(collected);
  if (!lookup) {
    lookup = new Map(collected.pages.map((r) => [r.url, r.scriptSrcs]));
    scriptSrcLookupCache.set(collected, lookup);
  }
  return lookup;
}

/** Whether a parsed document loads `<script src="url">` (absolute match). */
function documentReferencesScript(doc: unknown, url: string): boolean {
  const document = doc as { querySelectorAll?: (sel: string) => Iterable<Element> } | null;
  if (!document?.querySelectorAll) return false;
  try {
    for (const script of document.querySelectorAll("script[src]")) {
      if (script.getAttribute("src") === url) return true;
    }
  } catch {
    // linkedom edge cases — treat as no match.
  }
  return false;
}

/**
 * One warning per blocked resource. Each names/defines the resource (host +
 * vendor) and lists the pages that load it. Sorting by page-impact then host
 * keeps the highest-impact scripts first and the order deterministic.
 */
function buildPerResourceChecks(
  ctx: RuleContext,
  matches: BlocklistMatch[],
  maxToReport: number,
  listsVersion: string,
): CheckResult[] {
  // Always surface at least one warning when matches exist (a misconfigured
  // maxMatchesToReport of 0 must not silently drop the finding from the report
  // / scoring).
  const limit = Math.max(1, maxToReport);
  // Bound the page-attribution work (a DOM scan per match in the worst case):
  // attribute at most a few multiples of what we report, after a cheap
  // deterministic pre-sort by resource URL so the cap is stable across runs.
  const sorted = [...matches].sort((a, b) => a.value.localeCompare(b.value));
  const ATTRIBUTION_CAP = Math.min(Math.max(limit * 4, 40), 200);
  const entries = sorted.slice(0, ATTRIBUTION_CAP).map((m) => {
    const sourcePages = m.kind === "url" ? findSourcePages(ctx, m.value) : [];
    return { match: m, sourcePages };
  });

  entries.sort(
    (a, b) =>
      b.sourcePages.length - a.sourcePages.length ||
      a.match.value.localeCompare(b.match.value),
  );

  return entries.slice(0, limit).map(({ match, sourcePages }) => {
    const description = describeBlockedResource(match.value);
    const pageNote =
      sourcePages.length > 0
        ? ` (${sourcePages.length} page${sourcePages.length === 1 ? "" : "s"})`
        : "";
    // The resource URL keeps each warning's message distinct so report grouping
    // (which merges by digit-normalized message) never collapses two different
    // blocked resources on the same host into one. It is truncated for display
    // (full URL stays on the item id); truncateMessageUrl appends a hash when
    // shortened so the discriminator survives. Page count is parenthesised so it
    // does not become the only differentiator.
    return {
      name: "blocked-links",
      status: "warn",
      message: `Blocked by ad blockers: ${description} — ${truncateMessageUrl(match.value)}${pageNote}`,
      // Affected pages travel on the item's sourcePages: report grouping
      // collapses by message and only preserves item-level page references
      // (check.pages is rebuilt from per-page pageUrl, which site-scope rules
      // don't set). The "N pages affected" count unions these sourcePages.
      items: [
        {
          id: match.value,
          label: match.rule ? `matches "${match.rule}"` : description,
          sourcePages,
          meta: { rule: match.rule ?? null, list: match.list },
        },
      ],
      details: { listsVersion },
    } satisfies CheckResult;
  });
}

export const blockedLinksRule: Rule = {
  meta: {
    id: "adblock/blocked-links",
    name: "Blocked Tracking Links",
    description:
      "Checks for links and resources that ad blockers (EasyList) would block",
    solution:
      "Links to ad/tracking domains will be blocked by users with adblockers like uBlock Origin or AdBlock. " +
      "If these are essential resources, they won't load. If they're analytics or ads, you may get incomplete data or revenue from users with adblockers. " +
      "Consider using first-party analytics or privacy-respecting alternatives.",
    category: "blocking",
    subcategory: "ad",
    scope: "site",
    severity: "warning",
    weight: 2,
    optionsSchema,
    cloud: { service: "blocklist-check", unit: "site", creditFeature: "adblock_detect" },
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];

    const envelope = readCloudResult<BlocklistCheckResponse>(ctx.cloudResults, "blocklist-check");
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason =
        envelope?.status === "skipped" ? (envelope.skipReason ?? "not-prefetched") : "not-prefetched";
      checks.push({
        name: "blocked-links",
        status: "skipped",
        message: "Ad-blocker link check skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    // EasyPrivacy url matches are reported by adblock/privacy-blocked.
    const matches = envelope.data.matches.filter(
      (m) => m.kind === "url" && m.list === "easylist",
    );

    if (matches.length === 0) {
      checks.push({
        name: "blocked-links",
        status: "pass",
        message: "No links or resources match EasyList ad-blocking rules",
      });
    } else {
      // One warning per blocked resource so each script's identity and the
      // pages it impacts are surfaced individually (#240).
      checks.push(
        ...buildPerResourceChecks(
          ctx,
          matches,
          opts.maxMatchesToReport,
          envelope.data.listsVersion,
        ),
      );
    }

    return { checks };
  },
};
