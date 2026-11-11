// i18n/hreflang-targets - where a page's hreflang links go
//
// i18n/hreflang judges the tags on one page. Search engines ignore an hreflang
// link whose target redirects, errors, is noindex or canonicalises elsewhere,
// or does not link back. This site rule judges each target the crawl already
// fetched, from the records it holds. It makes no request of its own, and a
// target the crawl did not fetch is counted as not checked, never passed or failed.

import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult, SiteData } from "../types";

import { normalizePageUrl } from "@squirrelscan/utils/url";

import { buildHreflangSignal, type HreflangPageSignal } from "./hreflang-signal";
import { didRedirect, documentUrl } from "../shared/redirect-evidence";

/** Items kept per check; the count in `value` is always the full total. */
const MAX_ITEMS = 200;

type SitePage = NonNullable<SiteData["pages"]>[number];

interface Finding {
  source: string;
  target: string;
  label: string;
}

/** What the crawl knows about one target URL. */
type Target =
  | { kind: "page"; page: SitePage; signal: HreflangPageSignal }
  | { kind: "fetched"; status: number }
  | { kind: "unchecked" };

function pageIdentities(page: SitePage): Set<string> {
  const ids = new Set<string>([normalizePageUrl(page.url), normalizePageUrl(documentUrl(page))]);
  if (page.finalUrl) ids.add(normalizePageUrl(page.finalUrl));
  return ids;
}

function cap(findings: Finding[]): { items: CheckItem[]; omitted: number } {
  const items = findings.slice(0, MAX_ITEMS).map((f) => ({
    id: `${f.source} -> ${f.target}`,
    label: f.label,
    sourcePages: [f.source],
  }));
  return { items, omitted: findings.length - items.length };
}

function issueCheck(
  name: string,
  status: "warn" | "fail",
  noun: string,
  findings: Finding[],
  passMessage: string,
  checkedTargets: number,
): CheckResult {
  if (findings.length === 0) {
    return { name, status: "pass", message: passMessage, value: 0, details: { checkedTargets } };
  }
  const { items, omitted } = cap(findings);
  return {
    name,
    status,
    message: `${findings.length} hreflang link(s) ${noun}`,
    value: findings.length,
    items,
    details: { checkedTargets, ...(omitted > 0 ? { omittedItems: omitted } : {}) },
  };
}

export const hreflangTargetsRule: Rule = {
  meta: {
    id: "i18n/hreflang-targets",
    name: "Hreflang Targets",
    description:
      "Checks that hreflang links point at pages that answer 200, are indexable and canonical to themselves, and link back",
    solution:
      "Search engines ignore an hreflang link whose target redirects, returns an error, is noindex, declares another canonical, or does not link back to the page that named it. Point each hreflang link at the final, canonical, indexable URL of that language version, and make every version list every other version including itself. Generate the set from one source so the pairs cannot drift apart.",
    category: "i18n",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const pages = ctx.site?.pages ?? [];
    const collected = new Map((ctx.collectedSignals?.pages ?? []).map((r) => [r.url, r.hreflang]));
    const signalOf = (page: SitePage): HreflangPageSignal =>
      collected.get(page.url) ?? buildHreflangSignal(page.parsed, page.headers, page.url);

    // Every page the crawl holds, by the URL the crawl requested. Sorted so the
    // first claimant of an identity does not depend on crawl order.
    const sorted = [...pages].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    const byIdentity = new Map<string, Target>();
    for (const page of sorted) {
      const target: Target = page.parsed
        ? { kind: "page", page, signal: signalOf(page) }
        : { kind: "unchecked" };
      const own = normalizePageUrl(page.url);
      if (!byIdentity.has(own)) byIdentity.set(own, target);
    }
    // A page's final URL is not an identity of that page: a link naming the
    // destination of a redirect is a link to the destination, which is itself
    // the final URL. Left unmapped it is "not checked" unless crawled or fetched.
    for (const fetched of ctx.site?.fetchedTargets ?? []) {
      const id = normalizePageUrl(fetched.url);
      if (byIdentity.has(id)) continue;
      byIdentity.set(
        id,
        fetched.rateLimited || fetched.wafChallenge
          ? { kind: "unchecked" }
          : { kind: "fetched", status: fetched.status },
      );
    }

    const redirects: Finding[] = [];
    const broken: Finding[] = [];
    const nonIndexable: Finding[] = [];
    const noReturn: Finding[] = [];
    const notChecked = new Set<string>();
    // Targets the crawl held a response for: every check sees the same set.
    const checked = new Set<string>();
    let linkCount = 0;

    for (const source of sorted) {
      if (!source.parsed || source.statusCode >= 400) continue;
      const alternates = signalOf(source).alternates;
      if (alternates.length === 0) continue;
      const sourceIds = pageIdentities(source);
      const seenPairs = new Set<string>();

      for (const alt of alternates) {
        const targetId = normalizePageUrl(alt.href);
        // A page naming itself is the self reference i18n/hreflang judges.
        if (sourceIds.has(targetId) || seenPairs.has(targetId)) continue;
        seenPairs.add(targetId);
        linkCount++;

        const target = byIdentity.get(targetId) ?? ({ kind: "unchecked" } as Target);

        if (target.kind === "unchecked") {
          notChecked.add(alt.href);
          continue;
        }
        if (target.kind === "fetched") {
          if (target.status >= 300 && target.status < 400) {
            checked.add(alt.href);
            redirects.push({
              source: source.url,
              target: alt.href,
              label: `${source.url} links ${alt.href} (${alt.hreflang}), which redirects (${target.status})`,
            });
          } else {
            // A non-HTML 2xx has no markup to judge for the other checks.
            notChecked.add(alt.href);
          }
          continue;
        }

        const { page, signal } = target;
        checked.add(alt.href);
        if (page.statusCode >= 400) {
          broken.push({
            source: source.url,
            target: alt.href,
            label: `${source.url} links ${alt.href} (${alt.hreflang}), which returns ${page.statusCode}`,
          });
          continue;
        }
        if (page.statusCode >= 300 || didRedirect(page.url, page.finalUrl, page.redirectChain)) {
          const finalUrl = page.redirectChain?.finalUrl ?? page.finalUrl;
          redirects.push({
            source: source.url,
            target: alt.href,
            label: `${source.url} links ${alt.href} (${alt.hreflang}), which redirects${finalUrl ? ` to ${finalUrl}` : ""}`,
          });
          // A redirected target's stored markup is its destination's: the rest is not judged.
          continue;
        }
        // Why a search engine would drop this target from the index.
        const reasons: string[] = [];
        if (signal.noindex) reasons.push(`noindex (${signal.noindex})`);
        if (signal.canonical && !pageIdentities(page).has(normalizePageUrl(signal.canonical))) {
          reasons.push(`canonical is ${signal.canonical}`);
        }
        if (reasons.length > 0) {
          nonIndexable.push({
            source: source.url,
            target: alt.href,
            label: `${source.url} links ${alt.href} (${alt.hreflang}), which is not indexable: ${reasons.join(", ")}`,
          });
        }

        // The target names other versions but not this page.
        if (signal.alternates.length > 0) {
          const returns = signal.alternates.some((back) =>
            sourceIds.has(normalizePageUrl(back.href)),
          );
          if (!returns) {
            noReturn.push({
              source: source.url,
              target: alt.href,
              label: `${source.url} links ${alt.href} (${alt.hreflang}), but ${alt.href} has hreflang links and none back to ${source.url}`,
            });
          }
        }
      }
    }

    if (linkCount === 0) {
      return {
        checks: [
          {
            name: "hreflang-targets",
            status: "skipped",
            message: "No hreflang links to other pages were found in the crawl",
            skipReason: "No hreflang links",
          },
        ],
      };
    }

    const checks: CheckResult[] = [
      issueCheck(
        "hreflang-to-redirect",
        "warn",
        "point at a URL that redirects",
        redirects,
        "No hreflang link points at a redirect",
        checked.size,
      ),
      issueCheck(
        "hreflang-to-broken",
        "fail",
        "point at a URL that returns an error",
        broken,
        "No hreflang link points at a 4xx or 5xx page",
        checked.size,
      ),
      issueCheck(
        "hreflang-to-non-indexable",
        "warn",
        "point at a page search engines will not index",
        nonIndexable,
        "Every checked hreflang target is indexable and canonical to itself",
        checked.size,
      ),
      issueCheck(
        "hreflang-no-return-link",
        "fail",
        "have no return link from the target",
        noReturn,
        "Every checked hreflang target links back",
        checked.size,
      ),
    ];

    if (notChecked.size > 0) {
      const list = [...notChecked].sort();
      checks.push({
        name: "hreflang-not-checked",
        status: "info",
        message: `${list.length} hreflang target(s) were not checked: the crawl did not fetch them, or they have no page markup to judge`,
        value: list.length,
        items: list.slice(0, MAX_ITEMS).map((url) => ({ id: url })),
        ...(list.length > MAX_ITEMS ? { details: { omittedItems: list.length - MAX_ITEMS } } : {}),
      });
    }

    return { checks };
  },
};
