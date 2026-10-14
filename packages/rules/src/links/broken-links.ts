// links/broken-links - Broken link detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { LINK_TARGETS_NOT_FETCHED_SKIP_REASON } from "@squirrelscan/core-contracts";
import { normalizeUrl } from "@squirrelscan/utils";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";

export const brokenLinksRule: Rule = {
  meta: {
    id: "links/broken-links",
    name: "Broken Links",
    description: "Detects links returning 404 or 5xx errors",
    solution:
      "Broken links hurt user experience and waste crawl budget. Regularly audit links using tools or crawlers. Fix or remove broken links. Set up 301 redirects for moved content. For external links, consider using nofollow and regularly verifying they still work. Implement custom 404 pages that help users find content.",
    category: "links",
    scope: "site",
    severity: "error",
    weight: 7,
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

    // Collect all link targets and their sources
    const linkTargets = new Map<string, string[]>();

    for (const page of pages) {
      for (const link of page.parsed.links) {
        if (link.isInternal && link.url) {
          const sources = linkTargets.get(link.url) || [];
          sources.push(page.url);
          linkTargets.set(link.url, sources);
        }
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
    const probedStatuses = new Map<string, { status: number | null; rateLimited?: boolean }>();
    for (const probe of ctx.site?.linkTargetStatuses ?? []) {
      probedStatuses.set(normalizeUrl(probe.url), probe);
    }

    const brokenLinks: {
      url: string;
      sources: string[];
      statusCode: number;
      probed: boolean;
    }[] = [];
    const rateLimitedLinks: {
      url: string;
      sources: string[];
      statusCode: number;
    }[] = [];
    // repo#2729: a probed 401/403 is a bot wall or an auth wall refusing a
    // status-only request, not a missing page. The crawl keeps challenge pages
    // out of this rule; the probe's refusals are kept out the same way.
    const refusedLinks: {
      url: string;
      sources: string[];
      statusCode: number;
    }[] = [];

    // Distinct targets neither the crawl nor the probe fetched: status unknown.
    const unfetchedTargets = new Set<string>();
    const allTargets = new Set<string>();
    const probedTargets = new Set<string>();
    // Of those, the ones the probe asked about and got no usable status for.
    // The rest it never asked about (pub#726).
    let unansweredTargets = 0;

    for (const [target, sources] of linkTargets) {
      // Normalize target URL to match crawler's normalization
      const normalizedTarget = normalizeUrl(target);
      allTargets.add(normalizedTarget);
      let statusCode = crawledPages.get(normalizedTarget);
      let probed = false;
      if (statusCode === undefined) {
        const probe = probedStatuses.get(normalizedTarget);
        if (probe?.rateLimited) {
          probedTargets.add(normalizedTarget);
          rateLimitedLinks.push({ url: target, sources, statusCode: probe.status ?? 429 });
          continue;
        }
        if (typeof probe?.status === "number" && probe.status > 0) {
          probedTargets.add(normalizedTarget);
          if (probe.status === 401 || probe.status === 403) {
            refusedLinks.push({ url: target, sources, statusCode: probe.status });
            continue;
          }
          statusCode = probe.status;
          probed = true;
        }
      }
      if (statusCode === undefined) {
        unfetchedTargets.add(normalizedTarget);
        if (probedStatuses.has(normalizedTarget)) unansweredTargets++;
        continue;
      }

      // #1829: a 429/430 means the host throttled the crawl, not that the page
      // is missing. The adapter already keeps rate-limited pages out of the
      // corpus, so this is the second line of defence for a status that reached
      // the rules another way (a stored page from an older crawl, a cloud
      // render result). Must precede the >= 400 test.
      if (isRateLimitStatus(statusCode)) {
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

    if (brokenLinks.length > 0) {
      checks.push({
        name: "broken-links",
        status: "fail",
        message: `${brokenLinks.length} broken internal link(s) (4xx/5xx)`,
        items: brokenLinks.map((b) => ({
          id: b.url,
          label: `${b.url} (${b.statusCode})`,
          sourcePages: b.sources,
          meta: {
            statusCode: b.statusCode,
            linkedFrom: b.sources.length,
            ...(b.probed ? { probed: true } : {}),
          },
        })),
      });
    } else if (!notFollowed) {
      checks.push({
        name: "broken-links",
        status: "pass",
        message: "No broken internal links detected",
        // What the pass covers (repo#2729). Its presence also tells a reader of
        // the result that this engine reports unfetched targets as skipped, so
        // a pass here was not vacuous.
        details: {
          linkTargets: allTargets.size,
          unfetchedTargets: unfetchedTargets.size,
          probedTargets: probedTargets.size,
        },
      });
    }

    if (notFollowed) {
      const notFetched = notFetchedCauses(
        unfetchedTargets.size,
        unansweredTargets,
        ctx.site?.internalLinkProbe,
      );
      checks.push({
        name: "broken-links",
        status: "skipped",
        message: `${unfetchedTargets.size} of ${allTargets.size} internal link target(s) were not fetched because this audit did not follow links and ${notFetchedReason(notFetched, ctx.site?.internalLinkProbe?.cap ?? 0)}, so they were not checked for broken links`,
        skipReason: LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
        value: unfetchedTargets.size,
        details: {
          linkTargets: allTargets.size,
          unfetchedTargets: unfetchedTargets.size,
          probedTargets: probedTargets.size,
          notFetched,
        },
      });
    }

    if (refusedLinks.length > 0) {
      checks.push({
        name: "refused-links",
        status: "info",
        message: `${refusedLinks.length} internal link(s) refused the link check (401/403) - status unverifiable`,
        items: refusedLinks.map((b) => ({
          id: b.url,
          label: `${b.url} (${b.statusCode})`,
          sourcePages: b.sources,
          meta: { statusCode: b.statusCode, probed: true },
        })),
      });
    }

    if (rateLimitedLinks.length > 0) {
      checks.push({
        name: "rate-limited-links",
        status: "info",
        message: `${rateLimitedLinks.length} internal link(s) rate-limited - status unverifiable`,
        items: rateLimitedLinks.map((b) => ({
          id: b.url,
          label: `${b.url} (${b.statusCode})`,
          sourcePages: b.sources,
          meta: { statusCode: b.statusCode, rateLimited: true },
        })),
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
 * an answer are untrusted when HEAD was unreliable, and unanswered otherwise.
 * For the ones it never asked about, its own counts say how far its eligible
 * targets ran past the limit and how many it skipped: past the limit up to
 * that excess, then skipped up to its count. Any left over (a target the
 * engine keyed differently, or a context without per-target statuses) is
 * counted as unanswered, the cause that claims least.
 */
function notFetchedCauses(
  unfetched: number,
  unanswered: number,
  probe: InternalLinkProbe | undefined,
): LinkTargetsNotFetched {
  if (!probe) return { off: unfetched };
  const notAsked = Math.max(0, unfetched - unanswered);
  const overLimit = Math.min(notAsked, Math.max(0, probe.unfetched - probe.cap));
  const skipped = Math.min(notAsked - overLimit, probe.outOfScope ?? 0);
  const noStatus = unanswered + (notAsked - overLimit - skipped);
  const causes: LinkTargetsNotFetched = {
    overLimit,
    skipped,
    ...(probe.headUnreliable ? { untrusted: noStatus } : { noAnswer: noStatus }),
  };
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
        return "the site answers status-only (HEAD) requests with errors on pages it serves, so the internal link checks could not be trusted";
      default:
        return "its internal link checks got no answer";
    }
  }
  const parts: string[] = [];
  if (causes.overLimit) {
    parts.push(
      cap === 0
        ? `${causes.overLimit} left out because internal_links.max_targets is 0`
        : `${causes.overLimit} past the limit of ${targets(cap)}`,
    );
  }
  if (causes.skipped) {
    parts.push(
      `${causes.skipped} skipped as outside the crawl scope, disallowed by robots.txt, or an action or token link`,
    );
  }
  if (causes.untrusted) {
    parts.push(
      `${causes.untrusted} not trusted, because the site answers HEAD requests with errors on pages it serves`,
    );
  }
  if (causes.noAnswer) parts.push(`${causes.noAnswer} with no answer`);
  return `its internal link checks covered only part of them (${parts.join("; ")})`;
}
