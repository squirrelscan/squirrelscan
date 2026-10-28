// links/broken-external-links - Broken external link detection
// Uses cached check results from external link checker

import {
  EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
  EXTERNAL_LINKS_OUT_OF_TIME_SKIP_REASON,
  EXTERNAL_LINKS_OVER_CAP_SKIP_REASON,
  type CheckItemSource,
  type LinkSection,
} from "@squirrelscan/core-contracts";
import { maskLinkTokens } from "@squirrelscan/utils/link-actions";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";

import type { Rule, RuleContext, RuleResult, CheckResult, SiteData } from "../types";

import {
  regionsField,
  sectionMeta,
  tallyFields,
  tallySource,
  withSection,
  type SectionCounts,
  type SourceTally,
} from "./link-section-label";

/**
 * A link the origin refused to answer because it was throttling us (#1829).
 *
 * `rateLimited` is the persisted verdict from the checker (it alone can see a
 * 503's `Retry-After`); the status test is the belt-and-braces path for rows
 * written before the column existed, and for a cloud bulk result that carried
 * only a status.
 */
function isRateLimitedLink(link: { status: number | null; rateLimited?: boolean }): boolean {
  return link.rateLimited === true || isRateLimitStatus(link.status);
}

/**
 * Distinct external http(s) hrefs on the audited pages, checked or not. Skips
 * the parser's unparseable-href entries, as the link checker never sees them.
 */
function countExternalLinks(pages: SiteData["pages"] | undefined): number {
  const hrefs = new Set<string>();
  for (const page of pages ?? []) {
    for (const link of page.parsed?.links ?? []) {
      if (!link.isInternal && link.url && !link.error && /^https?:/i.test(link.url)) {
        hrefs.add(link.url);
      }
    }
  }
  return hrefs.size;
}

/** Where a reported external link sits on the audited pages (#2307, pub#837). */
interface ExternalPlacement {
  /** Sections of every link to it, or undefined when none had a known section. */
  sections(href: string): SectionCounts | undefined;
  /** Per page of `sourcePages` the audited pages show: its links to `href` and their sections. */
  sources(href: string, sourcePages: readonly string[]): CheckItemSource[] | undefined;
  /** Audited pages linking it, per section (pub#846), or undefined when none placed it. */
  regions(href: string): SectionCounts | undefined;
}

/**
 * Where on the audited pages each of `wanted` is linked from, by the link's resolved URL. One
 * pass over the pages' parsed links, and only the wanted URLs are kept. `wantedMasked` are the
 * hrefs the engine reports with token-like values masked (links never requested): a parsed link
 * is matched to them by its own masked form, so the credential itself is never kept or printed.
 * A crawl whose links carry no section yields no sections, and the labels stay as they were.
 */
function externalPlacement(
  pages: SiteData["pages"] | undefined,
  wanted: ReadonlySet<string>,
  wantedMasked: ReadonlySet<string>
): ExternalPlacement {
  const byHref = new Map<string, SourceTally>();
  const count = (key: string, page: string, section: LinkSection | undefined): void => {
    let tally = byHref.get(key);
    if (!tally) byHref.set(key, (tally = new Map()));
    tallySource(tally, page, section);
  };
  if (wanted.size > 0 || wantedMasked.size > 0) {
    // Distinct URLs are far fewer than links, and masking parses the URL.
    const masked = new Map<string, string>();
    for (const page of pages ?? []) {
      for (const link of page.parsed?.links ?? []) {
        if (link.isInternal || !link.url) continue;
        if (wanted.has(link.url)) count(link.url, page.url, link.section);
        if (wantedMasked.size === 0) continue;
        let key = masked.get(link.url);
        if (key === undefined) masked.set(link.url, (key = maskLinkTokens(link.url)));
        // A link written without a token masks to itself and was counted above.
        if (key !== link.url && wantedMasked.has(key)) count(key, page.url, link.section);
      }
    }
  }
  const fieldsOf = (href: string) => {
    const tally = byHref.get(href);
    return tally ? tallyFields(tally) : undefined;
  };
  return {
    sections(href) {
      const sections = fieldsOf(href)?.sections;
      return sections && Object.keys(sections).length > 0 ? sections : undefined;
    },
    sources(href, sourcePages) {
      const all = fieldsOf(href)?.sources;
      if (!all) return undefined;
      const listed = new Set(sourcePages);
      const kept = all.filter((source) => listed.has(source.page));
      return kept.length > 0 ? kept : undefined;
    },
    regions(href) {
      const regions = fieldsOf(href)?.regions;
      return regions && Object.keys(regions).length > 0 ? regions : undefined;
    },
  };
}

/** An item's `label`, `meta.sections` and `sources`, or nothing the links do not say. */
function placementItemFields(
  href: string,
  sourcePages: readonly string[],
  placement: ExternalPlacement
): {
  label?: string;
  meta?: { sections: SectionCounts };
  sources?: CheckItemSource[];
  regions?: SectionCounts;
} {
  const sections = placement.sections(href);
  const sources = placement.sources(href, sourcePages);
  return {
    ...(sections ? { label: withSection(href, sections), meta: { sections } } : {}),
    ...(sources ? { sources } : {}),
    ...regionsField(placement.regions(href)),
  };
}

function notChecked(message: string, found: number): CheckResult {
  return {
    name: "broken-external-links",
    status: "skipped",
    message,
    skipReason: EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
    value: found,
    details: { externalLinksFound: found },
  };
}

/**
 * repo#2759: external links the checker never requested because they look
 * like an action (log out, unsubscribe, delete) or carry a token or signature
 * in the URL, where the request itself could act on the credential. Neither a
 * finding nor a pass: their status is simply unknown, and they are listed so
 * the reader can check them by hand. Info, not a "not checked" skip, which
 * would hold this rule's open issues open on every site with a permanent
 * unsubscribe link.
 */
function notRequestedCheck(
  linkCheck: NonNullable<SiteData["externalLinkCheck"]>,
  placement: ExternalPlacement,
): CheckResult | null {
  const count = linkCheck.notRequested ?? 0;
  if (count === 0) return null;
  const sample = linkCheck.notRequestedLinks ?? [];
  return {
    name: "not-requested-external-links",
    status: "info",
    message: `${count} external link(s) were not requested because they look like actions (log out, unsubscribe) or carry a token or signature in the URL, so their status was not checked`,
    value: count,
    // `href` arrives with its token-like values masked by the engine.
    items: sample.map((l) => ({
      id: l.href,
      sourcePages: l.sourcePages,
      ...(l.pageCount !== undefined && l.pageCount > l.sourcePages.length
        ? { pageCount: l.pageCount }
        : {}),
      ...placementItemFields(l.href, l.sourcePages, placement),
    })),
    details: {
      notRequested: count,
      ...(sample.length < count ? { listed: sample.length } : {}),
    },
  };
}

/**
 * pub#770: external links never requested because the egress policy refuses
 * their address: a private, loopback, link-local or cloud metadata one named
 * on a public site's page. Their status is unknown, so they are neither broken
 * nor working; listed (masked) so the reader can see what the page points at.
 */
function refusedCheck(
  linkCheck: NonNullable<SiteData["externalLinkCheck"]>,
  placement: ExternalPlacement,
): CheckResult | null {
  const count = linkCheck.refused ?? 0;
  if (count === 0) return null;
  const sample = linkCheck.refusedLinks ?? [];
  return {
    name: "refused-external-links",
    status: "info",
    message: `${count} external link(s) point at a private, link-local or cloud metadata address, or a name public DNS does not resolve, so they were not requested and their status was not checked`,
    value: count,
    items: sample.map((l) => ({
      id: l.href,
      sourcePages: l.sourcePages,
      ...(l.pageCount !== undefined && l.pageCount > l.sourcePages.length
        ? { pageCount: l.pageCount }
        : {}),
      ...placementItemFields(l.href, l.sourcePages, placement),
    })),
    details: {
      refused: count,
      ...(sample.length < count ? { listed: sample.length } : {}),
    },
  };
}

/**
 * repo#2729: links over this audit's limit were never requested. Said next to
 * the result for the ones that were. The ones never requested as actions or
 * token links (repo#2759), or refused on their URL alone, never took a slot
 * under the limit, so they are not over it.
 */
function overCapCheck(linkCheck: NonNullable<SiteData["externalLinkCheck"]>): CheckResult | null {
  const eligible = linkCheck.found - (linkCheck.notRequested ?? 0) - (linkCheck.refusedByUrl ?? 0);
  const overCap = eligible - linkCheck.checked;
  if (overCap <= 0) return null;
  return {
    name: "broken-external-links",
    status: "skipped",
    message: `${overCap} of ${eligible} external link(s) were not checked: over this audit's limit of ${linkCheck.cap}, which checks the most-linked first`,
    skipReason: EXTERNAL_LINKS_OVER_CAP_SKIP_REASON,
    value: overCap,
    details: { externalLinksFound: linkCheck.found, externalLinksChecked: linkCheck.checked, cap: linkCheck.cap },
  };
}

/**
 * repo#2613: external links the audit selected to check but got no answer for
 * before the check's time budget ran out. A "not checked" skip, like the links
 * over the limit: their status is unknown, so they hold this rule's open
 * issues open rather than resolving them.
 */
function outOfTimeCheck(linkCheck: NonNullable<SiteData["externalLinkCheck"]>): CheckResult | null {
  const count = linkCheck.outOfTime ?? 0;
  if (count === 0) return null;
  return {
    name: "broken-external-links",
    status: "skipped",
    message: `${count} of ${linkCheck.checked} external link(s) were not checked: the link check ran out of time before reaching them`,
    skipReason: EXTERNAL_LINKS_OUT_OF_TIME_SKIP_REASON,
    value: count,
    details: { externalLinksChecked: linkCheck.checked, outOfTime: count },
  };
}

export const brokenExternalLinksRule: Rule = {
  meta: {
    id: "links/broken-external-links",
    name: "Broken External Links",
    description: "Detects external links returning 4xx/5xx errors or timeouts",
    solution:
      "Broken external links hurt user experience and credibility. Regularly audit external links using automated tools. Remove or replace broken links with working alternatives. Consider using archived versions (archive.org) if the original content is gone. For important resources, consider hosting your own copies of critical documentation or linking to more stable sources.",
    // pub#836/#843: a dead link is a reliability problem, scored under
    // Performance; the id keeps its `links/` prefix so configs keep working.
    category: "reliability",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const externalLinks = ctx.site?.externalLinks;

    // repo#2729: undefined means external link checking did not run (Quick,
    // --offline, external_links off, switched off for the run). That is not
    // "no external links": the pass it used to be read as healthy and resolved
    // open issues.
    if (externalLinks === undefined) {
      const found = countExternalLinks(ctx.site?.pages);
      checks.push(
        notChecked(
          found > 0
            ? `External link checking was off for this audit, so ${found} external link(s) on the audited pages were not checked`
            : "External link checking was off for this audit, so external links were not checked",
          found,
        ),
      );
      return { checks };
    }

    const linkCheck = ctx.site?.externalLinkCheck;
    // #2307, pub#837: where each reported link sits. The URLs are collected first so the pages are walked
    // once, and only for links that end up in an item.
    const wanted = new Set<string>();
    const wantedMasked = new Set<string>();
    // Reported masked when a token-like value was found, as written when not: both forms.
    for (const l of [...(linkCheck?.notRequestedLinks ?? []), ...(linkCheck?.refusedLinks ?? [])]) {
      wanted.add(l.href);
      wantedMasked.add(l.href);
    }
    for (const l of externalLinks) {
      if (l.error || l.wafBlocked || isRateLimitedLink(l) || (l.status ?? 0) >= 400) wanted.add(l.href);
    }
    const placement = externalPlacement(ctx.site?.pages, wanted, wantedMasked);
    const notRequested = linkCheck ? notRequestedCheck(linkCheck, placement) : null;
    const refused = linkCheck ? refusedCheck(linkCheck, placement) : null;

    if (externalLinks.length === 0) {
      // Every external link was one the checker never requests, as an action
      // or token link (repo#2759) or for its address (pub#770): say that, and
      // nothing about the rest, of which there are none.
      const neverRequested = (linkCheck?.notRequested ?? 0) + (linkCheck?.refused ?? 0);
      if ((notRequested || refused) && linkCheck && neverRequested >= linkCheck.found) {
        if (notRequested) checks.push(notRequested);
        if (refused) checks.push(refused);
        return { checks };
      }
      if (notRequested) checks.push(notRequested);
      if (refused) checks.push(refused);
      // repo#2613: the check ran out of time before answering any of them. Say
      // that, rather than the generic "no results" below, which reads as a
      // check that never ran.
      const outOfTime = linkCheck ? outOfTimeCheck(linkCheck) : null;
      if (outOfTime) {
        checks.push(outOfTime);
        const overCap = linkCheck ? overCapCheck(linkCheck) : null;
        if (overCap) checks.push(overCap);
        return { checks };
      }
      // No check results while the pages do link out: the checker never saw
      // them (rules re-run on a stored crawl by `squirrel analyze`, a check
      // phase that died early). Not a pass. The links never requested are
      // reported above, not counted here.
      const found = Math.max(
        0,
        countExternalLinks(ctx.site?.pages) - (linkCheck?.notRequested ?? 0) - (linkCheck?.refused ?? 0),
      );
      if (found > 0) {
        checks.push(
          notChecked(
            `No external link check results for the ${found} external link(s) on the audited pages, so they were not checked`,
            found,
          ),
        );
        return { checks };
      }
      checks.push({
        name: "broken-external-links",
        status: "pass",
        message: "No external links found to check",
        value: 0,
      });
      return { checks };
    }

    // Find broken external links (4xx, 5xx, or errors)
    // Excludes unverifiable and rate-limited targets, neither of which is
    // evidence the link is dead.
    const brokenLinks = externalLinks.filter((link) => {
      if (link.error) return true;
      // A bot or sign-in wall, whatever its status, or a timeout: not truly
      // broken, just not verifiable from where it was checked (pub#800).
      if (link.wafBlocked) return false;
      // #1829: 429/430 (and a Retry-After 503) mean the host throttled US. The
      // link's real status is unknown, so it is reported below as info rather
      // than counted here. Must precede the >= 400 test, which they satisfy.
      if (isRateLimitedLink(link)) return false;
      if (link.status && link.status >= 400) return true;
      return false;
    });

    // Links nobody could verify either way (status unverifiable)
    const wafBlockedLinks = externalLinks.filter((link) => link.wafBlocked);

    // Same bucket, different cause: throttled targets (#1829).
    const rateLimitedLinks = externalLinks.filter((link) => isRateLimitedLink(link));

    const checkedCount = externalLinks.filter(
      (l) => l.status !== null || l.error !== null
    ).length;

    if (brokenLinks.length === 0 && checkedCount === 0) {
      // Every link is still unresolved: "All 0 external link(s) are working"
      // would be a pass on nothing.
      checks.push(
        notChecked(
          `None of the ${externalLinks.length} external link(s) could be checked this audit`,
          externalLinks.length,
        ),
      );
    } else if (brokenLinks.length === 0) {
      checks.push({
        name: "broken-external-links",
        status: "pass",
        message: `All ${checkedCount} external link(s) are working`,
      });
    } else {
      // Group by status code for better reporting
      const byStatus = new Map<string, typeof brokenLinks>();
      for (const link of brokenLinks) {
        const key = link.error ? "error" : String(link.status);
        const group = byStatus.get(key) ?? [];
        group.push(link);
        byStatus.set(key, group);
      }

      // Create a summary of broken links
      const summaryParts: string[] = [];
      for (const [status, links] of byStatus) {
        if (status === "error") {
          summaryParts.push(`${links.length} failed`);
        } else {
          summaryParts.push(`${links.length} with ${status}`);
        }
      }

      checks.push({
        name: "broken-external-links",
        status: "warn",
        message: `${brokenLinks.length} broken external link(s): ${summaryParts.join(", ")}`,
        items: brokenLinks.map((l) => {
          const sections = placement.sections(l.href);
          const sources = placement.sources(l.href, l.sourcePages);
          return {
            id: l.href,
            label: withSection(
              l.error ? `${l.href} (Error: ${l.error})` : `${l.href} (${l.status})`,
              sections,
            ),
            sourcePages: l.sourcePages,
            ...(sources ? { sources } : {}),
            ...regionsField(placement.regions(l.href)),
            meta: { status: l.status, error: l.error, ...sectionMeta(sections) },
          };
        }),
        details: {
          totalBroken: brokenLinks.length,
          totalChecked: checkedCount,
        },
      });
    }

    // repo#2613 first: a report shows one "Not checked" line per rule, and a
    // check that ran out of time is the news; the limit is the same every run.
    const outOfTime = linkCheck ? outOfTimeCheck(linkCheck) : null;
    if (outOfTime) checks.push(outOfTime);
    const overCap = linkCheck ? overCapCheck(linkCheck) : null;
    if (overCap) checks.push(overCap);

    if (notRequested) checks.push(notRequested);
    if (refused) checks.push(refused);

    // Report unverifiable links as info, not broken. Not all of them met a
    // firewall: a timeout, a CDN origin error or a first 404 still waiting for
    // its confirming check land here too (pub#783), so the message says
    // unverifiable and the label names a vendor only when one was identified.
    // pub#821: a first 404 awaiting its confirming check is a likely-broken
    // link rather than a blocked one, and its label says so.
    if (wafBlockedLinks.length > 0) {
      checks.push({
        name: "waf-blocked-external-links",
        status: "info",
        message: `${wafBlockedLinks.length} external link(s) could not be verified - status unverifiable`,
        items: wafBlockedLinks.map((l) => {
          const sections = placement.sections(l.href);
          const sources = placement.sources(l.href, l.sourcePages);
          return {
            id: l.href,
            label: withSection(
              l.unverifiedReason === "awaiting-confirmation"
                ? `${l.href} (unverified: awaiting confirmation)`
                : l.wafProvider && l.wafProvider !== "unknown"
                  ? `${l.href} (unverified: ${l.wafProvider})`
                  : `${l.href} (unverified)`,
              sections,
            ),
            sourcePages: l.sourcePages,
            ...(sources ? { sources } : {}),
            ...regionsField(placement.regions(l.href)),
            meta: l.unverifiedReason
              ? { wafProvider: l.wafProvider, unverifiedReason: l.unverifiedReason, ...sectionMeta(sections) }
              : { wafProvider: l.wafProvider, ...sectionMeta(sections) },
          };
        }),
      });
    }

    // Report rate-limited links as info (not broken, just unverifiable),
    // mirroring the unverifiable bucket above (#1829).
    if (rateLimitedLinks.length > 0) {
      checks.push({
        name: "rate-limited-external-links",
        status: "info",
        message: `${rateLimitedLinks.length} external link(s) rate-limited - status unverifiable`,
        items: rateLimitedLinks.map((l) => {
          const sections = placement.sections(l.href);
          const sources = placement.sources(l.href, l.sourcePages);
          return {
            id: l.href,
            label: withSection(`${l.href} (${l.status ?? "rate limited"})`, sections),
            sourcePages: l.sourcePages,
            ...(sources ? { sources } : {}),
            ...regionsField(placement.regions(l.href)),
            meta: { status: l.status, rateLimited: true, ...sectionMeta(sections) },
          };
        }),
      });
    }

    return { checks };
  },
};
