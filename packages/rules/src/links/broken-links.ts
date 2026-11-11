// links/broken-links - Broken link detection

import type { CheckResult, FetchedTarget, Rule, RuleContext, RuleResult } from "../types";

import {
  LINK_PROBE_HEAD_UNRELIABLE_ERROR,
  LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
} from "@squirrelscan/core-contracts";
import { isCloudflareEmailProtectionUrl, normalizeUrl } from "@squirrelscan/utils";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";

import {
  chromeReach,
  chromeSectionOf,
  htmlPageCount,
  isSitewide,
  regionsField,
  sectionMeta,
  sitewideMessageHead,
  tallyFields,
  tallySource,
  withSection,
  type ChromeReach,
  type SourceTally,
} from "./link-section-label";

export const brokenLinksRule: Rule = {
  meta: {
    id: "links/broken-links",
    name: "Broken Links",
    description: "Detects links returning 404 or 5xx errors",
    solution:
      "Broken links hurt user experience and waste crawl budget. Regularly audit links using tools or crawlers. Fix or remove broken links. Set up 301 redirects for moved content. For external links, consider using nofollow and regularly verifying they still work. Implement custom 404 pages that help users find content.",
    // pub#836/#843: a dead link is a reliability problem, scored under
    // Performance; the id keeps its `links/` prefix so configs keep working.
    category: "reliability",
    scope: "site",
    severity: "error",
    weight: 7,
    // A link moves between the content check and the site-wide check as the pages that carry it change (#1772).
    // A finding stored under one name is judged by the other, so a link that only changed check is not
    // resolved (and reported fixed) under its old name: it continues under the new one.
    supersededChecks: {
      "broken-links": ["broken-links-sitewide"],
      "broken-links-sitewide": ["broken-links"],
    },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages) {
      checks.push({
        name: "broken-links",
        status: "skipped",
        message: "Site data not available for broken link analysis",
      });
      return { checks };
    }

    // Every link target, with the pages that link it: each page once, with its links there and
    // where on the page they sit (#2307, pub#837).
    const linkTargets = new Map<string, SourceTally>();
    // The same placements, only where the markup or a confident model placed them: what decides "site-wide".
    const chromeTargets = new Map<string, SourceTally>();
    // pub#811: Cloudflare's email obfuscation rewrites `mailto:` links to
    // `/cdn-cgi/l/email-protection#<hex>`, which answers an error status but
    // is an email address, not a page. The parser carries them as contact
    // links; a parse stored before it did still has them here. Counted either
    // way, so the skip is visible.
    let emailProtectionLinks = 0;

    for (const page of pages) {
      for (const link of page.parsed.links) {
        if (link.isInternal && link.url) {
          if (isCloudflareEmailProtectionUrl(link.url)) {
            emailProtectionLinks++;
            continue;
          }
          let tally = linkTargets.get(link.url);
          if (!tally) linkTargets.set(link.url, (tally = new Map()));
          tallySource(tally, page.url, link.section);
          let chrome = chromeTargets.get(link.url);
          if (!chrome) chromeTargets.set(link.url, (chrome = new Map()));
          tallySource(chrome, page.url, chromeSectionOf(link));
        }
      }
      for (const contact of page.parsed.contactLinks ?? []) {
        if (contact.obfuscated === "cloudflare") emailProtectionLinks++;
      }
    }

    // Build map of crawled URLs with their status codes
    // Normalization: strips hash, trailing slash, lowercases scheme/host (not path)
    const crawledPages = new Map<string, number>();
    for (const page of pages) {
      crawledPages.set(normalizeUrl(page.url), page.statusCode);
    }

    // repo#2729: statuses the link probe fetched for targets the crawl did not
    // (status-only HEAD/GET). A known status, the same as a crawled page's.
    const probedStatuses = new Map<
      string,
      { status: number | null; error?: string | null; rateLimited?: boolean }
    >();
    for (const probe of ctx.site?.linkTargetStatuses ?? []) {
      probedStatuses.set(normalizeUrl(probe.url), probe);
    }

    // pub#798: pages the crawl fetched that are not in `pages` (not HTML, rate
    // limited, or a bot-wall challenge). A link to one has an answer from the
    // crawl, so it is never counted as unfetched.
    const fetchedOutside = new Map<string, FetchedTarget>();
    for (const fetched of ctx.site?.fetchedTargets ?? []) {
      fetchedOutside.set(normalizeUrl(fetched.url), fetched);
    }

    const brokenLinks: {
      url: string;
      sources: SourceTally;
      statusCode: number;
      probed: boolean;
    }[] = [];
    const rateLimitedLinks: {
      url: string;
      sources: SourceTally;
      statusCode: number;
    }[] = [];
    // repo#2729: a probed 401/403 is a bot wall or an auth wall refusing a
    // status-only request, not a missing page. The crawl keeps challenge pages
    // out of this rule; the probe's refusals are kept out the same way.
    // pub#798: so is a target the crawl itself got a bot-wall challenge for.
    const refusedLinks: {
      url: string;
      sources: SourceTally;
      statusCode: number;
      wafChallenge?: boolean;
    }[] = [];

    // Distinct targets neither the crawl nor the probe fetched: status unknown.
    const unfetchedTargets = new Set<string>();
    const allTargets = new Set<string>();
    const probedTargets = new Set<string>();
    // Of those, the ones the probe asked about and got no usable status for,
    // split by whether it set an error aside as untrusted. The rest it never
    // asked about (pub#726). Sets, like unfetchedTargets: `/a`, `/a/` and
    // `/a#x` are one target.
    const unansweredTargets = new Set<string>();
    const untrustedTargets = new Set<string>();
    // Distinct targets (normalized, like `allTargets`) whose answer was a refusal (401/403 or a
    // bot-wall challenge) or a throttle (429): the status exists but says nothing about the page
    // (pub#1679). They are not in `unfetchedTargets`, so a reader that wants targets actually
    // observed subtracts them from `linkTargets - unfetchedTargets`.
    const refusedTargets = new Set<string>();
    const rateLimitedTargets = new Set<string>();

    for (const [target, sources] of linkTargets) {
      // Normalize target URL to match crawler's normalization
      const normalizedTarget = normalizeUrl(target);
      allTargets.add(normalizedTarget);
      let statusCode = crawledPages.get(normalizedTarget);
      let probed = false;
      if (statusCode === undefined) {
        const fetched = fetchedOutside.get(normalizedTarget);
        if (fetched?.rateLimited) {
          rateLimitedTargets.add(normalizedTarget);
          rateLimitedLinks.push({ url: target, sources, statusCode: fetched.status });
          continue;
        }
        if (fetched?.wafChallenge) {
          refusedTargets.add(normalizedTarget);
          refusedLinks.push({ url: target, sources, statusCode: fetched.status, wafChallenge: true });
          continue;
        }
        // Not HTML, and it answered 2xx/3xx: a known status, not broken.
        if (fetched) statusCode = fetched.status;
      }
      if (statusCode === undefined) {
        const probe = probedStatuses.get(normalizedTarget);
        if (probe?.rateLimited) {
          probedTargets.add(normalizedTarget);
          rateLimitedTargets.add(normalizedTarget);
          rateLimitedLinks.push({ url: target, sources, statusCode: probe.status ?? 429 });
          continue;
        }
        if (typeof probe?.status === "number" && probe.status > 0) {
          probedTargets.add(normalizedTarget);
          if (probe.status === 401 || probe.status === 403) {
            refusedTargets.add(normalizedTarget);
            refusedLinks.push({ url: target, sources, statusCode: probe.status });
            continue;
          }
          statusCode = probe.status;
          probed = true;
        }
      }
      if (statusCode === undefined) {
        unfetchedTargets.add(normalizedTarget);
        const attempt = probedStatuses.get(normalizedTarget);
        if (attempt?.error === LINK_PROBE_HEAD_UNRELIABLE_ERROR)
          untrustedTargets.add(normalizedTarget);
        else if (attempt) unansweredTargets.add(normalizedTarget);
        continue;
      }

      // #1829: a 429/430 means the host throttled the crawl, not that the page
      // is missing. The adapter already keeps rate-limited pages out of the
      // corpus, so this is the second line of defence for a status that reached
      // the rules another way (a stored page from an older crawl, a cloud
      // render result). Must precede the >= 400 test.
      if (isRateLimitStatus(statusCode)) {
        rateLimitedTargets.add(normalizedTarget);
        rateLimitedLinks.push({ url: target, sources, statusCode });
        continue;
      }

      // Only broken if we crawled it AND got error status (4xx/5xx)
      if (statusCode >= 400) {
        brokenLinks.push({ url: target, sources, statusCode, probed });
      }
    }

    // repo#2729: a crawl that did not follow links (Quick, sitemap scope) never
    // fetched the targets outside the seed and the sitemaps. "No broken links"
    // would then be a pass on links nobody requested, and it resolved open
    // broken-link issues on every such run. Say they were not checked instead.
    const notFollowed = ctx.site?.linkDiscoveryOff === true && unfetchedTargets.size > 0;

    // What the result covers (repo#2729), on every broken-links row (pub#794):
    // comparing two audits' broken links has to tell a target that was fixed
    // from one this audit never fetched, and `notFetched` says which unfetched
    // targets were left out by design (`skipped`), the same on every run with
    // the same settings. Its presence on a pass also tells a reader that this
    // engine reports unfetched targets, so the pass was not vacuous.
    const notFetched = notFetchedCauses(
      unfetchedTargets.size,
      unansweredTargets.size,
      untrustedTargets.size,
      ctx.site?.internalLinkProbe,
    );
    // A fresh object per row: a fail and a skip can both be emitted.
    const coverage = () => ({
      linkTargets: allTargets.size,
      unfetchedTargets: unfetchedTargets.size,
      probedTargets: probedTargets.size,
      refusedTargets: refusedTargets.size,
      rateLimitedTargets: rateLimitedTargets.size,
      notFetched: { ...notFetched },
      ...(emailProtectionLinks > 0 ? { emailProtectionLinks } : {}),
    });

    // A broken link that sits in the header, navigation or footer of most pages is its own check (#1772): a
    // visitor meets it on every page, and one fix in the template closes it. Links in page content stay here.
    const itemOf = (b: (typeof brokenLinks)[number]) => {
      const { sourcePages, sources, sections, regions } = tallyFields(b.sources);
      return {
        reach: chromeReach(tallyFields(chromeTargets.get(b.url) ?? new Map()).sources),
        item: {
          id: b.url,
          label: withSection(`${b.url} (${b.statusCode})`, sections),
          sourcePages,
          sources,
          ...regionsField(regions),
          meta: {
            statusCode: b.statusCode,
            ...sectionMeta(sections),
            // Pages, as the report counts them; `sources` says how many links each one has.
            linkedFrom: sourcePages.length,
            ...(b.probed ? { probed: true } : {}),
          },
        },
      };
    };
    // The pages a footer is read on: parsed HTML pages, not redirect entries, error pages or files.
    const crawledHtmlPages = htmlPageCount(pages);
    const contentBroken: ReturnType<typeof itemOf>[] = [];
    const sitewideBroken: ReturnType<typeof itemOf>[] = [];
    for (const b of brokenLinks) {
      const built = itemOf(b);
      (isSitewide(built.reach, crawledHtmlPages) ? sitewideBroken : contentBroken).push(built);
    }

    if (contentBroken.length > 0) {
      checks.push({
        name: "broken-links",
        status: "fail",
        // Once a site-wide check sits beside it, the message says which links are its own.
        message:
          sitewideBroken.length > 0
            ? `${contentBroken.length} broken internal ${contentBroken.length === 1 ? "link" : "links"} in page content (4xx/5xx)`
            : `${contentBroken.length} broken internal link(s) (4xx/5xx)`,
        items: contentBroken.map((b) => b.item),
        details: coverage(),
      });
    } else if (!notFollowed && sitewideBroken.length === 0) {
      // With only site-wide links broken there is no pass row: the rule still fails once, as it did, so one
      // footer link costs what it always cost, and no clean row says "no broken links" beside a broken one.
      checks.push({
        name: "broken-links",
        status: "pass",
        message: "No broken internal links detected",
        details: coverage(),
      });
    }

    if (sitewideBroken.length > 0) {
      const reaches: ChromeReach[] = sitewideBroken.map((b) => b.reach);
      checks.push({
        name: "broken-links-sitewide",
        status: "fail",
        message: `${sitewideMessageHead("internal", reaches)} (4xx/5xx)`,
        items: sitewideBroken.map((b) => b.item),
        details: coverage(),
      });
    }

    if (notFollowed) {
      checks.push({
        name: "broken-links",
        status: "skipped",
        message: `${unfetchedTargets.size} of ${allTargets.size} internal link target(s) were not fetched because this audit did not follow links and ${notFetchedReason(notFetched, ctx.site?.internalLinkProbe?.cap ?? 0)}, so they were not checked for broken links`,
        skipReason: LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
        value: unfetchedTargets.size,
        details: coverage(),
      });
    }

    if (refusedLinks.length > 0) {
      const challenged = refusedLinks.some((b) => b.wafChallenge);
      const refusedByProbe = refusedLinks.some((b) => !b.wafChallenge);
      const why =
        challenged && refusedByProbe
          ? "refused the link check (401/403) or answered the crawl with a bot-wall challenge"
          : challenged
            ? "answered the crawl with a bot-wall challenge"
            : "refused the link check (401/403)";
      checks.push({
        name: "refused-links",
        status: "info",
        message: `${refusedLinks.length} internal link(s) ${why} - status unverifiable`,
        items: refusedLinks.map((b) => {
          const { sourcePages, sources, regions } = tallyFields(b.sources);
          return {
            id: b.url,
            label: `${b.url} (${b.statusCode})`,
            sourcePages,
            sources,
            ...regionsField(regions),
            meta: b.wafChallenge
              ? { statusCode: b.statusCode, wafChallenge: true }
              : { statusCode: b.statusCode, probed: true },
          };
        }),
      });
    }

    if (rateLimitedLinks.length > 0) {
      checks.push({
        name: "rate-limited-links",
        status: "info",
        message: `${rateLimitedLinks.length} internal link(s) rate-limited - status unverifiable`,
        items: rateLimitedLinks.map((b) => {
          const { sourcePages, sources, regions } = tallyFields(b.sources);
          return {
            id: b.url,
            label: `${b.url} (${b.statusCode})`,
            sourcePages,
            sources,
            ...regionsField(regions),
            meta: { statusCode: b.statusCode, rateLimited: true },
          };
        }),
      });
    }

    return { checks };
  },
};

/**
 * Why the internal link targets nobody fetched were left out, as counts per
 * cause (pub#726). Read by the report's "Not checked" hint, so it suggests
 * raising `internal_links.max_targets` only when the limit left targets out.
 * Only causes with a count are present.
 */
interface LinkTargetsNotFetched {
  /** Internal link checks were off: no target was checked. */
  off?: number;
  /** Past the check's per-audit limit (`internal_links.max_targets`). */
  overLimit?: number;
  /** Never requested: outside the crawl scope, disallowed by robots.txt, or an action or token link. */
  skipped?: number;
  /** Asked, but the site answers HEAD with errors on pages it serves, so no answer was trusted. */
  untrusted?: number;
  /** Asked, and no status came back. */
  noAnswer?: number;
}

type InternalLinkProbe = NonNullable<NonNullable<RuleContext["site"]>["internalLinkProbe"]>;

/**
 * Split the unfetched targets by cause. Targets the probe asked about without
 * a status are untrusted when it set an error aside because HEAD was
 * unreliable, and unanswered otherwise. For the ones it never asked about, its
 * own counts say how far its eligible targets ran past the limit and how many
 * it skipped: past the limit up to that excess, then skipped up to its count.
 * Any left over (a target the engine counted differently, or a context without
 * per-target statuses) is counted as unanswered, the cause that claims least.
 * The counts add up to `unfetched`; with nothing unfetched the object is empty.
 */
function notFetchedCauses(
  unfetched: number,
  unanswered: number,
  untrusted: number,
  probe: InternalLinkProbe | undefined,
): LinkTargetsNotFetched {
  let causes: LinkTargetsNotFetched;
  if (!probe) {
    causes = { off: unfetched };
  } else {
    const notAsked = Math.max(0, unfetched - unanswered - untrusted);
    const overLimit = Math.min(notAsked, Math.max(0, probe.unfetched - probe.cap));
    const skipped = Math.min(notAsked - overLimit, probe.outOfScope ?? 0);
    causes = {
      overLimit,
      skipped,
      untrusted,
      noAnswer: unanswered + (notAsked - overLimit - skipped),
    };
  }
  for (const key of Object.keys(causes) as (keyof LinkTargetsNotFetched)[]) {
    if (!causes[key]) delete causes[key];
  }
  return causes;
}

const targets = (n: number): string => `${n} ${n === 1 ? "target" : "targets"}`;

/** The "because ..." clause for the Not checked message: one cause in words, several with a count each. */
function notFetchedReason(causes: LinkTargetsNotFetched, cap: number): string {
  const present = (Object.keys(causes) as (keyof LinkTargetsNotFetched)[]).filter((k) => causes[k]);
  if (present.length === 1) {
    switch (present[0]) {
      case "off":
        return "internal link checks were off";
      case "overLimit":
        return cap === 0
          ? "internal_links.max_targets is 0"
          : `its internal link checks stop at ${targets(cap)}, most-linked first`;
      case "skipped":
        return "its internal link checks never request targets outside the crawl scope, disallowed by robots.txt, or that look like actions (log out, unsubscribe) or carry a token";
      case "untrusted":
        return "the internal link checks could not be trusted, as the site answers status-only (HEAD) requests with errors on pages it serves";
      default:
        return "its internal link checks got no answer";
    }
  }
  const parts: string[] = [];
  if (causes.overLimit) {
    parts.push(
      cap === 0
        ? `${causes.overLimit} because internal_links.max_targets is 0`
        : `${causes.overLimit} past the limit of ${targets(cap)}`,
    );
  }
  if (causes.skipped) {
    parts.push(
      `${causes.skipped} skipped as outside the crawl scope, disallowed by robots.txt, or ${causes.skipped === 1 ? "an action or token link" : "action or token links"}`,
    );
  }
  if (causes.untrusted) {
    parts.push(
      `${causes.untrusted} not trusted, because the site answers HEAD requests with errors on pages it serves`,
    );
  }
  if (causes.noAnswer) parts.push(`${causes.noAnswer} with no answer`);
  return `its internal link checks left them out (${parts.join("; ")})`;
}
