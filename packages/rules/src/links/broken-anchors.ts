// links/broken-anchors - links to #fragments whose target id does not exist.
//
// A link to `#pricing` whose element is gone still loads: the reader lands at the
// top of the page instead of the section. The check covers same-page links and
// links into another crawled page. Each target's ids come from the anchor record
// (page-anchors.ts): the streaming engine collects it page-time while the DOM is
// live, and the v1 path builds it from the DOM, so both engines judge the same
// records. Findings are one per target URL and fragment, listing every page that
// links to it.

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";
import type { PageAnchorSignal } from "./page-anchors";

import { normalizeUrl } from "@squirrelscan/utils";

import { buildPageAnchorSignal, decodeFragment, isJudgeableFragment } from "./page-anchors";

interface AnchorGroup {
  /** The first link seen to this target and fragment, as written (absolute). */
  url: string;
  /** Pages that link to it, in first-seen order. A Set: a site-wide nav link
   * repeats on every page, and an array scan per link is quadratic. */
  sources: Set<string>;
  skipLink: boolean;
  /** The target is an unrendered client-side shell: the id may come from JavaScript. */
  unconfirmed: boolean;
}

type SitePage = NonNullable<RuleContext["site"]>["pages"][number];

const stripHash = (url: string): string => {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
};

/**
 * The anchor record for each page, by normalized URL. From the streaming
 * collector when present; otherwise built from the page's DOM on demand.
 */
function anchorLookup(
  ctx: RuleContext,
  pages: SitePage[],
): (key: string) => PageAnchorSignal | null {
  if (ctx.collectedSignals) {
    const byKey = new Map<string, PageAnchorSignal | null>();
    for (const rec of ctx.collectedSignals.pages) {
      byKey.set(normalizeUrl(rec.url), rec.anchors ?? null);
    }
    return (key) => byKey.get(key) ?? null;
  }
  const pageByKey = new Map<string, SitePage>();
  for (const page of pages) pageByKey.set(normalizeUrl(page.url), page);
  const built = new Map<string, PageAnchorSignal | null>();
  return (key) => {
    if (built.has(key)) return built.get(key) ?? null;
    const page = pageByKey.get(key);
    const signal = page
      ? buildPageAnchorSignal({
          parsed: page.parsed,
          rendered: page.rendered === true,
        })
      : null;
    built.set(key, signal);
    return signal;
  };
}

export const brokenAnchorsRule: Rule = {
  meta: {
    id: "links/broken-anchors",
    name: "Broken Anchor Links",
    description:
      "Detects links to #fragments whose target id does not exist on the page they point at",
    solution:
      "A link to #id jumps to the element with that id. When the element is renamed or removed, the link still loads and the reader lands at the top of the page instead of the section. Update the link to the id that exists now, or add the id to the target element. Skip links need a target too: give <main> or the content container the id the skip link points at.",
    // pub#836/#843: a dead link is a reliability problem, scored under
    // Performance; the id keeps its `links/` prefix so configs keep working.
    category: "reliability",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const pages = ctx.site?.pages;
    if (!pages) {
      return {
        checks: [
          {
            name: "broken-anchors",
            status: "skipped",
            message: "Site data not available for in-page anchor analysis",
          },
        ],
      };
    }

    // A streaming snapshot cached before the anchor record existed has no
    // `anchors` field on any page: nothing was measured, so say so rather than
    // pass with zero links judged.
    if (
      ctx.collectedSignals &&
      ctx.collectedSignals.pages.length > 0 &&
      ctx.collectedSignals.pages.every((rec) => rec.anchors === undefined)
    ) {
      return {
        checks: [
          {
            name: "broken-anchors",
            status: "skipped",
            message:
              "In-page anchors were not checked: this crawl's page records predate the check. Re-run the audit with --refresh to check them",
          },
        ],
      };
    }

    const anchorsOf = anchorLookup(ctx, pages);
    const statusByKey = new Map<string, number>();
    for (const page of pages) statusByKey.set(normalizeUrl(page.url), page.statusCode);

    // Membership sets built once per target record, not once per link.
    const idSets = new Map<PageAnchorSignal, Set<string>>();
    const idSetOf = (rec: PageAnchorSignal): Set<string> => {
      let set = idSets.get(rec);
      if (!set) {
        set = new Set(rec.ids);
        idSets.set(rec, set);
      }
      return set;
    };

    const groups = new Map<string, AnchorGroup>();
    let judged = 0;

    // One link to a fragment: judge it against the target page's record and
    // fold it into the finding for that target and fragment.
    const judge = (link: {
      targetKey: string;
      fragment: string;
      url: string;
      sourceUrl: string;
      targetRecord: PageAnchorSignal | null;
      sourceRecord: PageAnchorSignal | null;
    }): void => {
      if (!isJudgeableFragment(link.fragment)) return;
      // No record: nothing to judge against (no document, failed parse, error page).
      if (!link.targetRecord) return;
      judged++;

      if (idSetOf(link.targetRecord).has(link.fragment)) return;
      // The target has more ids than were kept, so this one may exist.
      if (link.targetRecord.idsTruncated) return;

      const groupKey = `${link.targetKey}#${link.fragment}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          url: link.url,
          sources: new Set(),
          skipLink: false,
          unconfirmed: link.targetRecord.clientShell,
        };
        groups.set(groupKey, group);
      }
      group.sources.add(link.sourceUrl);
      if (link.sourceRecord?.skipFragments.includes(link.fragment)) group.skipLink = true;
    };

    for (const page of pages) {
      const sourceKey = normalizeUrl(page.url);
      // A page that redirected is stored under the URL that was requested, but
      // its own links are written relative to where it landed: a link to the
      // final URL plus a fragment is a same-page link, judged against this
      // page's record and grouped under the requested URL.
      const finalKey = page.finalUrl ? normalizeUrl(page.finalUrl) : null;
      const ownRecord = anchorsOf(sourceKey);

      // Same-page links, from the DOM record. The parser keeps `#x` hrefs out of
      // parsed.links, so this is the only place they are seen.
      for (const fragment of ownRecord?.selfFragments ?? []) {
        judge({
          targetKey: sourceKey,
          fragment,
          url: `${stripHash(page.url)}#${fragment}`,
          sourceUrl: page.url,
          targetRecord: ownRecord,
          sourceRecord: ownRecord,
        });
      }

      // Links the parser kept: to another page, or to this page by its path.
      for (const link of page.parsed?.links ?? []) {
        if (!link.isInternal || !link.url) continue;
        const hash = link.url.indexOf("#");
        if (hash < 0) continue;
        const fragment = decodeFragment(link.url.slice(hash + 1));
        const targetKey = normalizeUrl(link.url.slice(0, hash));

        if (targetKey === sourceKey || targetKey === finalKey) {
          judge({
            targetKey: sourceKey,
            fragment,
            url: link.url,
            sourceUrl: page.url,
            targetRecord: ownRecord,
            sourceRecord: ownRecord,
          });
          continue;
        }

        // Another page is judged only when the crawl fetched it and it answered
        // without an error: a 4xx/5xx or an unfetched target is broken-links' call.
        const status = statusByKey.get(targetKey);
        if (status === undefined || status >= 400) continue;
        judge({
          targetKey,
          fragment,
          url: link.url,
          sourceUrl: page.url,
          targetRecord: anchorsOf(targetKey),
          sourceRecord: ownRecord,
        });
      }
    }

    const broken = [...groups.values()].filter((g) => !g.unconfirmed);
    const unconfirmed = [...groups.values()].filter((g) => g.unconfirmed);
    const checks: CheckResult[] = [];

    if (broken.length > 0) {
      checks.push({
        name: "broken-anchors",
        status: "warn",
        message: `${broken.length} in-page anchor link(s) point at an id that does not exist on the target page`,
        items: broken.map((g) => ({
          id: g.url,
          label: `${g.url}${g.skipLink ? " (skip link)" : ""}`,
          sourcePages: [...g.sources],
          meta: { skipLink: g.skipLink, linkedFrom: g.sources.size },
        })),
      });
    } else {
      checks.push({
        name: "broken-anchors",
        status: "pass",
        message: "No broken in-page anchor links detected",
        details: { anchorLinks: judged },
      });
    }

    if (unconfirmed.length > 0) {
      checks.push({
        name: "unconfirmed-anchors",
        status: "info",
        message: `${unconfirmed.length} in-page anchor link(s) target a client-rendered page that was not rendered, so the id may be added by JavaScript`,
        items: unconfirmed.map((g) => ({
          id: g.url,
          label: g.url,
          sourcePages: [...g.sources],
          meta: { linkedFrom: g.sources.size, rendered: false },
        })),
      });
    }

    return { checks };
  },
};
